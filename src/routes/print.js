'use strict';
/**
 * API para el agente de impresión que corre en la PC del restaurante.
 * El agente pregunta cada pocos segundos si hay comandas nuevas, las imprime y avisa.
 */
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const { buildTicket, toEscPos } = require('../printing/ticket');
const log = require('../log');

const router = express.Router();
router.use(express.json({ limit: '50kb' }));

let lastAgentSeen = 0;
const agentStatus = () => ({ lastSeen: lastAgentSeen || null, online: Date.now() - lastAgentSeen < 30_000 });

router.use((req, res, next) => {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const expected = config.printAgentToken || '';
  const ok = expected && token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: 'token inválido' });
  lastAgentSeen = Date.now();
  next();
});

router.get('/siguiente', (req, res) => {
  const job = db.leaseNextJob();
  if (!job) return res.status(204).end();
  const order = db.getOrder(job.order_id);
  if (!order) { db.markJobFailed(job.id, 'pedido no encontrado'); return res.status(204).end(); }
  const bytes = toEscPos(buildTicket(order));
  res.json({ id: job.id, pedido: order.id, intento: job.attempts + 1, datos: bytes.toString('base64') });
});

router.post('/:id/listo', (req, res) => {
  db.markJobDone(+req.params.id);
  db.db.prepare(`UPDATE orders SET status = 'preparando' WHERE id = (SELECT order_id FROM print_jobs WHERE id = ?) AND status = 'nuevo'`).run(+req.params.id);
  res.json({ ok: true });
});

router.post('/:id/error', (req, res) => {
  const err = String(req.body?.error || 'error desconocido');
  log.warn(`Impresión ${req.params.id} falló: ${err}`);
  db.markJobFailed(+req.params.id, err);
  res.json({ ok: true });
});

module.exports = { router, agentStatus };
