-- ============================================
-- THE ABUELA — Database Schema v1
-- Familia (Fase 3) + Órdenes (Fase 1)
-- Corre esto UNA VEZ en tu PostgreSQL de Railway
-- ============================================

-- ---------- LA FAMILIA ----------

CREATE TABLE IF NOT EXISTS abuela_customers (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(30),
  -- cumpleaños: solo mes y día (sin año — evita tema COPPA/edad)
  birthday_month SMALLINT CHECK (birthday_month BETWEEN 1 AND 12),
  birthday_day SMALLINT CHECK (birthday_day BETWEEN 1 AND 31),
  mate_circle TEXT,                  -- "partner, kids..." texto libre opcional
  marketing_opt_in BOOLEAN DEFAULT FALSE,
  celebrate_mothers_day BOOLEAN DEFAULT FALSE,
  celebrate_fathers_day BOOLEAN DEFAULT FALSE,
  celebrate_christmas BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS abuela_pets (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES abuela_customers(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  birthday_month SMALLINT CHECK (birthday_month BETWEEN 1 AND 12),
  birthday_day SMALLINT CHECK (birthday_day BETWEEN 1 AND 31),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Vista para el "calendario de regalos": qué celebrar hoy
-- (la Fase de automatización de regalos consultará esto)
CREATE OR REPLACE VIEW abuela_todays_celebrations AS
SELECT 'customer_birthday' AS kind, c.id AS customer_id, c.name AS who, c.email
FROM abuela_customers c
WHERE c.birthday_month = EXTRACT(MONTH FROM CURRENT_DATE)
  AND c.birthday_day = EXTRACT(DAY FROM CURRENT_DATE)
UNION ALL
SELECT 'pet_birthday' AS kind, p.customer_id, p.name AS who, c.email
FROM abuela_pets p
JOIN abuela_customers c ON c.id = p.customer_id
WHERE p.birthday_month = EXTRACT(MONTH FROM CURRENT_DATE)
  AND p.birthday_day = EXTRACT(DAY FROM CURRENT_DATE);

-- ---------- ÓRDENES (mismo patrón que eBay/Amazon en ConsignPro) ----------

CREATE TABLE IF NOT EXISTS abuela_orders (
  id SERIAL PRIMARY KEY,
  order_number VARCHAR(30) UNIQUE NOT NULL,      -- ej. AB-2026-000001
  customer_id INTEGER REFERENCES abuela_customers(id),
  email VARCHAR(255) NOT NULL,                   -- por si compra sin cuenta
  status VARCHAR(30) NOT NULL DEFAULT 'pending', -- pending|paid|shipped|delivered|cancelled|refunded
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  stripe_session_id VARCHAR(255),                -- para la Fase 2 (Stripe)
  shipping_name VARCHAR(120),
  shipping_address1 VARCHAR(200),
  shipping_address2 VARCHAR(200),
  shipping_city VARCHAR(100),
  shipping_state VARCHAR(50),
  shipping_zip VARCHAR(20),
  channel VARCHAR(20) NOT NULL DEFAULT 'abuela_web',  -- espeja tus canales ebay/amazon
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS abuela_order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES abuela_orders(id) ON DELETE CASCADE,
  sku VARCHAR(50) NOT NULL,          -- mismos SKUs del CSV: CDM-500, PIP-1000, etc.
  title VARCHAR(200) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_abuela_orders_customer ON abuela_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_abuela_orders_status ON abuela_orders(status);
CREATE INDEX IF NOT EXISTS idx_abuela_order_items_order ON abuela_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_abuela_order_items_sku ON abuela_order_items(sku);

-- ---------- CATÁLOGO (los productos del invoice) ----------

CREATE TABLE IF NOT EXISTS abuela_products (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(50) UNIQUE NOT NULL,
  title VARCHAR(200) NOT NULL,
  size_label VARCHAR(30),            -- '500g' | '1kg' | NULL
  price_cents INTEGER NOT NULL,
  cost_cents INTEGER NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed: los 15 SKUs reales del invoice Yaguar (precio = costo x6)
INSERT INTO abuela_products (sku, title, size_label, price_cents, cost_cents, stock) VALUES
('AMA4-500','Amanda 4 - Yerba Mate','500g',720,120,5),
('AMASU-1000','Amanda Suave - Yerba Mate','1kg',1482,247,5),
('AMATR-1000','Amanda Tradicional Nueva - Yerba Mate','1kg',1422,237,55),
('CDM-500','Cruz de Malta - Yerba Mate','500g',990,165,40),
('LM-CM','La Merced Campo & Monte - Yerba Mate',NULL,1740,290,25),
('PIP-500','Pipore Tradicional - Yerba Mate','500g',750,125,3),
('PIP-1000','Pipore Tradicional - Yerba Mate','1kg',1656,276,70),
('PLA-500','Playadito Suave - Yerba Mate','500g',960,160,125),
('PLA-1000','Playadito Suave - Yerba Mate','1kg',1800,300,200),
('ROS-TR','Rosamonte Tradicional 55 Aniversario - Yerba Mate',NULL,720,120,25),
('ROS-SU','Rosamonte Suave 55 Aniversario - Yerba Mate',NULL,1560,260,38),
('ROS-1000','Rosamonte 55 Aniversario - Yerba Mate','1kg',1380,230,40),
('TAR-500','Taragui 4Flex - Yerba Mate','500g',780,130,39),
('TAR-1000','Taragui 4Flex - Yerba Mate','1kg',1698,283,49),
('TAR-AZ','Taragui 4Flex O.C. Azul - Yerba Mate',NULL,2256,376,10)
ON CONFLICT (sku) DO NOTHING;
