// server.js
// 功能：商品、訂單、補貨、圖片上傳（Cloudinary）、SSE 即時訂單

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');
const multer = require('multer');
const streamifier = require('streamifier');
const path = require('path');

// Cloudinary
const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ====== 建立 Express ======
const app = express();
const PORT = process.env.PORT || 3000;

// ====== 中介層 ======
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'sessionSecret',
    resave: false,
    saveUninitialized: true,
  })
);

// Multer 使用記憶體（交給 Cloudinary）
const upload = multer({ storage: multer.memoryStorage() });

// ====== Mongo 連線 ======
if (!process.env.MONGO_URI) {
  console.error('❌ 沒讀到 MONGO_URI，請檢查 .env');
  process.exit(1);
}

mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log('✅ MongoDB 已連線'))
  .catch((err) => {
    console.error('❌ MongoDB 連線失敗：', err.message);
    process.exit(1);
  });

/* ===================== MongoDB Schema ===================== */
const ProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    stock: { type: Number, required: true, min: 0 },
    image: { type: String, default: '' }, // Cloudinary URL
    tags: [String],
  },
  { timestamps: true }
);

const OrderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const OrderSchema = new mongoose.Schema(
  {
    orderNumber: Number, // 當日序號（跨日歸零）
    orderDate: String,   // YYYY-MM-DD
    name: String,
    phone: String,
    address: String,
    pickupDate: String,
    note: String,
    items: [OrderItemSchema],
    total: Number,
    completed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const CounterSchema = new mongoose.Schema({
  key: { type: String, unique: true }, // 固定 'order'
  date: String, // YYYY-MM-DD
  seq: Number,
});

const RestockSchema = new mongoose.Schema(
  {
    time: String,
    name: String,
    quantity: Number,
  },
  { timestamps: true }
);

const Product = mongoose.model('Product', ProductSchema);
const Order = mongoose.model('Order', OrderSchema);
const Counter = mongoose.model('Counter', CounterSchema);
const Restock = mongoose.model('Restock', RestockSchema);

/* ===================== 工具函式 ===================== */
function toFullUrl(req, imageUrl) {
  if (!imageUrl) return '';
  if (/^https?:\/\//i.test(imageUrl)) return imageUrl;
  return `${req.protocol}://${req.get('host')}/${imageUrl}`;
}

function cloudinaryUploadBuffer(buffer, folder = 'order-system') {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

// 每日訂單序號（00:00歸零）
async function nextOrderNumber() {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  let c = await Counter.findOne({ key: 'order' });
  if (!c) {
    c = await Counter.create({ key: 'order', date: today, seq: 1 });
    return { date: today, seq: 1 };
  }
  if (c.date !== today) {
    c.date = today;
    c.seq = 1;
  } else {
    c.seq += 1;
  }
  await c.save();
  return { date: c.date, seq: c.seq };
}

/* ===================== SSE（即時訂單） ===================== */
const sseClients = new Set();
function pushOrderToAdmins(orderDoc, req) {
  const itemsDetailed = (orderDoc.items || []).map((it) => {
    const p = (orderDoc._populatedItems || []).find(
      (pp) => String(pp._id) === String(it.productId)
    );
    return {
      productId: it.productId,
      quantity: it.quantity,
      name: p?.name || '',
      price: p?.price || 0,
      image: toFullUrl(req, p?.image || ''),
    };
  });

  const payload = JSON.stringify({
    id: orderDoc._id,
    orderNumber: orderDoc.orderNumber,
    total: orderDoc.total,
    name: orderDoc.name,
    phone: orderDoc.phone,
    address: orderDoc.address,
    pickupDate: orderDoc.pickupDate,
    note: orderDoc.note,
    createdAt: orderDoc.createdAt,
    completed: orderDoc.completed,
    itemsDetailed,
  });

  for (const res of sseClients) {
    res.write('event: order\n');
    res.write(`data: ${payload}\n\n`);
  }
}

/* ===================== Auth ===================== */
app.post('/login', (req, res) => {
  const { password } = req.body;
  res.json({ success: password === (process.env.ADMIN_PASSWORD || 'admin123') });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin.html'));
});

/* ===================== Products ===================== */
// 取得商品（缺貨排最上，其餘按名稱）
app.get('/products', async (req, res) => {
  const { tag, keyword } = req.query;

  const cond = {};
  if (tag) cond.tags = tag;
  if (keyword) {
    cond.$or = [
      { name: new RegExp(keyword, 'i') },
      { tags: { $elemMatch: { $regex: keyword, $options: 'i' } } },
    ];
  }

  let list = await Product.find(cond).lean();
  list.sort((a, b) => {
    const ao = a.stock === 0 ? 0 : 1;
    const bo = b.stock === 0 ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name, 'zh-Hant');
  });

  list = list.map((p) => ({
    ...p,
    image: toFullUrl(req, p.image),
    outOfStock: p.stock <= 0,
  }));
  res.json(list);
});

// 新增商品（Cloudinary 上傳）
app.post('/add-product', upload.single('image'), async (req, res) => {
  try {
    const { name, price, stock, tags } = req.body;
    if (!name || !price || !stock) {
      return res.json({ success: false, message: '請填寫完整商品資料（名稱/價格/庫存）' });
    }

    let imageUrl = '';
    if (req.file) {
      const up = await cloudinaryUploadBuffer(req.file.buffer, 'products');
      imageUrl = up.secure_url;
    }

    const product = await Product.create({
      name: String(name),
      price: Number(price),
      stock: Number(stock),
      image: imageUrl,
      tags: (tags ? String(tags).split(',').map((s) => s.trim()).filter(Boolean) : []),
    });

    res.json({
      success: true,
      message: `✅ 商品「${product.name}」新增成功`,
      product: { ...product.toObject(), image: toFullUrl(req, product.image) },
    });
  } catch (e) {
    console.error(e);
    res.json({ success: false, message: '新增商品失敗' });
  }
});

// 更換商品圖片
app.post('/update-product-image', upload.single('image'), async (req, res) => {
  try {
    const { productId } = req.body;
    const p = await Product.findById(productId);
    if (!p) return res.json({ success: false, message: '❌ 商品不存在' });
    if (!req.file) return res.json({ success: false, message: '❌ 沒有收到圖片檔案' });

    const up = await cloudinaryUploadBuffer(req.file.buffer, 'products');
    p.image = up.secure_url;
    await p.save();

    res.json({
      success: true,
      message: `✅ 商品「${p.name}」圖片已更新`,
      product: { ...p.toObject(), image: toFullUrl(req, p.image) },
    });
  } catch (e) {
    console.error(e);
    res.json({ success: false, message: '更新圖片失敗' });
  }
});

// 修改價格
app.post('/update-price', async (req, res) => {
  const { productId, price } = req.body;
  const newPrice = Number(price);
  const p = await Product.findById(productId);
  if (!p) return res.json({ success: false, message: '❌ 商品不存在' });
  if (!Number.isFinite(newPrice) || newPrice < 0)
    return res.json({ success: false, message: '❌ 價格需為非負數字' });
  p.price = newPrice;
  await p.save();
  res.json({ success: true, message: `✅ 「${p.name}」價格已更新為 NT$${newPrice}` });
});

// 刪除商品
app.post('/delete-product', async (req, res) => {
  const { productId } = req.body;
  const p = await Product.findByIdAndDelete(productId);
  if (!p) return res.json({ success: false, message: '❌ 商品不存在' });
  res.json({ success: true, message: `🗑️ 商品「${p.name}」已刪除` });
});

/* ===================== Orders ===================== */
// 建立訂單（檢查庫存、扣庫存、每日序號）
app.post('/order', async (req, res) => {
  try {
    const { name, phone, address, items, pickupDate, note } = req.body;
    if (!Array.isArray(items) || items.length === 0)
      return res.json({ success: false, message: '購物車為空' });

    let total = 0;
    const parsed = [];
    let error = '';

    for (const it of items) {
      const p = await Product.findById(it.productId);
      const qty = Number(it.quantity);
      if (!p) { error += `商品不存在（ID: ${it.productId}）\n`; continue; }
      if (!Number.isInteger(qty) || qty <= 0) { error += `${p.name} 數量有誤\n`; continue; }
      if (p.stock <= 0) { error += `${p.name} 已缺貨\n`; continue; }
      if (p.stock < qty) { error += `${p.name} 庫存不足（剩 ${p.stock} 件）\n`; continue; }
      total += p.price * qty;
      parsed.push({ product: p, quantity: qty });
    }

    if (error) return res.json({ success: false, message: error.trim() });

    // 扣庫存
    for (const { product, quantity } of parsed) {
      product.stock -= quantity;
      await product.save();
    }

    // 當日序號
    const { date, seq } = await nextOrderNumber();

    const order = await Order.create({
      orderNumber: seq,
      orderDate: date,
      name,
      phone,
      address,
      pickupDate,
      note: note || '',
      items: parsed.map((i) => ({ productId: i.product._id, quantity: i.quantity })),
      total,
      completed: false,
    });

    // 取商品明細給 SSE
    const populated = await Product.find({
      _id: { $in: order.items.map((i) => i.productId) },
    }).lean();
    order._populatedItems = populated;
    pushOrderToAdmins(order, req);

    res.json({ success: true, message: `✅ 訂單完成，總金額：${total} 元` });
  } catch (e) {
    console.error(e);
    res.json({ success: false, message: '系統錯誤，請稍後再試' });
  }
});

// 初次載入全部訂單（後台用）
app.get('/orders', async (req, res) => {
  const orders = await Order.find().sort({ createdAt: 1 }).lean();
  const productIds = [...new Set(orders.flatMap((o) => o.items.map((i) => i.productId)))];
  const products = await Product.find({ _id: { $in: productIds } }).lean();

  const withDetails = orders.map((o) => {
    const itemsDetailed = o.items.map((it) => {
      const p = products.find((pp) => String(pp._id) === String(it.productId));
      return {
        ...it,
        name: p?.name || '',
        price: p?.price || 0,
        image: toFullUrl(req, p?.image || ''),
      };
    });
    return { ...o, itemsDetailed };
  });

  res.json(withDetails);
});

// 訂單查詢
app.get('/query-orders', async (req, res) => {
  const {
    name = '',
    phone = '',
    start,
    end,
    completed,
    sort,
    includeDetails,
  } = req.query;

  const cond = {
    name: { $regex: name },
    phone: { $regex: phone },
  };

  if (start || end) {
    cond.pickupDate = {};
    if (start) cond.pickupDate.$gte = start;
    if (end) cond.pickupDate.$lte = end;
  }

  if (completed === 'true') cond.completed = true;
  else if (completed === 'false') cond.completed = false;

  let result = await Order.find(cond).lean();

  if (sort === 'amount') result.sort((a, b) => b.total - a.total);
  else if (sort === 'date') result.sort((a, b) => new Date(b.pickupDate) - new Date(a.pickupDate));

  if (includeDetails === '1') {
    const productIds = [...new Set(result.flatMap((o) => o.items.map((i) => i.productId)))];
    const products = await Product.find({ _id: { $in: productIds } }).lean();
    result = result.map((o) => ({
      ...o,
      itemsDetailed: o.items.map((it) => {
        const p = products.find((pp) => String(pp._id) === String(it.productId));
        return {
          ...it,
          name: p?.name || '',
          price: p?.price || 0,
          image: toFullUrl(req, p?.image || ''),
        };
      }),
    }));
  }

  res.json(result);
});

// 標記訂單完成
app.post('/complete-order', async (req, res) => {
  const { orderId } = req.body;
  const o = await Order.findById(orderId);
  if (!o) return res.json({ success: false, message: '❌ 訂單不存在' });
  o.completed = true;
  await o.save();

  const productIds = o.items.map((i) => i.productId);
  const populated = await Product.find({ _id: { $in: productIds } }).lean();
  o._populatedItems = populated;
  pushOrderToAdmins(o, req);

  res.json({ success: true, message: `✅ 訂單 #${o.orderNumber} 已標記為完成` });
});

/* ===================== 補貨 ===================== */
app.post('/restock', async (req, res) => {
  const { productId, quantity } = req.body;
  const p = await Product.findById(productId);
  const qty = Number(quantity);
  if (!p) return res.json({ success: false, message: '❌ 商品不存在' });
  if (!Number.isInteger(qty) || qty <= 0) return res.json({ success: false, message: '❌ 補貨數量需為正整數' });

  p.stock += qty;
  await p.save();
  await Restock.create({ time: new Date().toLocaleString(), name: p.name, quantity: qty });
  res.json({ success: true, message: `✅ 補貨 ${qty} 件至「${p.name}」` });
});

app.get('/restock-history', async (req, res) => {
  const rows = await Restock.find().sort({ createdAt: 1 }).lean();
  res.json(rows);
});

/* ===================== SSE 即時訂單 ===================== */
app.get('/admin/orders/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('event: hello\n');
  res.write('data: "connected"\n\n');

  sseClients.add(res);
  const heartbeat = setInterval(() => res.write(':\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

/* ===================== 啟動 ===================== */
app.listen(PORT, () => {
  console.log(`✅ 訂單系統運行中：http://localhost:${PORT}`);
});

// 捕捉未處理的 promise
process.on('unhandledRejection', (e) => {
  console.error('UnhandledRejection:', e);
});
