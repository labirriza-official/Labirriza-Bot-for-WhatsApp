'use strict';
/**
 * Motor de conversación del bot de pedidos.
 *
 * Recibe un mensaje ya normalizado (ver normalize en src/whatsapp/cloud.js) y devuelve
 * la lista de mensajes que hay que contestar. No sabe nada de WhatsApp: el mismo motor
 * lo usan el webhook de Meta y el simulador web.
 *
 * Mensaje de entrada:
 *   { from, name, kind: 'text'|'reply'|'location'|'media'|'other',
 *     text, replyId, replyTitle, location: {lat, lng, name, address}, media: {id, mime} }
 */
const config = require('../config');
const menu = require('../menu');
const db = require('../db');
const M = require('./messages');
const { money, cartLines, subtotal, shippingFor, cashOptions } = require('./pricing');

const MAX_QTY = 10;

/* ---------------------------------------------------------------- utilidades */

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9$ ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Lo que el cliente eligió: id del botón/fila, o si escribió, el texto (para intentar empatarlo). */
function choice(msg) {
  if (msg.kind === 'reply') return { id: msg.replyId, typed: null };
  if (msg.kind === 'text') return { id: null, typed: norm(msg.text) };
  return { id: null, typed: null };
}

/** Empata texto escrito contra opciones {id, title, alias[]}. Devuelve el id o null. */
function match(c, options) {
  if (c.id) return options.some((o) => o.id === c.id) ? c.id : null;
  if (!c.typed) return null;
  for (const o of options) {
    const keys = [o.title, ...(o.alias || [])].map(norm);
    if (keys.includes(c.typed)) return o.id;
  }
  for (const o of options) {
    const keys = [o.title, ...(o.alias || [])].map(norm).filter((k) => k.length >= 4);
    if (keys.some((k) => c.typed.includes(k))) return o.id;
  }
  return null;
}

function nowMinutesInTz(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: config.tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const h = +parts.find((p) => p.type === 'hour').value;
  const m = +parts.find((p) => p.type === 'minute').value;
  return (h % 24) * 60 + m;
}

function isOpen(date) {
  const h = config.restaurant.horario;
  if (!h) return true;
  const t = nowMinutesInTz(date);
  return h.abre <= h.cierra ? t >= h.abre && t < h.cierra : t >= h.abre || t < h.cierra;
}

/**
 * Agrega una nota al inicio del primer mensaje en lugar de mandar un mensaje aparte.
 * Desde octubre de 2026 Meta cobra cada mensaje de servicio, así que se mandan los menos posibles.
 */
function withNote(note, out) {
  if (!note) return out;
  const [first, ...rest] = out;
  if (first && (first.type === 'buttons' || first.type === 'list' || first.type === 'location_request' || first.type === 'text')) {
    const body = note + '\n\n' + first.body;
    if (first.type === 'text' || body.length <= 1024) return [{ ...first, body }, ...rest];
  }
  if (first && first.type === 'image' && ((first.caption || '').length + note.length) < 1000) {
    return [{ ...first, caption: note + '\n\n' + (first.caption || '') }, ...rest];
  }
  return [M.text(note), ...out];
}

/** Número de WhatsApp del cliente a 10 dígitos (null en el simulador). */
function whatsappNumber(phone) {
  if (!phone || phone.startsWith('sim-')) return null;
  return parsePhone(phone);
}

/** Acepta 2221234567, 222 123 4567, +52 1 222 123 4567, etc. Devuelve 10 dígitos o null. */
function parsePhone(text) {
  let d = String(text || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('521')) d = d.slice(3);
  else if (d.length === 12 && d.startsWith('52')) d = d.slice(2);
  return /^[1-9]\d{9}$/.test(d) ? d : null;
}

