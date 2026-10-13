'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cliente, opciones, textoDe } = require('./helpers');
const db = require('../src/db');

test('pedido completo con botones, modificación y transferencia (como en las capturas)', () => {
  const c = cliente('5212221111111', 'Carlos');
  let r = c.texto('Hola, me gustaría hacer un pedido.');
  assert.deepEqual(opciones(r), ['hacer_pedido', 'promos', 'humano']);
  assert.match(textoDe(r), /Bienvenido a \*La Birriaza\*/);

  r = c.opcion('hacer_pedido');
  assert.equal(r.replies[0].type, 'list');
  assert.ok(opciones(r).includes('item:taco_blando_queso'));
  assert.ok(opciones(r).includes('cat:bebidas'));
  assert.ok(opciones(r).length <= 10, 'WhatsApp solo admite 10 filas');

  r = c.opcion('item:taco_blando_queso');
  assert.equal(opciones(r).length, 10);
  r = c.opcion('qty:3');
  assert.match(textoDe(r), /3 × Taco blando con queso: \$75/);
  assert.match(textoDe(r), /Subtotal: \$75/);
  assert.deepEqual(opciones(r), ['agregar', 'modificar', 'continuar']);

  c.opcion('agregar');
  c.opcion('item:quesabirria');
  r = c.opcion('qty:2');
  assert.match(textoDe(r), /Subtotal: \$145/);

  c.opcion('agregar');
  r = c.opcion('cat:bebidas');
  assert.deepEqual(opciones(r), ['item:refresco', 'item:agua_embotellada', 'item:agua_dia']);
  c.opcion('item:agua_dia');
  r = c.opcion('qty:1');
  assert.match(textoDe(r), /Subtotal: \$180/);

  // Modificar: agregar una quesabirria
  r = c.opcion('modificar');
  assert.deepEqual(opciones(r), ['edit:taco_blando_queso', 'edit:quesabirria', 'edit:agua_dia']);
  r = c.opcion('edit:quesabirria');
  assert.deepEqual(opciones(r), ['sumar', 'restar', 'eliminar']);
  r = c.opcion('sumar');
  assert.match(textoDe(r), /3 × Quesabirria: \$105/);
  assert.match(textoDe(r), /Subtotal: \$215/);

  r = c.opcion('continuar');
  assert.deepEqual(opciones(r), ['recoger', 'domicilio']);
  r = c.opcion('domicilio');
  assert.equal(r.replies[0].type, 'location_request');
  r = c.ubicacion(19.9, -97.5);
  assert.deepEqual(opciones(r), ['sin_referencia']);
  r = c.texto('Casa azul frente a la farmacia');
  assert.deepEqual(opciones(r), ['mismo_numero']);
  assert.match(textoDe(r), /número le llamamos cuando el repartidor llegue/);
  assert.match(textoDe(r), /222 111 1111/);
  r = c.texto('22212');
  assert.match(textoDe(r), /no parece válido/);
  r = c.texto('+52 1 (222) 345-6789');
  assert.deepEqual(opciones(r), ['si', 'otro_nombre']);
  assert.match(textoDe(r), /nombre de \*Carlos\*/);
  r = c.opcion('si');
  assert.deepEqual(opciones(r), ['efectivo', 'transferencia']);

  r = c.opcion('transferencia');
  assert.equal(r.replies[0].type, 'image');
  assert.match(textoDe(r), /\$235/);
  assert.match(textoDe(r), /722969014746864643/);

  r = c.texto('ya pagué');
  assert.match(textoDe(r), /captura o foto del comprobante/);

  r = c.foto('media-123');
  assert.match(textoDe(r), /Comprobante recibido/);
  assert.match(textoDe(r), /Total: \$235 MXN/);
  assert.match(textoDe(r), /Referencia: Casa azul frente a la farmacia/);
  assert.match(textoDe(r), /Teléfono para avisarte: 222 345 6789/);
  assert.deepEqual(opciones(r), ['confirmar', 'modificar', 'cancelar']);

  r = c.opcion('confirmar');
  assert.ok(r.orderId);
  assert.match(textoDe(r), /confirmado, Carlos/);

  const o = db.getOrder(r.orderId);
  assert.equal(o.total, 235);
  assert.equal(o.shipping, 20);
  assert.equal(o.payment, 'transferencia');
  assert.equal(o.proof_media, 'media-123');
  assert.equal(o.lat, 19.9);
  assert.equal(o.contact_phone, '2223456789');
  assert.equal(o.items.length, 3);
  assert.equal(o.items.find((i) => i.item_id === 'quesabirria').qty, 3);

  // Se mandó a imprimir
  const job = db.leaseNextJob();
  assert.equal(job.order_id, r.orderId);
  db.markJobDone(job.id);

  // Siguiente mensaje empieza una conversación nueva
  r = c.texto('hola');
  assert.deepEqual(opciones(r), ['hacer_pedido', 'promos', 'humano']);
});

