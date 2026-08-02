// ============================================
// THE ABUELA API — server.js v1
// Fase 1 (backend + órdenes) + Fase 3 (portal de la familia)
// Stack: Express + PostgreSQL + JWT (mismo patrón que ConsignPro)
// ============================================

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = '30d'; // igual que ConsignPro

if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET no está definido en las variables de entorno');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || '*', // en producción: tu dominio
}));
app.use(express.json());

// ---------- Helpers ----------

function signToken(customer) {
  return jwt.sign({ id: customer.id, email: customer.email }, JWT_SECRET, {
    expiresIn: JWT_EXPIRY,
  });
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Login required' });
  try {
    req.customer = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired. Log in again.' });
  }
}

function validMonthDay(month, day) {
  if (month == null && day == null) return true; // opcional
  if (month == null || day == null) return false;
  const m = Number(month), d = Number(day);
  return Number.isInteger(m) && Number.isInteger(d) && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

async function nextOrderNumber(client) {
  const { rows } = await client.query(
    "SELECT COALESCE(MAX(id),0)+1 AS n FROM abuela_orders"
  );
  const year = new Date().getFullYear();
  return `AB-${year}-${String(rows[0].n).padStart(6, '0')}`;
}

// ---------- Health ----------

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'abuela-api', db: 'connected' });
  } catch (e) {
    res.status(500).json({ ok: false, db: 'error' });
  }
});

// ============================================
// FASE 3 — LA FAMILIA (auth + portal)
// ============================================

