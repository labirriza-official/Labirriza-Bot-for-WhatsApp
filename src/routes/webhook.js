'use strict';
const express = require('express');
const config = require('../config');
const cloud = require('../whatsapp/cloud');
const engine = require('../bot/engine');
const db = require('../db');
const log = require('../log');

const router = express.Router();

// Meta verifica el webhook con un GET al configurarlo
router.get('/', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.wa.verifyToken && config.wa.verifyToken) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  return res.sendStatus(403);
});

// Cola por cliente: los mensajes de un mismo número se procesan en orden, uno a la vez.
const queues = new Map();
function enqueue(phone, task) {
  const prev = queues.get(phone) || Promise.resolve();
  const next = prev.then(task).catch((e) => log.error('Error procesando mensaje de', phone, e)).finally(() => {
    if (queues.get(phone) === next) queues.delete(phone);
  });
  queues.set(phone, next);
  return next;
}

router.post('/', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  const raw = req.body instanceof Buffer ? req.body : Buffer.from('');
  if (!cloud.validSignature(raw, req.get('x-hub-signature-256'))) {
    log.warn('Webhook con firma inválida rechazado');
    return res.sendStatus(401);
  }
  // Se responde de inmediato: Meta reintenta si tardamos.
  res.sendStatus(200);

  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return; }

  for (const msg of cloud.extractMessages(body)) {
    if (!db.markMessageSeen(msg.id)) continue; // duplicado
    enqueue(msg.from, async () => {
      cloud.markRead(msg.id);
      const { replies, orderId } = engine.handle(msg, { source: 'whatsapp' });
      if (orderId) log.info(`Pedido #${orderId} confirmado por ${msg.from}`);
      await cloud.send(msg.from, replies);
    });
  }
});

module.exports = router;
