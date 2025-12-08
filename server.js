// --------------------
// BASIC SETUP
// --------------------
const express = require('express');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const session = require('express-session');
require('dotenv').config();

const app = express();

app.use(session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, httpOnly: true, sameSite: 'lax' }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// --------------------
// DATABASE CONNECTION
// --------------------
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'inventory_db',
  port: 3306
});

async function startServer() {
  try {
    console.log("MySQL Connected...");
  } catch (err) {
    console.error("DB Connection Error:", err);
  }
}

startServer();

// Authentication middleware validation
function isAuthenticated(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  next();
}

// --------------------
// HTML PAGE ROUTES
// --------------------
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/registration', (req, res) => {
  res.sendFile(path.join(__dirname, 'registration.html'));
});

app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'Dashboard.html'));
});

// --------------------
// AUTH ROUTES
// --------------------
app.post('/register', async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password || !role)
    return res.status(400).json({ success: false, message: "All fields required" });

  const [exists] = await pool.query("SELECT * FROM users WHERE email=?", [email]);

  if (exists.length > 0)
    return res.status(400).json({ success: false, message: "Email already registered" });

  const hashed = await bcrypt.hash(password, 10);

  await pool.query(
    "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)",
    [name, email, hashed, role]
  );

  res.json({ success: true, message: "Registration successful" });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  const [rows] = await pool.query("SELECT * FROM users WHERE email=?", [email]);
  if (rows.length === 0)
    return res.status(400).json({ success: false, message: "Email not registered" });

  const user = rows[0];
  const match = await bcrypt.compare(password, user.password);

  if (!match)
    return res.status(400).json({ success: false, message: "Incorrect password" });

  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role
  };

  req.session.save(() => {
    res.json({ success: true, message: "Login successful" });
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/current-user', (req, res) => {
  if (!req.session.user) return res.json({ success: false, user: null });
  res.json({ success: true, user: req.session.user });
});


// --------------------
// USER MANAGEMENT ROUTES (Get, Update, Delete Users)
// --------------------
app.get('/api/users', isAuthenticated, async (req, res) => {
  if (req.session.user.role !== 'Shopkeeper') return res.status(403).json({ message: 'Access denied' });

  try {
    const [results] = await pool.query('SELECT id, name, email, role FROM users');
    res.json({ status: 'success', users: results });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

app.delete('/api/users/:id', isAuthenticated, async (req, res) => {
  if (req.session.user.role !== 'Shopkeeper') return res.status(403).json({ message: 'Access denied' });

  const userId = req.params.id;

  try {
   if (req.session.user.id === parseInt(userId)) {
      return res.status(400).json({ message: 'You cannot delete your own account.' });
    }

    const [result] = await pool.query('DELETE FROM users WHERE id = ?', [userId]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(204).send();
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

app.put('/api/users/:id', isAuthenticated, async (req, res) => {
  if (req.session.user.role !== 'Shopkeeper') return res.status(403).json({ message: 'Access denied' });

  const { role } = req.body;
  const userId = req.params.id;

  try {
    if (role !== 'Shopkeeper' && role !== 'Assistant') {
      return res.status(400).json({ message: 'Invalid role' });
    }

    const [result] = await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, userId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({ status: 'success', message: 'User role updated' });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// --------------------
// PRODUCT ROUTES
// --------------------
app.get('/api/products/dashboard', async (req, res) => {
  const [inventory] = await pool.query("SELECT * FROM products");

  const stats = {
    totalProducts: inventory.length,
    lowStockItems: inventory.filter(p => p.stock <= 10).length,
    totalValue: inventory.reduce((sum, p) => sum + p.stock * p.price, 0),
    totalCategories: new Set(inventory.map(p => p.category)).size
  };

  res.json({ status: "success", inventory, stats });
});

// Create a new product
app.post('/api/products', isAuthenticated, async (req, res) => {
  if (req.session.user.role !== 'Shopkeeper') return res.status(403).json({ message: 'Access denied' });

  const { name, sku, category, stock, price, reorder_level } = req.body;
  if (!name || !sku || !category || stock == null || price == null) {
    return res.status(400).json({ status: 'error', message: 'All fields are required' });
  }

  try {
    await pool.query(
      'INSERT INTO products (name, sku, category, stock, price, reorder_level) VALUES (?, ?, ?, ?, ?, ?)',
      [name, sku, category, stock, price, reorder_level]
    );

    res.json({ status: 'success', message: 'Product added successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: 'Failed to add product' });
  }
});

// Update a product
app.put('/api/products/:id', isAuthenticated, async (req, res) => {
  if (req.session.user.role !== 'Shopkeeper') return res.status(403).json({ message: 'Access denied' });

  const { name, sku, category, stock, price, reorder_level } = req.body;
  const productId = req.params.id;

  try {
    const [result] = await pool.query(
      'UPDATE products SET name=?, sku=?, category=?, stock=?, price=?, reorder_level=? WHERE id=?',
      [name, sku, category, stock, price, reorder_level, productId]
    );

    if (result.affectedRows === 0) return res.status(404).json({ status: 'error', message: 'Product not found' });

    res.json({ status: 'success', message: 'Product updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: 'Failed to update product' });
  }
});

// Delete a product
app.delete('/api/products/:id', isAuthenticated, async (req, res) => {
  if (req.session.user.role !== 'Shopkeeper') return res.status(403).json({ message: 'Access denied' });

  const productId = req.params.id;
  try {
    const [result] = await pool.query('DELETE FROM products WHERE id=?', [productId]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Product not found' });

    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to delete product' });
  }
});


// POST /forgot-password
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;

  try {
    const [user] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (!user || user.length === 0) {
      return res.status(404).json({ message: 'No account with that email' });
    }

    const userId = user[0].id;

    // Create JWT token
    const token = jwt.sign(
      { userId },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_RESET_EXPIRY || '1h' }
    );

    // Create reset link
    const resetLink = `http://localhost:3000/reset-password.html?token=${token}`;

    // Create Ethereal test account & transporter
    const testAccount = await nodemailer.createTestAccount();
    const transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      auth: { user: testAccount.user, pass: testAccount.pass }
    });

    // Send email
    const info = await transporter.sendMail({
      from: '"My App" <no-reply@example.com>',
      to: email,
      subject: 'Password Reset Request',
      html: `
        <p>You requested a password reset.</p>
        <p>Click <a href="${resetLink}">here</a> to reset your password. Link expires in 1 hour.</p>
      `
    });

    console.log('Preview URL: ' + nodemailer.getTestMessageUrl(info));

    res.json({ message: 'Password reset email sent', preview: nodemailer.getTestMessageUrl(info) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});


// POST /reset-password
app.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token) return res.status(400).json({ message: 'Token is required' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const userId = payload.userId;

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const [result] = await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);

    if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });

    res.json({ message: 'Password has been reset successfully' });
  } catch (err) {
    console.error(err);
    if (err.name === 'TokenExpiredError') {
      return res.status(400).json({ message: 'Reset token has expired' });
    }
    res.status(400).json({ message: 'Invalid token' });
  }
});

// --------------------
// Server Setup
// --------------------
app.listen(3000, () => console.log("Server running on http://localhost:3000"));

