'use strict';
/**
 * Envía mensajes a un cliente por el canal correcto:
 *  - pedidos reales  -> WhatsApp Cloud API
 *  - simulador web   -> bandeja en memoria que el simulador consulta
 */
const cloud = require('./cloud');

const simInbox = new Map(); // phone -> [{ msg, ts }]

async function deliver(phone, source, messages) {
  if (!messages?.length) return;
  if (source === 'simulador') {
    const box = simInbox.get(phone) || [];
    for (const m of messages) box.push({ ts: Date.now(), msg: m });
    simInbox.set(phone, box.slice(-50));
    return;
  }
  await cloud.send(phone, messages);
}

/** Mensajes del simulador posteriores a `since` (para avisos de "tu pedido va en camino"). */
function simMessagesSince(phone, since) {
  return (simInbox.get(phone) || []).filter((x) => x.ts > since);
}

module.exports = { deliver, simMessagesSince };
