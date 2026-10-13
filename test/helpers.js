'use strict';
// Prepara un entorno aislado para las pruebas (base de datos temporal, sin .env real).
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'birriaza-test-'));
process.env.ENV_FILE = path.join(dir, 'no-existe.env');
process.env.DATA_DIR = dir;
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.ENVIO_COSTO = '20';
process.env.HORARIO = '';
process.env.PANEL_PASSWORD = 'secreto';
process.env.PRINT_AGENT_TOKEN = 'token-agente';
process.env.SESSION_SECRET = 'x'.repeat(32);

let n = 0;
const engine = () => require('../src/bot/engine');

/** Simula a un cliente que conversa con el bot. */
function cliente(phone = '5212220000000', name = 'Carlos') {
  const say = (msg) => engine().handle({ id: 'm' + ++n, from: phone, name, ...msg }, { source: 'whatsapp' });
  return {
    texto: (text) => say({ kind: 'text', text }),
    opcion: (replyId) => say({ kind: 'reply', replyId, replyTitle: replyId }),
    ubicacion: (lat, lng) => say({ kind: 'location', location: { lat, lng } }),
    foto: (id = 'media-1') => say({ kind: 'media', media: { id, mime: 'image/jpeg', type: 'image' } }),
  };
}

/** Ids de los botones/filas del último mensaje interactivo de la respuesta. */
function opciones(res) {
  const last = [...res.replies].reverse().find((m) => m.type === 'buttons' || m.type === 'list');
  if (!last) return [];
  if (last.type === 'buttons') return last.buttons.map((b) => b.id);
  return last.sections.flatMap((s) => s.rows.map((r) => r.id));
}

const textoDe = (res) => res.replies.map((m) => m.body || m.caption || '').join('\n---\n');

module.exports = { cliente, opciones, textoDe, dir };
