'use strict';
process.env.WHATSAPP_TOKEN = 'tok';
process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
process.env.WHATSAPP_VERIFY_TOKEN = 'verificame';
process.env.WHATSAPP_APP_SECRET = 'appsecret';
process.env.PUBLIC_URL = 'https://birriaza.example.com';
require('./helpers');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/server');
const db = require('../src/db');

// Intercepta las llamadas a la API de Meta
const realFetch = global.fetch;
const sent = [];
global.fetch = async (url, opts = {}) => {
  if (String(url).includes('graph.facebook.com')) {
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (body && !body.status) sent.push(body);
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.x' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, opts);
};

let server, base;
before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let mid = 0;

async function webhook(message, { secret = 'appsecret', name = 'Carlos' } = {}) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      contacts: [{ wa_id: '5212229999999', profile: { name } }],
      messages: [{ from: '5212229999999', id: 'wamid.' + ++mid, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
    } }] }],
  });
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  const res = await fetch(base + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body });
  await wait(60);
  return res;
}
const reply = (id) => ({ type: 'interactive', interactive: { type: id.startsWith('item:') || id.startsWith('qty:') || id.startsWith('cat:') ? 'list_reply' : 'button_reply', [id.startsWith('item:') || id.startsWith('qty:') || id.startsWith('cat:') ? 'list_reply' : 'button_reply']: { id, title: id } } });

test('verificación del webhook de Meta', async () => {
  let r = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verificame&hub.challenge=12345`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '12345');
  r = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1`);
  assert.equal(r.status, 403);
});

test('rechaza mensajes con firma falsa', async () => {
  const r = await webhook({ type: 'text', text: { body: 'hola' } }, { secret: 'falso' });
  assert.equal(r.status, 401);
  assert.equal(sent.length, 0);
});

test('pedido completo por el webhook genera los mensajes correctos para Meta', async () => {
  await webhook({ type: 'text', text: { body: 'Hola, me gustaría hacer un pedido.' } });
  let m = sent.at(-1);
  assert.equal(m.to, '5212229999999');
  assert.equal(m.type, 'interactive');
  assert.equal(m.interactive.type, 'button');
  assert.equal(m.interactive.action.buttons.length, 3);
  assert.ok(m.interactive.action.buttons.every((b) => b.reply.title.length <= 20));

  await webhook(reply('hacer_pedido'));
  m = sent.at(-1);
  assert.equal(m.interactive.type, 'list');
  const rows = m.interactive.action.sections.flatMap((s) => s.rows);
  assert.ok(rows.length <= 10);
  assert.ok(rows.every((r) => r.title.length <= 24));

  await webhook(reply('item:birriamen'));
  await webhook(reply('qty:2'));
  await webhook(reply('continuar'));
  await webhook(reply('domicilio'));
  m = sent.at(-1);
  assert.equal(m.interactive.type, 'location_request_message');
  await webhook({ type: 'location', location: { latitude: 19.88, longitude: -97.49, name: 'Casa', address: 'Calle Hidalgo 25' } });
  await webhook(reply('sin_referencia'));
  m = sent.at(-1);
  assert.equal(m.interactive.action.buttons[0].reply.id, 'mismo_numero');
  await webhook({ type: 'text', text: { body: '222 555 0101' } });
  await webhook(reply('si'));
  await webhook(reply('transferencia'));
  const img = sent.find((x) => x.type === 'image');
  assert.equal(img.image.link, 'https://birriaza.example.com/img/datos-pago.jpg');
  await webhook({ type: 'image', image: { id: 'MEDIA42', mime_type: 'image/jpeg' } });
  await webhook(reply('confirmar'));
  m = sent.at(-1);
  assert.match(m.text.body, /confirmado, Carlos/);

  const o = db.db.prepare(`SELECT * FROM orders ORDER BY id DESC LIMIT 1`).get();
  assert.equal(o.total, 210);
  assert.equal(o.proof_media, 'MEDIA42');
  assert.equal(o.address, 'Casa, Calle Hidalgo 25');
});

test('mensajes duplicados de Meta no se procesan dos veces', async () => {
  const before = sent.length;
  const msg = { type: 'text', text: { body: 'hola' } };
  const id = 'wamid.dup';
  const mk = () => JSON.stringify({ entry: [{ changes: [{ value: { contacts: [], messages: [{ from: '5210000000001', id, timestamp: '1', ...msg }] } }] }] });
  for (let i = 0; i < 2; i++) {
    const body = mk();
    await fetch(base + '/webhook', { method: 'POST', headers: { 'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', 'appsecret').update(body).digest('hex') }, body });
  }
  await wait(80);
  assert.equal(sent.length - before, 1);
});

