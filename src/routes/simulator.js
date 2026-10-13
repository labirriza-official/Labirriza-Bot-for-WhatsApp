'use strict';
/** API del simulador web: permite probar el bot completo sin cuenta de WhatsApp. */
const express = require('express');
const crypto = require('crypto');
const engine = require('../bot/engine');
const db = require('../db');
const { simMessagesSince } = require('../whatsapp/deliver');

const router = express.Router();
router.use(express.json({ limit: '100kb' }));

// Los teléfonos del simulador empiezan con "sim-" para no mezclarse con clientes reales.
const simPhone = (id) => 'sim-' + String(id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);

router.post('/mensaje', (req, res) => {
  const { cliente, nombre, tipo, texto, opcion, titulo, lat, lng } = req.body || {};
  if (!cliente) return res.status(400).json({ error: 'falta cliente' });
  const from = simPhone(cliente);
  const base = { id: 'sim-' + crypto.randomUUID(), from, name: (nombre || '').slice(0, 40) || null };
  let msg;
  if (tipo === 'opcion') msg = { ...base, kind: 'reply', replyId: String(opcion), replyTitle: titulo || '' };
  else if (tipo === 'ubicacion') msg = { ...base, kind: 'location', location: { lat: +lat, lng: +lng } };
  else if (tipo === 'comprobante') msg = { ...base, kind: 'media', media: { id: 'sim-comprobante', mime: 'image/jpeg', type: 'image' } };
  else msg = { ...base, kind: 'text', text: String(texto || '').slice(0, 1000) };

  const { replies, orderId } = engine.handle(msg, { source: 'simulador' });
  res.json({ replies, orderId: orderId || null });
});

// Avisos que el restaurante manda después (ej. "tu pedido va en camino")
router.get('/avisos', (req, res) => {
  const items = simMessagesSince(simPhone(req.query.cliente), +req.query.desde || 0);
  res.json({ items });
});

router.post('/reiniciar', (req, res) => {
  db.deleteSession(simPhone(req.body?.cliente));
  res.json({ ok: true });
});

module.exports = router;