const fmtPhone = (d) => `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;

function cartText(cart) {
  return cartLines(cart).map((l) => `• ${l.qty} × ${l.name}: ${money(l.amount)}`).join('\n');
}

const B = {
  hacer: { id: 'hacer_pedido', title: 'Hacer pedido', alias: ['pedido', 'ordenar', 'pedir'] },
  promos: { id: 'promos', title: 'Ver promociones', alias: ['promociones', 'promos'] },
  humano: { id: 'humano', title: 'Hablar con alguien', alias: ['persona', 'asesor', 'humano'] },
  agregar: { id: 'agregar', title: 'Agregar más', alias: ['agregar', 'mas', 'otro'] },
  modificar: { id: 'modificar', title: 'Modificar pedido', alias: ['modificar', 'cambiar', 'editar'] },
  continuar: { id: 'continuar', title: 'Continuar', alias: ['seguir', 'listo', 'eso es todo', 'es todo'] },
  recoger: { id: 'recoger', title: 'Recoger en el local', alias: ['recoger', 'paso por el', 'para llevar'] },
  domicilio: { id: 'domicilio', title: 'Entrega a domicilio', alias: ['domicilio', 'a domicilio', 'envio', 'a mi casa'] },
  si: { id: 'si', title: 'Sí', alias: ['si', 'correcto', 'ok'] },
  otroNombre: { id: 'otro_nombre', title: 'Otro nombre', alias: ['otro', 'no'] },
  efectivo: { id: 'efectivo', title: 'Efectivo', alias: ['efectivo', 'cash'] },
  transferencia: { id: 'transferencia', title: 'Transferencia', alias: ['transferencia', 'transfer', 'deposito', 'spei'] },
  exacto: { id: 'exacto', title: 'Monto exacto', alias: ['exacto', 'cambio no', 'sin cambio'] },
  confirmar: { id: 'confirmar', title: 'Confirmar pedido', alias: ['confirmar', 'confirmo', 'si confirmo'] },
  cancelar: { id: 'cancelar', title: 'Cancelar', alias: ['cancelar'] },
  mismoNumero: { id: 'mismo_numero', title: 'Este mismo número', alias: ['este mismo', 'este numero', 'el mismo', 'mismo', 'si'] },
  sinRef: { id: 'sin_referencia', title: 'Sin referencia', alias: ['sin referencia', 'ninguna', 'no'] },
  sumar: { id: 'sumar', title: 'Agregar una', alias: ['agregar una', 'mas una', 'sumar'] },
  restar: { id: 'restar', title: 'Quitar una', alias: ['quitar una', 'menos una', 'restar'] },
  eliminar: { id: 'eliminar', title: 'Eliminar', alias: ['eliminar', 'borrar', 'quitar todo'] },
};

/* ---------------------------------------------------------------- pantallas (lo que el bot pregunta en cada estado) */

const prompts = {
  bienvenida(s, { first } = {}) {
    const saludo = first
      ? `¡Hola${s.data.profileName ? ' ' + s.data.profileName.split(' ')[0] : ''}! 👋 Bienvenido a *${config.restaurant.name}* 🌮😋\nArma tu pedido tocando las opciones, sin escribir nada. ¿Qué deseas hacer?`
      : '¿Qué deseas hacer?';
    return [M.buttons(saludo, [B.hacer, B.promos, B.humano])];
  },

  menu(s) {
    const body = s.data.cart?.length ? 'Elige otro platillo 😋' : `*Menú ${config.restaurant.name}* 🌮\nToca *Ver menú* y elige un platillo.`;
    return [M.list(body, 'Ver menú', menuSections())];
  },

  submenu(s) {
    const cat = menu.categoria(s.data.cat);
    return [M.list(`¿Qué ${cat.nombre.toLowerCase()} se te antoja?`, `Ver ${cat.nombre.toLowerCase()}`, [{
      title: cat.nombre,
      rows: cat.productos.map((p) => ({ id: 'item:' + p.id, title: p.nombre, description: money(p.precio) })),
    }])];
  },

  cantidad(s) {
    const p = menu.producto(s.data.pending);
    return [M.list(`¿Cuántos de *${p.nombre}* quieres? (${money(p.precio)} c/u)`, 'Elegir cantidad', [{
      title: 'Cantidad',
      rows: Array.from({ length: MAX_QTY }, (_, i) => ({ id: 'qty:' + (i + 1), title: String(i + 1), description: money(p.precio * (i + 1)) })),
    }])];
  },

  carrito(s, { titulo = 'Agregado ✅' } = {}) {
    return [M.buttons(`${titulo}\n${cartText(s.data.cart)}\n\n*Subtotal: ${money(subtotal(s.data.cart))}*\n¿Qué deseas hacer?`, [B.agregar, B.modificar, B.continuar])];
  },

  editar_elegir(s) {
    return [M.list('¿Qué producto quieres modificar?', 'Ver mi pedido', [{
      title: 'Tu pedido',
      rows: cartLines(s.data.cart).map((l) => ({ id: 'edit:' + l.id, title: l.name, description: `Cantidad: ${l.qty} · ${money(l.amount)}` })),
    }])];
  },

  editar_accion(s) {
    const l = cartLines(s.data.cart).find((x) => x.id === s.data.editing);
    return [M.buttons(`Tienes *${l.qty} × ${l.name}*. ¿Qué deseas hacer?`, [B.sumar, B.restar, B.eliminar])];
  },

  entrega(s, { nota } = {}) {
    return [M.buttons((nota ? nota + '\n\n' : '') + '¿Cómo quieres recibir tu pedido?', [B.recoger, B.domicilio])];
  },

  ubicacion() {
    return [M.locationRequest('¡Perfecto! 🛵 Toca *Enviar ubicación* para compartir dónde te entregamos y que el repartidor llegue sin problema.\n\nSi prefieres, también puedes escribir tu dirección.')];
  },

  telefono(s) {
    const wa = whatsappNumber(s.phone);
    const pregunta = '📞 ¿A qué número le llamamos cuando el repartidor llegue a tu ubicación?';
    if (wa) return [M.buttons(`${pregunta}\n\nToca *Este mismo número* para usar el ${fmtPhone(wa)} o escribe otro número a 10 dígitos.`, [B.mismoNumero])];
    return [M.text(`${pregunta}\n\nEscríbelo a 10 dígitos (ejemplo: 2221234567).`)];
  },

  referencia() {
    return [M.buttons('¿Alguna referencia para el repartidor? (color de la casa, entre qué calles, etc.)\nEscríbela o toca *Sin referencia*.', [B.sinRef])];
  },

  nombre(s) {
    if (s.data.profileName) return [M.buttons(`¿El pedido va a nombre de *${s.data.profileName}*?`, [B.si, B.otroNombre])];
    return [M.text('¿A nombre de quién va el pedido?')];
  },

  nombre_escribir() {
    return [M.text('Escribe el nombre de la persona que recibe el pedido 🙂')];
  },

  pago() {
    return [M.buttons('¿Cómo vas a pagar?', [B.efectivo, B.transferencia])];
  },

  efectivo_monto(s) {
    const t = totals(s);
    const opts = cashOptions(t.total).map((v) => ({ id: 'paga:' + v, title: money(v) }));
    const envio = t.shipping ? ` (incluye ${money(t.shipping)} de envío)` : '';
    return [M.buttons(`Total a pagar: *${money(t.total)}*${envio}.\n¿Con cuánto vas a pagar para llevarte tu cambio? 💵`, [B.exacto, ...opts])];
  },

  esperando_comprobante(s) {
    const t = totals(s);
    const p = config.pago;
    const envio = t.shipping ? ` (incluye ${money(t.shipping)} de envío)` : '';
    return [
      M.image('/img/datos-pago.jpg', `Total a pagar: *${money(t.total)}*${envio}.\n\nRealiza tu transferencia a:\n*Banco:* ${p.banco}\n*Nombre:* ${p.titular}\n*CLABE:* ${p.clabe}\n\nCuando la hagas, envíanos la *captura de tu comprobante* aquí mismo. 📲`),
    ];
  },

  resumen(s) {
    const t = totals(s);
    const d = s.data;
    const lines = [`*PEDIDO – ${config.restaurant.name}*`, `Cliente: ${d.customer}`];
    if (d.delivery === 'domicilio') {
      lines.push('Entrega: a domicilio ' + (d.location ? '(ubicación compartida)' : ''));
      if (d.address) lines.push('Dirección: ' + d.address);
      if (d.reference) lines.push('Referencia: ' + d.reference);
      if (d.contactPhone) lines.push('Teléfono para avisarte: ' + fmtPhone(d.contactPhone));
    } else {
      lines.push('Entrega: recoger en el local');
    }
    lines.push('', cartText(d.cart), '', `Subtotal: ${money(t.subtotal)}`);
    if (d.delivery === 'domicilio') lines.push(`Envío: ${money(t.shipping)}`);
    lines.push(`*Total: ${money(t.total)} MXN*`);
    if (d.payment === 'efectivo') {
      lines.push('Pago: efectivo');
      if (d.payWith && d.payWith > t.total) lines.push(`Pagas con: ${money(d.payWith)}`, `Cambio: ${money(d.payWith - t.total)}`);
      else lines.push('Pagas con: monto exacto');
    } else {
      lines.push('Pago: transferencia', 'Comprobante: recibido ✅');
    }
    return [M.buttons('Este es el resumen de tu pedido:\n\n' + lines.join('\n'), [B.confirmar, B.modificar, B.cancelar])];
  },
};

function menuSections() {
  const sections = [];
  let rows = 0;
  for (const cat of menu.categorias()) {
    if (cat.agrupar) {
      sections.push({ title: cat.nombre, rows: [{ id: 'cat:' + cat.id, title: cat.nombre, description: cat.descripcion || 'Ver opciones' }] });
      rows += 1;
    } else {
      sections.push({ title: cat.nombre, rows: cat.productos.map((p) => ({ id: 'item:' + p.id, title: p.nombre, description: money(p.precio) })) });
      rows += cat.productos.length;
    }
  }
  if (rows <= 10) return sections;
  // Si el menú crece a más de 10 opciones, se muestran solo las categorías y cada una abre su lista.
  return [{ title: 'Categorías', rows: menu.categorias().slice(0, 10).map((c) => ({ id: 'cat:' + c.id, title: c.nombre, description: c.descripcion || `${c.productos.length} opciones` })) }];
}

function totals(s) {
  const sub = subtotal(s.data.cart);
  const shipping = s.data.delivery === 'domicilio' ? (s.data.shipping ?? config.envio.costo) : 0;
  return { subtotal: sub, shipping, total: sub + shipping };
}

/* ---------------------------------------------------------------- transiciones */

/** Cada manejador recibe (sesión, mensaje, choice) y devuelve { to, out } o null si la respuesta no es válida. */
const handlers = {
  bienvenida(s, msg, c) {
    const id = match(c, [B.hacer, B.promos, B.humano]);
    if (id === 'hacer_pedido') return go(s, 'menu');
    if (id === 'promos') {
      const promos = config.promociones || 'Por ahora no tenemos promociones activas, ¡pero todo está delicioso! 😋';
      return { to: 'bienvenida', out: [M.buttons(`🔥 *Promociones*\n${promos}`, [B.hacer, B.humano])] };
    }
    if (id === 'humano') {
      s.data.pauseUntil = Date.now() + config.humanPauseMin * 60e3;
      const tel = config.restaurant.telefono ? `\nTambién puedes llamarnos al ${config.restaurant.telefono}.` : '';
      return { to: 'humano', out: [M.text(`Listo, en un momento alguien del equipo te atiende por este chat. 🙌${tel}`)] };
    }
    // Atajo: si escribe directamente "quiero hacer un pedido", lo tomamos como "Hacer pedido".
    if (c.typed && /pedido|ordenar|pedir|menu/.test(c.typed)) return go(s, 'menu');
    return null;
  },

  menu(s, msg, c) {
    const id = c.id || matchMenuTyped(c.typed);
    if (!id) return null;
    if (id.startsWith('cat:')) {
      const cat = menu.categoria(id.slice(4));
      if (!cat) return null;
      s.data.cat = cat.id;
      return go(s, 'submenu');
    }
    if (id.startsWith('item:') && menu.producto(id.slice(5))) {
      s.data.pending = id.slice(5);
      return go(s, 'cantidad');
    }
    return null;
  },

  submenu(s, msg, c) {
    return handlers.menu(s, msg, c);
  },

  cantidad(s, msg, c) {
    let qty = null;
    if (c.id && c.id.startsWith('qty:')) qty = +c.id.slice(4);
    else if (c.typed && /^\d{1,2}$/.test(c.typed)) qty = +c.typed;
    if (!qty || qty < 1 || qty > 50) return null;
    s.data.cart = s.data.cart || [];
    const line = s.data.cart.find((l) => l.id === s.data.pending);
    if (line) line.qty += qty; else s.data.cart.push({ id: s.data.pending, qty });
    delete s.data.pending;
    if (!s.data.loggedCart) { db.logEvent(s.phone, 'carrito', s.data.source); s.data.loggedCart = true; }
    return afterCartChange(s, 'Agregado ✅');
  },

  carrito(s, msg, c) {
    const id = match(c, [B.agregar, B.modificar, B.continuar]);
    if (id === 'agregar') return go(s, 'menu');
    if (id === 'modificar') return go(s, 'editar_elegir');
    if (id === 'continuar') return s.data.inCheckout && s.data.payment ? backToSummary(s, null) : go(s, 'entrega');
    return null;
  },

  editar_elegir(s, msg, c) {
    let id = c.id && c.id.startsWith('edit:') ? c.id.slice(5) : null;
    if (!id && c.typed) id = cartLines(s.data.cart).find((l) => norm(l.name) === c.typed)?.id;
    if (!id || !s.data.cart.some((l) => l.id === id)) return null;
    s.data.editing = id;
    return go(s, 'editar_accion');
  },

  editar_accion(s, msg, c) {
    const id = match(c, [B.sumar, B.restar, B.eliminar]);
    const line = s.data.cart.find((l) => l.id === s.data.editing);
    if (!id || !line) return null;
    if (id === 'sumar') line.qty += 1;
    if (id === 'restar') line.qty -= 1;
    if (id === 'eliminar' || line.qty <= 0) s.data.cart = s.data.cart.filter((l) => l !== line);
    delete s.data.editing;
    if (!s.data.cart.length) {
      return { to: 'menu', out: withNote('Tu pedido quedó vacío.', prompts.menu(s)) };
    }
    return afterCartChange(s, 'Pedido actualizado ✅');
  },

  entrega(s, msg, c) {
    const id = match(c, [B.recoger, B.domicilio]);
    if (id === 'recoger') {
      s.data.delivery = 'recoger';
      s.data.shipping = 0;
      delete s.data.location; delete s.data.address; delete s.data.reference; delete s.data.contactPhone;
      return nextAfterDelivery(s);
    }
    if (id === 'domicilio') {
      s.data.delivery = 'domicilio';
      return go(s, 'ubicacion');
    }
    return null;
  },

  ubicacion(s, msg) {
    if (msg.kind === 'location' && msg.location) {
      const loc = { lat: msg.location.lat, lng: msg.location.lng };
      const env = shippingFor(loc);
      if (env.fuera) {
        s.data.delivery = null;
        return {
          to: 'entrega',
          out: prompts.entrega(s, { nota: `😔 Tu ubicación está a ${env.km.toFixed(1)} km y queda fuera de nuestra zona de entrega. Puedes pasar a recogerlo al local.` }),
        };
      }
      s.data.location = loc;
      s.data.shipping = env.costo;
      if (msg.location.address || msg.location.name) s.data.address = [msg.location.name, msg.location.address].filter(Boolean).join(', ');
      return go(s, 'referencia');
    }
    if (msg.kind === 'text' && msg.text && msg.text.trim().length >= 6) {
      s.data.address = msg.text.trim().slice(0, 200);
      s.data.location = null;
      s.data.shipping = config.envio.costo;
      return go(s, 'referencia');
    }
    return null;
  },

  referencia(s, msg, c) {
    if (match(c, [B.sinRef]) === 'sin_referencia') { s.data.reference = null; return nextAfterDelivery(s); }
    if (msg.kind === 'text' && msg.text && msg.text.trim()) {
      s.data.reference = msg.text.trim().slice(0, 200);
      return nextAfterDelivery(s);
    }
    return null;
  },

  telefono(s, msg, c) {
    const wa = whatsappNumber(s.phone);
    if (wa && match(c, [B.mismoNumero]) === 'mismo_numero') {
      s.data.contactPhone = wa;
      return nextAfterPhone(s);
    }
    if (msg.kind === 'text') {
      const tel = parsePhone(msg.text);
      if (!tel) return { to: 'telefono', out: withNote('Ese número no parece válido. Debe tener 10 dígitos.', prompts.telefono(s)) };
      s.data.contactPhone = tel;
      return nextAfterPhone(s);
    }
    return null;
  },

  nombre(s, msg, c) {
    if (!s.data.profileName) return handlers.nombre_escribir(s, msg);
    const id = match(c, [B.si, B.otroNombre]);
    if (id === 'si') { s.data.customer = s.data.profileName; return nextAfterName(s); }
    if (id === 'otro_nombre') return go(s, 'nombre_escribir');
    return null;
  },

  nombre_escribir(s, msg) {
    const t = msg.kind === 'text' ? (msg.text || '').trim() : '';
    if (t.length < 2 || t.length > 60) return null;
    s.data.customer = t;
    return nextAfterName(s);
  },

  pago(s, msg, c) {
    const id = match(c, [B.efectivo, B.transferencia]);
    if (id === 'efectivo') { s.data.payment = 'efectivo'; delete s.data.proof; return go(s, 'efectivo_monto'); }
    if (id === 'transferencia') { s.data.payment = 'transferencia'; delete s.data.payWith; return go(s, 'esperando_comprobante'); }
    return null;
  },

  efectivo_monto(s, msg, c) {
    const total = totals(s).total;
    if (c.id === 'exacto' || match(c, [B.exacto]) === 'exacto') { s.data.payWith = null; return go(s, 'resumen'); }
    let v = null;
    if (c.id && c.id.startsWith('paga:')) v = +c.id.slice(5);
    else if (c.typed) { const m = /\$?\s*(\d{2,5})/.exec(c.typed); if (m) v = +m[1]; }
    if (!v) return null;
    if (v < total) return { to: 'efectivo_monto', out: withNote(`Ese monto es menor al total (${money(total)}).`, prompts.efectivo_monto(s)) };
    s.data.payWith = v > total ? v : null;
    return go(s, 'resumen');
  },

  esperando_comprobante(s, msg) {
    if (msg.kind === 'media' && msg.media) {
      s.data.proof = msg.media.id;
      return { to: 'resumen', out: withNote('¡Comprobante recibido! ✅', prompts.resumen(s)) };
    }
    if (msg.kind === 'text') {
      return { to: 'esperando_comprobante', out: [M.text('Para continuar necesitamos la *captura o foto del comprobante* de tu transferencia 📲. Si prefieres pagar en efectivo, escribe *efectivo*.')] };
    }
    return null;
  },

  resumen(s, msg, c) {
    const id = match(c, [B.confirmar, B.modificar, B.cancelar]);
    if (id === 'confirmar') return confirmOrder(s);
    if (id === 'modificar') { s.data.inCheckout = true; return go(s, 'carrito', { titulo: 'Tu pedido actual:' }); }
    if (id === 'cancelar') return cancel(s);
    return null;
  },
};

// Permite cambiar a efectivo escribiendo "efectivo" mientras espera el comprobante.
const originalEsperando = handlers.esperando_comprobante;
handlers.esperando_comprobante = (s, msg, c) => {
  if (c.typed && /^efectivo/.test(c.typed)) { s.data.payment = 'efectivo'; return go(s, 'efectivo_monto'); }
  return originalEsperando(s, msg, c);
};

function matchMenuTyped(typed) {
  if (!typed) return null;
  for (const cat of menu.categorias()) {
    if (cat.agrupar && norm(cat.nombre) === typed) return 'cat:' + cat.id;
    for (const p of cat.productos) if (norm(p.nombre) === typed) return 'item:' + p.id;
  }
  return null;
}

function go(s, to, opts) {
  return { to, out: prompts[to](s, opts) };
}

function afterCartChange(s, titulo) {
  // Si el cliente ya había llegado al resumen y está modificando, regresa directo al resumen.
  if (s.data.inCheckout && s.data.payment) return backToSummary(s, titulo);
  return { to: 'carrito', out: prompts.carrito(s, { titulo }) };
}

function backToSummary(s, titulo) {
  {
    const t = totals(s);
    if (s.data.payment === 'efectivo' && s.data.payWith && s.data.payWith < t.total) {
      return { to: 'efectivo_monto', out: withNote([titulo, `Tu total cambió a ${money(t.total)}.`].filter(Boolean).join('\n'), prompts.efectivo_monto(s)) };
    }
    if (s.data.payment === 'transferencia') {
      // El comprobante ya no cubre el nuevo total: se pide de nuevo solo si el total subió.
      if (t.total > (s.data.proofTotal ?? t.total)) {
        delete s.data.proof;
        return { to: 'esperando_comprobante', out: withNote([titulo, `Tu total subió a ${money(t.total)}; envíanos el comprobante por el total nuevo.`].filter(Boolean).join('\n'), prompts.esperando_comprobante(s)) };
      }
    }
    return { to: 'resumen', out: withNote(titulo, prompts.resumen(s)) };
  }
}

function nextAfterDelivery(s) {
  if (s.data.delivery === 'domicilio' && !s.data.contactPhone) return go(s, 'telefono');
  return nextAfterPhone(s);
}

function nextAfterPhone(s) {
  if (s.data.customer) return nextAfterName(s);
  return go(s, 'nombre');
}

function nextAfterName(s) {
  return go(s, 'pago');
}

function confirmOrder(s) {
  const d = s.data;
  const lines = cartLines(d.cart);
  const t = totals(s);
  const print = d.source !== 'simulador' || config.simulator.prints;
  const orderId = db.createOrder({
    phone: s.phone,
    customer: d.customer,
    delivery: d.delivery,
    lat: d.location?.lat ?? null,
    lng: d.location?.lng ?? null,
    address: d.address || null,
    reference: d.reference || null,
    contact_phone: d.delivery === 'domicilio' ? d.contactPhone || null : null,
    payment: d.payment,
    pay_with: d.payment === 'efectivo' ? d.payWith || null : null,
    proof_media: d.payment === 'transferencia' ? d.proof || null : null,
    subtotal: t.subtotal,
    shipping: t.shipping,
    total: t.total,
    source: d.source || 'whatsapp',
  }, lines.map((l) => ({ item_id: l.id, name: l.name, short: l.short, qty: l.qty, unit_price: l.unit, amount: l.amount })), { print });
  db.logEvent(s.phone, 'confirmado', d.source);
  const folio = String(orderId).padStart(4, '0');
  const entrega = d.delivery === 'domicilio'
    ? 'Ya lo estamos preparando y en breve sale hacia tu domicilio. 🛵'
    : 'Ya lo estamos preparando; te avisamos por aquí cuando esté listo para recoger. 🛍️';
  return {
    to: 'fin',
    orderId,
    out: [M.text(`¡Pedido *#${folio}* confirmado, ${d.customer.split(' ')[0]}! 🎉 ${entrega}\n\n¡Gracias por elegir ${config.restaurant.name}! 🌮❤️`)],
  };
}