test('agente de impresión: requiere token, recibe ESC/POS y confirma', async () => {
  let r = await fetch(base + '/api/impresion/siguiente');
  assert.equal(r.status, 401);
  const h = { Authorization: 'Bearer token-agente', 'Content-Type': 'application/json' };
  r = await fetch(base + '/api/impresion/siguiente', { headers: h });
  assert.equal(r.status, 200);
  const job = await r.json();
  const bytes = Buffer.from(job.datos, 'base64');
  assert.equal(bytes[0], 0x1b); // ESC @
  assert.ok(bytes.includes(Buffer.from('BIRRIAMEN')));
  assert.ok(bytes.includes(Buffer.from('maps.google.com/?q=19.880000,-97.490000&t=k')));
  assert.ok(bytes.includes(Buffer.from('222 555 0101')));
  assert.ok(bytes.includes(Buffer.from('LLAMAR AL LLEGAR')));
  // Mientras no confirme, no se entrega otra vez
  r = await fetch(base + '/api/impresion/siguiente', { headers: h });
  assert.equal(r.status, 204);
  r = await fetch(`${base}/api/impresion/${job.id}/listo`, { method: 'POST', headers: h });
  assert.equal(r.status, 200);
  const o = db.getOrder(job.pedido);
  assert.equal(o.status, 'preparando');
});

test('panel: login, estadísticas, detalle y cambio de estado con aviso al cliente', async () => {
  let r = await fetch(base + '/api/panel/estadisticas');
  assert.equal(r.status, 401);
  r = await fetch(base + '/api/panel/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'mal' }) });
  assert.equal(r.status, 401);
  r = await fetch(base + '/api/panel/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'secreto' }) });
  const { token } = await r.json();
  const h = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

  const s = await (await fetch(base + '/api/panel/estadisticas?dias=7', { headers: h })).json();
  assert.equal(s.kpis.pedidos, 1);
  assert.equal(s.kpis.ventas, 210);
  assert.equal(s.serie.length, 7);
  assert.equal(s.serie.at(-1).valor, 210);
  assert.equal(s.productos[0].item_id, 'birriamen');
  assert.equal(s.embudo.confirmado, 1);

  const hoy = await (await fetch(base + '/api/panel/estadisticas?dias=1', { headers: h })).json();
  assert.equal(hoy.serie.length, 24);
  assert.equal(hoy.kpis.ventas, 210);

  const { pedidos } = await (await fetch(base + '/api/panel/pedidos', { headers: h })).json();
  const id = pedidos[0].id;
  const det = await (await fetch(`${base}/api/panel/pedidos/${id}`, { headers: h })).json();
  assert.match(det.comanda, /COMANDA DE COCINA/);
  assert.match(det.comanda, /BIRRIAMEN/);

  const before = sent.length;
  r = await fetch(`${base}/api/panel/pedidos/${id}/estado`, { method: 'POST', headers: h, body: JSON.stringify({ estado: 'en_camino' }) });
  const j = await r.json();
  assert.equal(j.aviso, 'enviado');
  assert.match(sent[before].text.body, /va en camino/);

  r = await fetch(`${base}/api/panel/pedidos/${id}/reimprimir`, { method: 'POST', headers: h });
  assert.equal(r.status, 200);
});

test('simulador: conversación y pedido marcado como prueba', async () => {
  const say = async (b) => (await fetch(base + '/api/simulador/mensaje', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cliente: 'abc', nombre: 'Prueba', ...b }) })).json();
  await say({ tipo: 'texto', texto: 'hola' });
  await say({ tipo: 'opcion', opcion: 'hacer_pedido' });
  await say({ tipo: 'opcion', opcion: 'item:quesabirria' });
  await say({ tipo: 'opcion', opcion: 'qty:1' });
  await say({ tipo: 'opcion', opcion: 'continuar' });
  await say({ tipo: 'opcion', opcion: 'recoger' });
  await say({ tipo: 'opcion', opcion: 'si' });
  await say({ tipo: 'opcion', opcion: 'transferencia' });
  await say({ tipo: 'comprobante' });
  const r = await say({ tipo: 'opcion', opcion: 'confirmar' });
  assert.ok(r.orderId);
  assert.equal(db.getOrder(r.orderId).source, 'simulador');
  // las estadísticas sin pruebas no lo cuentan
  const { token } = await (await fetch(base + '/api/panel/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'secreto' }) })).json();
  const s = await (await fetch(base + '/api/panel/estadisticas?dias=1', { headers: { Authorization: 'Bearer ' + token } })).json();
  assert.equal(s.kpis.pedidos, 1);
  const s2 = await (await fetch(base + '/api/panel/estadisticas?dias=1&prueba=1', { headers: { Authorization: 'Bearer ' + token } })).json();
  assert.equal(s2.kpis.pedidos, 2);
});
