const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const app = express();
const port = 3000;

let products = [
  { id: 1, name: "古早味肉粽三層肉", price: 50, stock: 10, image: "zongzi_pork.jpg", tags: ["經典", "三層肉"] },
  { id: 2, name: "古早味肉粽瘦肉", price: 50, stock: 5, image: "zongzi_lean.jpg", tags: ["瘦肉"] },
  { id: 3, name: "古早味肉粽(素食)素食", price: 50, stock: 3, image: "zongzi_veg.jpg", tags: ["素食"] },
  { id: 4, name: "手作芋頭巧", price: 50, stock: 10, image: "taro_ball.jpg", tags: ["甜點"] },
  { id: 5, name: "台式蘿蔔糕", price: 50, stock: 5, image: "radish_cake.jpg", tags: ["點心"] },
  { id: 6, name: "紅龜粿", price: 50, stock: 3, image: "red_turtle.jpg", tags: ["傳統"] },
  { id: 7, name: "草阿粿草阿粿", price: 50, stock: 3, image: "caoa_cake.jpg", tags: ["青草"] },
];

let orders = [];
let restockHistory = [];

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({ secret: 'adminsecret', resave: false, saveUninitialized: true }));
app.use(express.static('public'));

// 管理員登入
app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === 'admin123') {
    req.session.admin = true;
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

// 登出
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin.html');
});

// 商品清單（只回傳庫存 > 0 的商品）
app.get('/products', (req, res) => {
  const available = products.filter(p => p.stock > 0);
  res.json(available);
});

// 建立訂單
app.post('/order', (req, res) => {
  const { name, phone, address, items, pickupDate } = req.body;
  let total = 0;
  let errorMsg = "";

  const parsedItems = items.map(item => {
    const product = products.find(p => p.id == item.productId);
    const qty = Number(item.quantity);
    if (!product || product.stock < qty) {
      errorMsg += `${product?.name || "商品"} 庫存不足（剩下 ${product?.stock || 0} 件）\n`;
      return null;
    }
    total += product.price * qty;
    return { product, quantity: qty };
  });

  if (errorMsg) {
    return res.json({ success: false, message: errorMsg });
  }

  parsedItems.forEach(({ product, quantity }) => {
    product.stock -= quantity;
  });

  const order = {
    id: orders.length + 1,
    name,
    phone,
    address,
    pickupDate,
    items: parsedItems,
    total
  };

  orders.push(order);
  res.json({ success: true, message: `✅ 訂單完成，總金額：${total} 元` });
});

// 查詢訂單
app.get('/query-orders', (req, res) => {
  const { name = '', phone = '', start, end, sort } = req.query;
  let result = orders.filter(o =>
    o.name.includes(name) && o.phone.includes(phone)
  );

  if (start) {
    const startDate = new Date(start);
    result = result.filter(o => new Date(o.pickupDate) >= startDate);
  }
  if (end) {
    const endDate = new Date(end);
    result = result.filter(o => new Date(o.pickupDate) <= endDate);
  }

  if (sort === 'amount') result.sort((a, b) => b.total - a.total);
  if (sort === 'date') result.sort((a, b) => new Date(b.pickupDate) - new Date(a.pickupDate));

  res.json(result);
});

// 查詢所有訂單
app.get('/orders', (req, res) => {
  res.json(orders);
});

// 補貨
app.post('/restock', (req, res) => {
  const { productId, quantity } = req.body;
  const product = products.find(p => p.id == productId);
  if (product) {
    product.stock += Number(quantity);
    restockHistory.push({
      time: new Date().toLocaleString(),
      name: product.name,
      quantity: Number(quantity)
    });
    res.send({ success: true, message: `✅ 補貨 ${quantity} 件至「${product.name}」` });
  } else {
    res.send({ success: false, message: "❌ 商品不存在" });
  }
});

// 新增商品
app.post('/add-product', (req, res) => {
  const { name, price, stock } = req.body;
  const newProduct = {
    id: products.length + 1,
    name,
    price: Number(price),
    stock: Number(stock)
  };
  products.push(newProduct);
  res.json({ success: true, message: `✅ 商品「${name}」新增成功` });
});

// 補貨紀錄
app.get('/restock-history', (req, res) => {
  res.json(restockHistory);
});

app.listen(port, () => {
  console.log(`✅ 訂單系統運行中：http://localhost:${port}`);
});
