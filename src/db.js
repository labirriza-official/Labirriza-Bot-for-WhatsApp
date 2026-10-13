'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new Database(process.env.DB_FILE || path.join(config.dataDir, 'birriaza.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  phone       TEXT PRIMARY KEY,
  state       TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    INTEGER NOT NULL,            -- epoch ms
  phone         TEXT NOT NULL,
  customer      TEXT NOT NULL,
  delivery      TEXT NOT NULL,               -- 'domicilio' | 'recoger'
  lat           REAL,
  lng           REAL,
  address       TEXT,
  reference     TEXT,
  contact_phone TEXT,                        -- teléfono para llamar al llegar (domicilio)
  payment       TEXT NOT NULL,               -- 'efectivo' | 'transferencia'
  pay_with      INTEGER,                     -- billete con el que paga (efectivo)
  proof_media   TEXT,                        -- id del comprobante (transferencia)
  subtotal      INTEGER NOT NULL,
  shipping      INTEGER NOT NULL,
  total         INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'nuevo', -- nuevo | preparando | en_camino | listo | entregado | cancelado
  source        TEXT NOT NULL DEFAULT 'whatsapp', -- 'whatsapp' | 'simulador'
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  short       TEXT NOT NULL,
  qty         INTEGER NOT NULL,
  unit_price  INTEGER NOT NULL,
  amount      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS print_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | imprimiendo | impreso | error
  attempts    INTEGER NOT NULL DEFAULT 0,
  leased_at   INTEGER,
  printed_at  INTEGER,
  error       TEXT
);

-- Eventos para medir el embudo del bot (inicio -> armó pedido -> confirmó)
CREATE TABLE IF NOT EXISTS events (
  ts     INTEGER NOT NULL,
  phone  TEXT NOT NULL,
  type   TEXT NOT NULL,   -- 'inicio' | 'carrito' | 'confirmado'
  source TEXT NOT NULL DEFAULT 'whatsapp'
);

