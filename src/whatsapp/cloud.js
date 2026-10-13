'use strict';
/**
 * Conexión con la API oficial de WhatsApp (WhatsApp Cloud API de Meta).
 * - normalize(): convierte un mensaje del webhook al formato que entiende el motor.
 * - send(): convierte nuestros mensajes (src/bot/messages.js) al formato de Meta y los envía.
 */
const crypto = require('crypto');
const config = require('../config');

const graph = (p) => `https://graph.facebook.com/${config.wa.apiVersion}/${p}`;

/** Verifica la firma X-Hub-Signature-256 para asegurar que el webhook viene de Meta. */
function validSignature(rawBody, header) {
  if (!config.wa.appSecret) return true; // sin APP_SECRET no se valida (solo para pruebas)
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', config.wa.appSecret).update(rawBody).digest('hex');
  const got = header.slice(7);
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

/** Extrae los mensajes entrantes de un POST del webhook. Ignora estados de entrega (sent/delivered/read). */
function extractMessages(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = new Map((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages || []) out.push(normalize(m, names.get(m.from)));
    }
  }
  return out;
}

function normalize(m, name) {
  const base = { id: m.id, from: m.from, name: name || null, timestamp: +m.timestamp * 1000 };
  switch (m.type) {
    case 'text':
      return { ...base, kind: 'text', text: m.text?.body || '' };
    case 'interactive': {
      const r = m.interactive?.button_reply || m.interactive?.list_reply;
      if (r) return { ...base, kind: 'reply', replyId: r.id, replyTitle: r.title };
      return { ...base, kind: 'other' };
    }
    case 'button': // respuesta a botón de una plantilla
      return { ...base, kind: 'text', text: m.button?.text || '' };
    case 'location':
      return { ...base, kind: 'location', location: { lat: m.location.latitude, lng: m.location.longitude, name: m.location.name || null, address: m.location.address || null } };
    case 'image':
    case 'document':
      return { ...base, kind: 'media', media: { id: m[m.type].id, mime: m[m.type].mime_type, type: m.type } };
    default:
      return { ...base, kind: 'other' };
  }
}

/** Convierte un mensaje nuestro al JSON de la Cloud API. */
function toPayload(to, msg) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  const withHeaderFooter = (inter, msg2) => {
    if (msg2.header) inter.header = { type: 'text', text: msg2.header };
    if (msg2.footer) inter.footer = { text: msg2.footer };
    return inter;
  };
  switch (msg.type) {
    case 'text':
      return { ...base, type: 'text', text: { body: msg.body, preview_url: false } };
    case 'buttons':
      return {
        ...base,
        type: 'interactive',
        interactive: withHeaderFooter({
          type: 'button',
          body: { text: msg.body },
          action: { buttons: msg.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
        }, msg),
      };
    case 'list':
      return {
        ...base,
        type: 'interactive',
        interactive: withHeaderFooter({
          type: 'list',
          body: { text: msg.body },
          action: {
            button: msg.button,
            sections: msg.sections.map((s) => ({
              ...(s.title ? { title: s.title } : {}),
              rows: s.rows.map((r) => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })),
            })),
          },
        }, msg),
      };
    case 'image': {
      if (!config.publicUrl) throw new Error('Falta PUBLIC_URL para enviar imágenes');
      return { ...base, type: 'image', image: { link: config.publicUrl + msg.path, ...(msg.caption ? { caption: msg.caption } : {}) } };
    }
    case 'location_request':
      return { ...base, type: 'interactive', interactive: { type: 'location_request_message', body: { text: msg.body }, action: { name: 'send_location' } } };
    default:
      throw new Error('Tipo de mensaje desconocido: ' + msg.type);
  }
}

async function post(path, payload) {
  if (!config.wa.token || !config.wa.phoneNumberId) throw new Error('Faltan WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID');
  const res = await fetch(graph(path), {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.wa.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`WhatsApp API ${res.status}: ${txt}`);
  }
  return res.json();
}

/** Envía los mensajes en orden (uno tras otro, para que lleguen en ese orden). */
async function send(to, messages) {
  for (const m of messages) {
    await post(`${config.wa.phoneNumberId}/messages`, toPayload(to, m));
  }
}

/** Marca el mensaje como leído (palomitas azules) y muestra "escribiendo…". */
async function markRead(messageId) {
  try {
    await post(`${config.wa.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' },
    });
  } catch (e) {
    // no es crítico
  }
}

/** Descarga un archivo enviado por el cliente (comprobante). Devuelve { buffer, mime }. */
async function downloadMedia(mediaId) {
  const meta = await fetch(graph(mediaId), { headers: { Authorization: `Bearer ${config.wa.token}` } });
  if (!meta.ok) throw new Error('No se encontró el archivo ' + mediaId);
  const { url, mime_type } = await meta.json();
  const file = await fetch(url, { headers: { Authorization: `Bearer ${config.wa.token}` } });
  if (!file.ok) throw new Error('No se pudo descargar el archivo');
  return { buffer: Buffer.from(await file.arrayBuffer()), mime: mime_type };
}

module.exports = { validSignature, extractMessages, normalize, toPayload, send, markRead, downloadMedia };
