'use strict';
/** API del panel de ventas (protegida con contraseña). */
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const { stats } = require('../stats');
const { buildTicket, toText, mapsUrl } = require('../printing/ticket');
const { agentStatus } = require('./print');
const { deliver } = require('../whatsapp/deliver');
const cloud = require('../whatsapp/cloud');
const M = require('../bot/messages');
const log = require('../log');

const router = express.Router();
router.use(express.json({ limit: '50kb' }));

/* ---------- sesión: token firmado con SESSION_SECRET, válido 12 horas ---------- */
const sign = (payload) => crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
function makeToken() {
  const payload = String(Date.now() + 12 * 3600e3);
  return payload + '.' + sign(payload);
}
function validToken(t) {
  const [payload, sig] = String(t || '').split('.');
  if (!payload || !sig) return false;
  const exp = sign(payload);
  return sig.length === exp.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp)) && +payload > Date.now();
}

const failures = new Map(); // ip -> { n, until }
router.post('/login', (req, res) => {
  const ip = req.ip;
  const f = failures.get(ip);
  if (f && f.until > Date.now()) return res.status(429).json({ error: 'Demasiados intentos. Espera un minuto.' });
  const pass = String(req.body?.password || '');
  const ok = config.panelPassword && pass.length === config.panelPassword.length
    && crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(config.panelPassword));
  if (!ok) {
    const n = (f?.n || 0) + 1;
    failures.set(ip, { n, until: n >= 5 ? Date.now() + 60e3 : 0 });
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  failures.delete(ip);
  res.json({ token: makeToken() });
});

router.use((req, res, next) => {
  const t = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.query.token;
  if (!validToken(t)) return res.status(401).json({ error: 'Sesión expirada' });
  next();
});

/* ---------- datos ---------- */
router.get('/estadisticas', (req, res) => {
  const dias = Math.min(365, Math.max(1, parseInt(req.query.dias, 10) || 30));
  res.json(stats({ dias, prueba: req.query.prueba === '1' }));
});

const ESTADOS = ['nuevo', 'preparando', 'en_camino', 'listo', 'entregado', 'cancelado'];

router.get('/pedidos', (req, res) => {
  const limite = Math.min(200, parseInt(req.query.limite, 10) || 30);
  const incl = req.query.prueba === '1' ? 1 : 0;
  const rows = db.db.prepare(`SELECT o.*, (SELECT group_concat(qty || ' ' || name, ', ') FROM order_items WHERE order_id = o.id) productos,
      (SELECT status FROM print_jobs WHERE order_id = o.id ORDER BY id DESC LIMIT 1) impresion
    FROM orders o WHERE (o.source = 'whatsapp' OR ?) ORDER BY o.id DESC LIMIT ?`).all(incl, limite);
  res.json({ pedidos: rows.map((o) => ({ ...o, mapa: mapsUrl(o) })) });
});

router.get('/pedidos/:id', (req, res) => {
  const o = db.getOrder(+req.params.id);
  if (!o) return res.status(404).json({ error: 'No existe' });
  res.json({ pedido: { ...o, mapa: mapsUrl(o) }, comanda: toText(buildTicket(o)) });
});

const AVISOS = {
  en_camino: () => '🛵 ¡Tu pedido va en camino! En unos minutos llega el repartidor.',
  listo: () => '🛍️ ¡Tu pedido está listo! Ya puedes pasar a recogerlo.',
  entregado: () => `¡Gracias por tu compra! Esperamos que lo disfrutes. 🌮❤️ — ${config.restaurant.name}`,
  cancelado: () => `Tu pedido fue cancelado. Si tienes dudas, escríbenos por aquí. — ${config.restaurant.name}`,
};

router.post('/pedidos/:id/estado', async (req, res) => {
  const estado = String(req.body?.estado || '');
  if (!ESTADOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  const o = db.getOrder(+req.params.id);
  if (!o) return res.status(404).json({ error: 'No existe' });
  db.setOrderStatus(o.id, estado);
  let aviso = null;
  if (req.body?.avisar !== false && AVISOS[estado]) {
    try {
      await deliver(o.phone, o.source, [M.text(AVISOS[estado]())]);
      aviso = 'enviado';
    } catch (e) {
      log.warn('No se pudo avisar al cliente:', e.message);
      aviso = 'error: ' + e.message;
    }
  }
  res.json({ ok: true, aviso });
});

router.post('/pedidos/:id/reimprimir', (req, res) => {
  const o = db.getOrder(+req.params.id);
  if (!o) return res.status(404).json({ error: 'No existe' });
  res.json({ ok: true, trabajo: db.reprintOrder(o.id) });
});

// Ver el comprobante de transferencia que mandó el cliente
router.get('/pedidos/:id/comprobante', async (req, res) => {
  const o = db.getOrder(+req.params.id);
  if (!o || !o.proof_media) return res.status(404).send('Sin comprobante');
  if (o.source === 'simulador') return res.redirect('/img/comprobante-ejemplo.svg');
  try {
    const { buffer, mime } = await cloud.downloadMedia(o.proof_media);
    res.set('Content-Type', mime || 'application/octet-stream').set('Cache-Control', 'private, max-age=3600').send(buffer);
  } catch (e) {
    res.status(502).send('No se pudo descargar el comprobante: ' + e.message);
  }
});

router.get('/estado', (req, res) => {
  res.json({
    whatsapp: !!(config.wa.token && config.wa.phoneNumberId),
    impresora: agentStatus(),
    cola: db.printQueueStatus(),
    restaurante: config.restaurant.name,
    simulador: config.simulator.enabled,
  });
});

module.exports = router;