function cancel(s) {
  return { to: 'fin', out: [M.text('Pedido cancelado. Cuando quieras volver a pedir, solo escríbenos. 👋')] };
}

/* ---------------------------------------------------------------- entrada principal */

const RESET_WORDS = ['inicio', 'reiniciar', 'empezar de nuevo', 'nuevo pedido'];

/**
 * Procesa un mensaje y devuelve { replies, orderId? }.
 * @param {object} msg mensaje normalizado
 * @param {object} [ctx] { source: 'whatsapp' | 'simulador', now: Date }
 */
function handle(msg, ctx = {}) {
  const source = ctx.source || 'whatsapp';
  const now = ctx.now || new Date();
  let s = db.getSession(msg.from);

  // Conversación pausada porque el cliente pidió hablar con una persona
  if (s && s.state === 'humano') {
    if (s.data.pauseUntil > now.getTime()) return { replies: [] };
    s = null;
  }

  const expired = s && now.getTime() - s.updatedAt > config.sessionTtlMin * 60e3;
  const typed = msg.kind === 'text' ? norm(msg.text) : '';

  if (!s || expired || s.state === 'fin' || RESET_WORDS.includes(typed)) {
    if (!isOpen(now)) {
      return { replies: [M.text(`¡Hola! 👋 Gracias por escribir a *${config.restaurant.name}*. En este momento estamos cerrados; nuestro horario es de ${config.restaurant.horario.texto} hrs. ¡Te esperamos! 🌮`)] };
    }
    s = { phone: msg.from, state: 'bienvenida', data: { source, profileName: msg.name || null, cart: [] } };
    db.logEvent(msg.from, 'inicio', source);
    // Si el primer mensaje ya es la elección de un botón (por ejemplo, un mensaje viejo), lo procesamos normal.
    if (msg.kind !== 'reply') {
      const out = prompts.bienvenida(s, { first: true });
      db.saveSession(s);
      return { replies: out };
    }
  }

  if (typed === 'cancelar' && s.state !== 'bienvenida') {
    const r = cancel(s);
    s.state = r.to;
    db.saveSession(s);
    return { replies: r.out };
  }

  if (msg.name && !s.data.profileName) s.data.profileName = msg.name;

  // "menu" en cualquier momento muestra el menú sin perder lo que ya lleva
  if ((typed === 'menu' || typed === 'ver menu') && s.state !== 'menu') {
    s.state = 'menu';
    db.saveSession(s);
    return { replies: prompts.menu(s) };
  }

  const handler = handlers[s.state];
  const result = handler ? handler(s, msg, choice(msg)) : null;

  if (!result) {
    // Respuesta que no corresponde: recordamos amablemente la pregunta actual.
    const again = prompts[s.state] ? prompts[s.state](s) : prompts.bienvenida(s);
    db.saveSession(s);
    return { replies: withNote('Por favor elige una de las opciones 👇', again) };
  }

  s.state = result.to;
  if (s.state === 'resumen' && s.data.payment === 'transferencia') s.data.proofTotal = totals(s).total;
  db.saveSession(s);
  return { replies: result.out, orderId: result.orderId };
}

module.exports = { handle, isOpen, _internals: { norm, match, totals, menuSections, parsePhone } };