-- Evita procesar dos veces el mismo mensaje (Meta a veces reintenta)
CREATE TABLE IF NOT EXISTS processed_messages (
  id  TEXT PRIMARY KEY,
  ts  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON print_jobs(status);
`);

// Migración: bases creadas antes de agregar el teléfono de contacto
if (!db.prepare(`PRAGMA table_info(orders)`).all().some((c) => c.name === 'contact_phone')) {
  db.exec(`ALTER TABLE orders ADD COLUMN contact_phone TEXT`);
}

/* ---------------- sesiones ---------------- */
const qGetSession = db.prepare('SELECT * FROM sessions WHERE phone = ?');
const qSaveSession = db.prepare(`INSERT INTO sessions (phone, state, data, updated_at) VALUES (@phone, @state, @data, @updated_at)
  ON CONFLICT(phone) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`);
const qDelSession = db.prepare('DELETE FROM sessions WHERE phone = ?');

function getSession(phone) {
  const r = qGetSession.get(phone);
  return r ? { phone: r.phone, state: r.state, data: JSON.parse(r.data), updatedAt: r.updated_at } : null;
}
function saveSession(s) {
  qSaveSession.run({ phone: s.phone, state: s.state, data: JSON.stringify(s.data || {}), updated_at: Date.now() });
}
const deleteSession = (phone) => qDelSession.run(phone);

/* ---------------- pedidos ---------------- */
const qInsertOrder = db.prepare(`INSERT INTO orders
  (created_at, phone, customer, delivery, lat, lng, address, reference, contact_phone, payment, pay_with, proof_media, subtotal, shipping, total, status, source, notes)
  VALUES (@created_at, @phone, @customer, @delivery, @lat, @lng, @address, @reference, @contact_phone, @payment, @pay_with, @proof_media, @subtotal, @shipping, @total, 'nuevo', @source, @notes)`);
const qInsertItem = db.prepare(`INSERT INTO order_items (order_id, item_id, name, short, qty, unit_price, amount)
  VALUES (@order_id, @item_id, @name, @short, @qty, @unit_price, @amount)`);
const qInsertJob = db.prepare(`INSERT INTO print_jobs (order_id, created_at) VALUES (?, ?)`);

/** Guarda el pedido con sus productos y, si se pide, lo manda a la cola de impresión. Todo en una transacción. */
const createOrder = db.transaction((order, items, { print = true } = {}) => {
  const created_at = Date.now();
  const info = qInsertOrder.run({
    lat: null, lng: null, address: null, reference: null, contact_phone: null, pay_with: null, proof_media: null, notes: null,
    ...order, created_at,
  });
  const id = Number(info.lastInsertRowid);
  for (const it of items) qInsertItem.run({ ...it, order_id: id });
  if (print) qInsertJob.run(id, created_at);
  return id;
});

const qOrder = db.prepare('SELECT * FROM orders WHERE id = ?');
const qOrderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid');
function getOrder(id) {
  const o = qOrder.get(id);
  if (!o) return null;
  o.items = qOrderItems.all(id);
  return o;
}

const qSetStatus = db.prepare('UPDATE orders SET status = ? WHERE id = ?');
const setOrderStatus = (id, status) => qSetStatus.run(status, id).changes > 0;

/* ---------------- cola de impresión ---------------- */
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 5;
const qNextJob = db.prepare(`SELECT * FROM print_jobs
  WHERE (status = 'pendiente') OR (status = 'imprimiendo' AND leased_at < ?)
  ORDER BY id LIMIT 1`);
const qLease = db.prepare(`UPDATE print_jobs SET status = 'imprimiendo', leased_at = ?, attempts = attempts + 1 WHERE id = ?`);
const qDone = db.prepare(`UPDATE print_jobs SET status = 'impreso', printed_at = ?, error = NULL WHERE id = ?`);
const qFail = db.prepare(`UPDATE print_jobs SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'error' ELSE 'pendiente' END, error = ? WHERE id = ?`);
const qReprint = db.prepare(`INSERT INTO print_jobs (order_id, created_at) VALUES (?, ?)`);

/** Entrega el siguiente trabajo al agente y lo "aparta" 60 s; si el agente no confirma, se vuelve a entregar. */
const leaseNextJob = db.transaction(() => {
  const job = qNextJob.get(Date.now() - LEASE_MS);
  if (!job) return null;
  qLease.run(Date.now(), job.id);
  return job;
});
const markJobDone = (id) => qDone.run(Date.now(), id).changes > 0;
const markJobFailed = (id, err) => qFail.run(String(err || 'error').slice(0, 500), id).changes > 0;
const reprintOrder = (orderId) => Number(qReprint.run(orderId, Date.now()).lastInsertRowid);
const printQueueStatus = () => db.prepare(`SELECT status, COUNT(*) n FROM print_jobs GROUP BY status`).all();

/* ---------------- eventos y deduplicación ---------------- */
const qEvent = db.prepare('INSERT INTO events (ts, phone, type, source) VALUES (?, ?, ?, ?)');
const logEvent = (phone, type, source = 'whatsapp') => qEvent.run(Date.now(), phone, type, source);

const qSeen = db.prepare('INSERT OR IGNORE INTO processed_messages (id, ts) VALUES (?, ?)');
/** true si el mensaje es nuevo; false si ya se había procesado. */
const markMessageSeen = (id) => qSeen.run(id, Date.now()).changes > 0;
// limpieza diaria de ids viejos
setInterval(() => db.prepare('DELETE FROM processed_messages WHERE ts < ?').run(Date.now() - 3 * 864e5), 6 * 3600e3).unref();

module.exports = {
  db,
  getSession, saveSession, deleteSession,
  createOrder, getOrder, setOrderStatus,
  leaseNextJob, markJobDone, markJobFailed, reprintOrder, printQueueStatus,
  logEvent, markMessageSeen,
};
