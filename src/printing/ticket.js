'use strict';
/**
 * Comanda de cocina.
 * buildTicket(order) arma la comanda como una lista de "operaciones" (texto, línea, QR...).
 * Esa lista se convierte a bytes ESC/POS para la impresora (toEscPos) o a texto para verla en el panel (toText).
 */
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const config = require('../config');
const { EscPos, qrToRaster } = require('./escpos');

const money = (n) => '$' + Number(n).toLocaleString('es-MX') + '.00';

function fmtDate(ms) {
  const d = new Date(ms);
  const f = (o) => new Intl.DateTimeFormat('es-MX', { timeZone: config.tz, ...o }).format(d);
  return { fecha: f({ day: '2-digit', month: '2-digit', year: 'numeric' }), hora: f({ hour: '2-digit', minute: '2-digit', hour12: false }) };
}

function fmtPhone(p) {
  if (!p || p.startsWith('sim-')) return 'Simulador';
  const d = p.replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : p;
}

/** Liga que abre la ubicación en Google Maps con vista satelital y marcador. */
function mapsUrl(o) {
  if (o.lat != null && o.lng != null) return `https://maps.google.com/?q=${o.lat.toFixed(6)},${o.lng.toFixed(6)}&t=k&z=19`;
  if (o.address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.address)}`;
  return null;
}

/** Parte un texto en renglones de máximo `w` caracteres sin cortar palabras. */
function wrap(s, w) {
  const words = String(s).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const word of words) {
    if (!cur) cur = word;
    else if ((cur + ' ' + word).length <= w) cur += ' ' + word;
    else { lines.push(cur); cur = word; }
    while (cur.length > w) { lines.push(cur.slice(0, w)); cur = cur.slice(w); }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

const lr = (l, r, w) => {
  const space = Math.max(1, w - l.length - r.length);
  return l + ' '.repeat(space) + r;
};

function buildTicket(o) {
  const W = config.ticket.cols;
  const ops = [];
  const t = (s, st = {}) => ops.push({ op: 'text', s, ...st });
  const hr = (ch = '-') => ops.push({ op: 'hr', ch });
  const { fecha, hora } = fmtDate(o.created_at);
  const folio = String(o.id).padStart(4, '0');

  if (config.ticket.logo) ops.push({ op: 'logo' });
  t(config.restaurant.name.toUpperCase(), { align: 'center', bold: true, w: 2, h: 2 });
  t(config.restaurant.slogan.toUpperCase(), { align: 'center' });
  ops.push({ op: 'feed', n: 1 });
  t(' COMANDA DE COCINA ', { align: 'center', bold: true, invert: true, w: 1, h: 2 });
  if (o.source === 'simulador') t('*** PEDIDO DE PRUEBA ***', { align: 'center', bold: true });
  t(`PEDIDO #${folio}`, { align: 'center', bold: true, w: 2, h: 2 });
  t(lr(fecha, hora + ' hrs', W));
  t(lr('Origen:', o.source === 'simulador' ? 'Simulador' : 'WhatsApp Bot', W));
  t(lr('Tipo:', o.delivery === 'domicilio' ? 'A DOMICILIO' : 'RECOGER EN LOCAL', W), { bold: true });
  hr();

  // Productos: cantidad grande y nombre en doble alto para el parrillero
  const qtyW = 4;
  const priceW = 8;
  const nameW = W - qtyW - priceW;
  t(lr('CANT PRODUCTO', 'IMPORTE', W), { bold: true });
  let articulos = 0;
  for (const it of o.items) {
    articulos += it.qty;
    const lines = wrap(it.short || it.name, nameW);
    lines.forEach((ln, i) => {
      const left = (i === 0 ? String(it.qty).padEnd(qtyW) : ' '.repeat(qtyW)) + ln;
      t(i === 0 ? lr(left, '$' + it.amount, W) : left, { bold: true, h: 2 });
    });
  }
  hr();
  t(lr('Artículos:', String(articulos), W), { bold: true });
  if (o.notes) wrap('Notas: ' + o.notes, W).forEach((l) => t(l));
  hr('=');

  t(o.delivery === 'domicilio' ? 'DATOS DE ENTREGA' : 'DATOS DEL CLIENTE', { align: 'center', bold: true });
  t('Cliente: ' + o.customer, { bold: true });
  if (o.delivery === 'domicilio' && o.contact_phone) {
    t('LLAMAR AL LLEGAR:', { align: 'center', bold: true });
    t(fmtPhone(o.contact_phone), { align: 'center', bold: true, w: 2, h: 2 });
  }
  t('WhatsApp: ' + fmtPhone(o.phone));
  if (o.delivery === 'domicilio') {
    if (o.address) wrap('Dirección: ' + o.address, W).forEach((l) => t(l));
    if (o.reference) wrap('Referencia: ' + o.reference, W).forEach((l) => t(l));
    const url = mapsUrl(o);
    if (url) {
      ops.push({ op: 'feed', n: 1 });
      ops.push({ op: 'qr', data: url });
      t(o.lat != null ? 'Escanea para ver la ubicación' : 'Dirección escrita: verificar', { align: 'center' });
      t(o.lat != null ? 'en el mapa (vista satelital)' : 'en el mapa antes de salir', { align: 'center' });
      if (o.lat != null) t(`${o.lat.toFixed(6)}, ${o.lng.toFixed(6)}`, { align: 'center' });
    }
  }
  hr();
  t(lr('Subtotal', money(o.subtotal), W));
  if (o.delivery === 'domicilio') t(lr('Envío', money(o.shipping), W));
  t(lr('TOTAL', money(o.total), W / 2), { bold: true, w: 2, h: 2 });
  if (o.payment === 'efectivo') {
    t(lr('Pago:', 'EFECTIVO', W), { bold: true });
    if (o.pay_with && o.pay_with > o.total) {
      t(lr('Paga con:', money(o.pay_with), W));
      t(lr('LLEVAR CAMBIO:', money(o.pay_with - o.total), W), { bold: true });
    } else {
      t(lr('Paga con:', 'monto exacto', W));
    }
  } else {
    t(lr('Pago:', 'TRANSFERENCIA', W), { bold: true });
    t(' COMPROBANTE RECIBIDO ', { align: 'center', bold: true, invert: true });
    t('Verificar depósito antes de enviar', { align: 'center' });
  }
  hr();
  if (o.delivery === 'domicilio') {
    t('Hora de salida: ________', { align: 'center' });
    t('Repartidor: ______________', { align: 'center' });
  } else {
    t('Avisar al cliente cuando esté listo', { align: 'center' });
  }
  ops.push({ op: 'feed', n: 1 });
  t('*** Pedido generado automáticamente ***', { align: 'center' });
  ops.push({ op: 'cut' });
  return ops;
}