test('efectivo: billetes sugeridos, cambio y recoger en el local', () => {
  const c = cliente('5212222222222', 'Ana López');
  c.texto('hola');
  c.opcion('hacer_pedido');
  c.opcion('item:taco_blando_queso');
  c.opcion('qty:3');
  c.opcion('agregar');
  c.opcion('item:quesabirria');
  c.opcion('qty:2');
  c.opcion('agregar');
  c.opcion('cat:bebidas');
  c.opcion('item:agua_dia');
  c.opcion('qty:1'); // $180
  c.opcion('continuar');
  let r = c.opcion('recoger');
  assert.deepEqual(opciones(r), ['si', 'otro_nombre']);
  r = c.opcion('otro_nombre');
  r = c.texto('Carlos');
  r = c.opcion('efectivo');
  assert.deepEqual(opciones(r), ['exacto', 'paga:200', 'paga:500']);
  assert.match(textoDe(r), /Total a pagar: \*\$180\*/);
  r = c.opcion('paga:200');
  assert.match(textoDe(r), /Pagas con: \$200/);
  assert.match(textoDe(r), /Cambio: \$20/);
  assert.match(textoDe(r), /recoger en el local/);
  assert.doesNotMatch(textoDe(r), /Envío/);
  r = c.opcion('confirmar');
  const o = db.getOrder(r.orderId);
  assert.equal(o.customer, 'Carlos');
  assert.equal(o.delivery, 'recoger');
  assert.equal(o.total, 180);
  assert.equal(o.pay_with, 200);
  assert.equal(o.contact_phone, null); // al recoger no se pide
});

test('teléfono de contacto: acepta el mismo número de WhatsApp y varios formatos', () => {
  const { parsePhone } = require('../src/bot/engine')._internals;
  assert.equal(parsePhone('2221234567'), '2221234567');
  assert.equal(parsePhone('222 123 45 67'), '2221234567');
  assert.equal(parsePhone('+52 222 123 4567'), '2221234567');
  assert.equal(parsePhone('5212221234567'), '2221234567');
  assert.equal(parsePhone('12345'), null);
  assert.equal(parsePhone('0221234567'), null);

  const c = cliente('5212227777777', 'Rosa');
  c.texto('hola'); c.opcion('hacer_pedido'); c.opcion('item:birriamen'); c.opcion('qty:1');
  c.opcion('continuar'); c.opcion('domicilio'); c.ubicacion(19.1, -97.1); c.opcion('sin_referencia');
  let r = c.opcion('mismo_numero');
  assert.deepEqual(opciones(r), ['si', 'otro_nombre']);
  c.opcion('si'); c.opcion('efectivo');
  r = c.opcion('exacto');
  assert.match(textoDe(r), /Teléfono para avisarte: 222 777 7777/);
  r = c.opcion('confirmar');
  assert.equal(db.getOrder(r.orderId).contact_phone, '2227777777');
});

test('modificar desde el resumen regresa al resumen y recalcula el cambio', () => {
  const c = cliente('5212223333333', 'Luis');
  c.texto('hola'); c.opcion('hacer_pedido'); c.opcion('item:birriamen'); c.opcion('qty:1');
  c.opcion('continuar'); c.opcion('recoger'); c.opcion('si'); c.opcion('efectivo');
  let r = c.opcion('paga:100'); // total 95
  assert.match(textoDe(r), /Cambio: \$5/);
  r = c.opcion('modificar');
  assert.deepEqual(opciones(r), ['agregar', 'modificar', 'continuar']);
  c.opcion('agregar');
  c.opcion('item:consome');
  r = c.opcion('qty:1'); // total 120 > 100 => pide de nuevo el billete
  assert.deepEqual(opciones(r), ['exacto', 'paga:150', 'paga:200']);
  r = c.opcion('paga:200');
  assert.match(textoDe(r), /Total: \$120 MXN/);
  assert.match(textoDe(r), /Cambio: \$80/);
});

test('texto escrito se interpreta y respuestas inválidas repiten la pregunta', () => {
  const c = cliente('5212224444444', 'Mar');
  c.texto('hola');
  let r = c.texto('quiero hacer un pedido');
  assert.equal(r.replies[0].type, 'list');
  r = c.texto('quesabirria');
  assert.match(textoDe(r), /Cuántos de \*Quesabirria\*/);
  r = c.texto('2');
  assert.match(textoDe(r), /2 × Quesabirria: \$70/);
  r = c.texto('asdf');
  assert.match(textoDe(r), /Por favor elige una de las opciones/);
  assert.deepEqual(opciones(r), ['agregar', 'modificar', 'continuar']);
  r = c.texto('continuar');
  assert.deepEqual(opciones(r), ['recoger', 'domicilio']);
  r = c.texto('cancelar');
  assert.match(textoDe(r), /Pedido cancelado/);
});

test('eliminar el único producto vacía el pedido y regresa al menú', () => {
  const c = cliente('5212225555555', 'Eva');
  c.texto('hola'); c.opcion('hacer_pedido'); c.opcion('item:postre'); c.opcion('qty:1');
  c.opcion('modificar'); c.opcion('edit:postre');
  const r = c.opcion('eliminar');
  assert.match(textoDe(r), /quedó vacío/);
  assert.equal(r.replies.at(-1).type, 'list');
});

test('hablar con alguien pausa al bot', () => {
  const c = cliente('5212226666666', 'Ivan');
  c.texto('hola');
  let r = c.opcion('humano');
  assert.match(textoDe(r), /alguien del equipo/);
  r = c.texto('¿tienen estacionamiento?');
  assert.equal(r.replies.length, 0);
});

test('el embudo registra inicio, carrito y confirmación', () => {
  const rows = db.db.prepare(`SELECT type, COUNT(*) n FROM events GROUP BY type`).all();
  const m = Object.fromEntries(rows.map((x) => [x.type, x.n]));
  assert.ok(m.inicio >= 5);
  assert.ok(m.carrito >= 4);
  assert.equal(m.confirmado, 3);
});