// --- Registro: "Pull up a chair" ---
// Obligatorios: name, email, password. Todo lo demás opcional.
app.post('/api/family/register', async (req, res) => {
  const {
    name, email, password,
    phone, birthday_month, birthday_day, mate_circle,
    marketing_opt_in, celebrate_mothers_day, celebrate_fathers_day, celebrate_christmas,
    pets, // [{ name, birthday_month, birthday_day }]
  } = req.body || {};

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!validMonthDay(birthday_month, birthday_day)) {
    return res.status(400).json({ error: 'Birthday needs both month and day (or neither)' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await client.query(
      `INSERT INTO abuela_customers
        (email, password_hash, name, phone, birthday_month, birthday_day, mate_circle,
         marketing_opt_in, celebrate_mothers_day, celebrate_fathers_day, celebrate_christmas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, email, name`,
      [
        email.toLowerCase().trim(), hash, name.trim(), phone || null,
        birthday_month || null, birthday_day || null, mate_circle || null,
        !!marketing_opt_in, !!celebrate_mothers_day, !!celebrate_fathers_day, !!celebrate_christmas,
      ]
    );
    const customer = rows[0];

    if (Array.isArray(pets)) {
      for (const p of pets) {
        if (!p || !p.name) continue;
        if (!validMonthDay(p.birthday_month, p.birthday_day)) continue;
        await client.query(
          `INSERT INTO abuela_pets (customer_id, name, birthday_month, birthday_day)
           VALUES ($1,$2,$3,$4)`,
          [customer.id, String(p.name).trim(), p.birthday_month || null, p.birthday_day || null]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ token: signToken(customer), customer });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') {
      return res.status(409).json({ error: 'That email is already part of the family. Try logging in.' });
    }
    console.error('register error:', e.message);
    res.status(500).json({ error: 'Could not create your account' });
  } finally {
    client.release();
  }
});

// --- Login ---
app.post('/api/family/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, password_hash FROM abuela_customers WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    const customer = rows[0];
    if (!customer || !(await bcrypt.compare(password, customer.password_hash))) {
      return res.status(401).json({ error: 'Wrong email or password' });
    }
    res.json({
      token: signToken(customer),
      customer: { id: customer.id, email: customer.email, name: customer.name },
    });
  } catch (e) {
    console.error('login error:', e.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// --- Mi perfil (ver) ---
app.get('/api/family/me', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, name, phone, birthday_month, birthday_day, mate_circle,
              marketing_opt_in, celebrate_mothers_day, celebrate_fathers_day,
              celebrate_christmas, created_at
       FROM abuela_customers WHERE id = $1`,
      [req.customer.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    const { rows: pets } = await pool.query(
      'SELECT id, name, birthday_month, birthday_day FROM abuela_pets WHERE customer_id = $1 ORDER BY id',
      [req.customer.id]
    );
    res.json({ ...rows[0], pets });
  } catch (e) {
    console.error('me error:', e.message);
    res.status(500).json({ error: 'Could not load your profile' });
  }
});

// --- Mi perfil (editar) ---
app.put('/api/family/me', authRequired, async (req, res) => {
  const {
    name, phone, birthday_month, birthday_day, mate_circle,
    marketing_opt_in, celebrate_mothers_day, celebrate_fathers_day, celebrate_christmas,
  } = req.body || {};
  if (!validMonthDay(birthday_month, birthday_day)) {
    return res.status(400).json({ error: 'Birthday needs both month and day (or neither)' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE abuela_customers SET
         name = COALESCE($1, name),
         phone = $2,
         birthday_month = $3,
         birthday_day = $4,
         mate_circle = $5,
         marketing_opt_in = COALESCE($6, marketing_opt_in),
         celebrate_mothers_day = COALESCE($7, celebrate_mothers_day),
         celebrate_fathers_day = COALESCE($8, celebrate_fathers_day),
         celebrate_christmas = COALESCE($9, celebrate_christmas),
         updated_at = NOW()
       WHERE id = $10
       RETURNING id, email, name`,
      [
        name || null, phone || null, birthday_month || null, birthday_day || null,
        mate_circle || null,
        typeof marketing_opt_in === 'boolean' ? marketing_opt_in : null,
        typeof celebrate_mothers_day === 'boolean' ? celebrate_mothers_day : null,
        typeof celebrate_fathers_day === 'boolean' ? celebrate_fathers_day : null,
        typeof celebrate_christmas === 'boolean' ? celebrate_christmas : null,
        req.customer.id,
      ]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('update me error:', e.message);
    res.status(500).json({ error: 'Could not update your profile' });
  }
});

// --- Mascotas: agregar ---
app.post('/api/family/pets', authRequired, async (req, res) => {
  const { name, birthday_month, birthday_day } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Pet name required' });
  if (!validMonthDay(birthday_month, birthday_day)) {
    return res.status(400).json({ error: 'Pet birthday needs both month and day (or neither)' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO abuela_pets (customer_id, name, birthday_month, birthday_day)
       VALUES ($1,$2,$3,$4) RETURNING id, name, birthday_month, birthday_day`,
      [req.customer.id, String(name).trim(), birthday_month || null, birthday_day || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('add pet error:', e.message);
    res.status(500).json({ error: 'Could not add your pet' });
  }
});

// --- Mascotas: eliminar ---
app.delete('/api/family/pets/:id', authRequired, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM abuela_pets WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.customer.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Pet not found' });
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not remove pet' });
  }
});

// --- Mis pedidos ---
app.get('/api/family/orders', authRequired, async (req, res) => {
  try {
    const { rows: orders } = await pool.query(
      `SELECT id, order_number, status, subtotal_cents, shipping_cents, tax_cents,
              total_cents, currency, created_at
       FROM abuela_orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.customer.id]
    );
    for (const o of orders) {
      const { rows: items } = await pool.query(
        'SELECT sku, title, quantity, unit_price_cents FROM abuela_order_items WHERE order_id = $1',
        [o.id]
      );
      o.items = items;
    }
    res.json(orders);
  } catch (e) {
    console.error('orders error:', e.message);
    res.status(500).json({ error: 'Could not load your orders' });
  }
});

// ============================================
// FASE 1 — CATÁLOGO Y ÓRDENES
// ============================================

// --- Catálogo público ---
app.get('/api/products', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT sku, title, size_label, price_cents, stock
       FROM abuela_products WHERE active = TRUE AND stock > 0 ORDER BY title`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Could not load products' });
  }
});

// --- Crear orden (pre-Stripe: registra la orden en pending) ---
// En Fase 2, este endpoint creará también la sesión de Stripe Checkout.
app.post('/api/orders', async (req, res) => {
  const { email, items, shipping } = req.body || {};
  // items: [{ sku, quantity }]
  if (!email || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Email and at least one item required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let subtotal = 0;
    const lineItems = [];
    for (const it of items) {
      const qty = Math.max(1, parseInt(it.quantity, 10) || 1);
      const { rows } = await client.query(
        'SELECT sku, title, price_cents, stock FROM abuela_products WHERE sku = $1 AND active = TRUE FOR UPDATE',
        [it.sku]
      );
      const p = rows[0];
      if (!p) throw Object.assign(new Error(`Unknown product: ${it.sku}`), { status: 400 });
      if (p.stock < qty) throw Object.assign(new Error(`Not enough stock for ${p.title}`), { status: 409 });
      subtotal += p.price_cents * qty;
      lineItems.push({ sku: p.sku, title: p.title, quantity: qty, unit_price_cents: p.price_cents });
    }

    // Envío honesto: un box, una tarifa plana; gratis sobre $75 (7500 cents).
    // (Zonas reales llegan en Fase 2 con la config de envío.)
    const FREE_SHIPPING_THRESHOLD = 7500;
    const FLAT_SHIPPING = 899;
    const shippingCents = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : FLAT_SHIPPING;
    const taxCents = 0; // Fase 2: Stripe Tax calcula el sales tax real por estado
    const totalCents = subtotal + shippingCents + taxCents;

    // Vincular a cuenta de familia si el email tiene cuenta
    const { rows: custRows } = await client.query(
      'SELECT id FROM abuela_customers WHERE email = $1',
      [String(email).toLowerCase().trim()]
    );
    const customerId = custRows[0] ? custRows[0].id : null;

    const orderNumber = await nextOrderNumber(client);
    const { rows: orderRows } = await client.query(
      `INSERT INTO abuela_orders
         (order_number, customer_id, email, status, subtotal_cents, shipping_cents,
          tax_cents, total_cents, shipping_name, shipping_address1, shipping_address2,
          shipping_city, shipping_state, shipping_zip)
       VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, order_number, total_cents, status`,
      [
        orderNumber, customerId, String(email).toLowerCase().trim(),
        subtotal, shippingCents, taxCents, totalCents,
        shipping?.name || null, shipping?.address1 || null, shipping?.address2 || null,
        shipping?.city || null, shipping?.state || null, shipping?.zip || null,
      ]
    );
    const order = orderRows[0];

    for (const li of lineItems) {
      await client.query(
        `INSERT INTO abuela_order_items (order_id, sku, title, quantity, unit_price_cents)
         VALUES ($1,$2,$3,$4,$5)`,
        [order.id, li.sku, li.title, li.quantity, li.unit_price_cents]
      );
      // Descuento de stock (FIFO real contra ConsignPro llega en Fase 4)
      await client.query(
        'UPDATE abuela_products SET stock = stock - $1 WHERE sku = $2',
        [li.quantity, li.sku]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({
      order_number: order.order_number,
      total_cents: order.total_cents,
      status: order.status,
      note: 'Order recorded as pending. Payment (Stripe Checkout) arrives in Phase 2.',
    });
  } catch (e) {
    await client.query('ROLLBACK');
    const status = e.status || 500;
    if (status === 500) console.error('create order error:', e.message);
    res.status(status).json({ error: e.status ? e.message : 'Could not create order' });
  } finally {
    client.release();
  }
});

// --- Calendario de regalos: qué se celebra HOY (para uso interno/admin) ---
app.get('/api/admin/celebrations-today', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM abuela_todays_celebrations');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Could not load celebrations' });
  }
});

// ---------- Start ----------

app.listen(PORT, () => {
  console.log(`🧉 The Abuela API listening on port ${PORT}`);
});