let logoCache;
function logoRaster() {
  if (logoCache === undefined) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'logo-raster.json'), 'utf8'));
      logoCache = { width: j.width, height: j.height, bits: Buffer.from(j.data, 'base64') };
    } catch { logoCache = null; }
  }
  return logoCache;
}

/** Convierte la comanda a bytes ESC/POS. */
function toEscPos(ops) {
  const p = new EscPos({ codepage: config.ticket.codepage });
  const W = config.ticket.cols;
  for (const o of ops) {
    if (o.op === 'text') {
      p.align(o.align || 'left').bold(!!o.bold).size(o.w || 1, o.h || 1).invert(!!o.invert);
      p.line(o.s);
      p.invert(false).size(1, 1).bold(false);
    } else if (o.op === 'hr') {
      p.align('left').line(o.ch.repeat(W));
    } else if (o.op === 'feed') {
      p.feed(o.n);
    } else if (o.op === 'qr') {
      p.align('center');
      if (config.ticket.qrMode === 'image') {
        const r = qrToRaster(QRCode.create(o.data, { errorCorrectionLevel: 'M' }).modules, W >= 48 ? 6 : 4);
        p.raster(r.width, r.height, r.bits).line('');
      } else {
        p.qr(o.data, { moduleSize: W >= 48 ? 6 : 4 }).line('');
      }
      p.align('left');
    } else if (o.op === 'logo') {
      const l = logoRaster();
      if (l) p.align('center').raster(l.width, l.height, l.bits).line('').align('left');
    } else if (o.op === 'cut') {
      p.cut();
    }
  }
  return p.build();
}

/** Vista en texto de la comanda (para el panel y para pruebas). */
function toText(ops) {
  const W = config.ticket.cols;
  const out = [];
  const center = (s) => { const pad = Math.max(0, Math.floor((W - s.length) / 2)); return ' '.repeat(pad) + s; };
  for (const o of ops) {
    if (o.op === 'text') {
      let s = o.s;
      if ((o.w || 1) === 2) s = s.split('').join(' ');
      out.push(o.align === 'center' ? center(s) : o.align === 'right' ? s.padStart(W) : s);
    } else if (o.op === 'hr') out.push(o.ch.repeat(W));
    else if (o.op === 'feed') for (let i = 0; i < o.n; i++) out.push('');
    else if (o.op === 'qr') out.push(center('[QR] ' + o.data));
    else if (o.op === 'logo') out.push(center('[logo]'));
    else if (o.op === 'cut') out.push('', center('- - - corte - - -'));
  }
  return out.join('\n');
}

module.exports = { buildTicket, toEscPos, toText, mapsUrl, wrap };
