'use strict';
/** Cálculo de estadísticas de ventas para el panel (en la zona horaria del restaurante). */
const config = require('./config');
const { db } = require('./db');

const DAY = 864e5;
const WEEKDAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

const fmtParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hour12: false,
});
function local(ms) {
  const p = Object.fromEntries(fmtParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24, wd };
}

/** Inicio del día local de `ms`, en epoch ms. */
function startOfLocalDay(ms) {
  const { date } = local(ms);
  // Busca el instante en que cambia la fecha local (funciona con cualquier zona horaria sin librerías).
  let lo = ms - DAY - 3600e3;
  let hi = ms;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (local(mid).date === date) hi = mid; else lo = mid;
  }
  return hi;
}

function range(dias, now = Date.now()) {
  const end = now;
  const start = dias <= 1 ? startOfLocalDay(now) : startOfLocalDay(now - (dias - 1) * DAY);
  const len = end - start;
  return { start, end, prevStart: start - len, prevEnd: start };
}

const qOrders = db.prepare(`SELECT * FROM orders WHERE created_at >= ? AND created_at < ? AND status != 'cancelado' AND (source = 'whatsapp' OR ?)`);
const qItems = db.prepare(`SELECT oi.item_id, oi.name, SUM(oi.qty) units, SUM(oi.amount) amount
  FROM order_items oi JOIN orders o ON o.id = oi.order_id
  WHERE o.created_at >= ? AND o.created_at < ? AND o.status != 'cancelado' AND (o.source = 'whatsapp' OR ?)
  GROUP BY oi.item_id ORDER BY units DESC`);
const qFunnel = db.prepare(`SELECT type, COUNT(*) n FROM events WHERE ts >= ? AND ts < ? AND (source = 'whatsapp' OR ?) GROUP BY type`);

function summarize(orders) {
  const ventas = orders.reduce((s, o) => s + o.total, 0);
  return { ventas, pedidos: orders.length, ticket: orders.length ? Math.round(ventas / orders.length) : 0 };
}

function funnel(start, end, incl) {
  const m = Object.fromEntries(qFunnel.all(start, end, incl).map((r) => [r.type, r.n]));
  const inicio = m.inicio || 0;
  const carrito = m.carrito || 0;
  const confirmado = m.confirmado || 0;
  return { inicio, carrito, confirmado, completado: inicio ? Math.round((confirmado / inicio) * 100) : 0 };
}

const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);

function stats({ dias = 30, prueba = false, now = Date.now() } = {}) {
  const r = range(dias, now);
  const incl = prueba ? 1 : 0;
  const orders = qOrders.all(r.start, r.end, incl);
  const prev = qOrders.all(r.prevStart, r.prevEnd, incl);
  const cur = summarize(orders);
  const old = summarize(prev);
  const f = funnel(r.start, r.end, incl);
  const fPrev = funnel(r.prevStart, r.prevEnd, incl);

  // Serie diaria (o por hora si es "hoy")
  let serie;
  if (dias <= 1) {
    const byHour = new Map();
    for (const o of orders) { const h = local(o.created_at).hour; byHour.set(h, (byHour.get(h) || 0) + o.total); }
    serie = Array.from({ length: 24 }, (_, h) => ({ etiqueta: String(h).padStart(2, '0'), valor: byHour.get(h) || 0, finDeSemana: false }));
  } else {
    const byDay = new Map();
    for (const o of orders) { const d = local(o.created_at).date; byDay.set(d, (byDay.get(d) || 0) + o.total); }
    serie = [];
    const endDate = local(r.end).date;
    for (let t = r.start + 12 * 3600e3; ; t += DAY) {
      const l = local(t);
      if (l.date > endDate) break;
      if (serie.length && serie[serie.length - 1].fecha === l.date) continue;
      serie.push({ fecha: l.date, etiqueta: l.date.slice(8), dia: WEEKDAYS[l.wd], valor: byDay.get(l.date) || 0, finDeSemana: l.wd === 0 || l.wd === 6 });
    }
  }

  const split = (key) => {
    const m = {};
    for (const o of orders) { m[o[key]] = m[o[key]] || { pedidos: 0, ventas: 0 }; m[o[key]].pedidos++; m[o[key]].ventas += o.total; }
    return m;
  };

  // Mapa de calor: día de la semana x hora
  const horas = Array.from({ length: 12 }, (_, i) => 11 + i); // 11 a 22 h
  const heat = [1, 2, 3, 4, 5, 6, 0].map((wd) => ({ dia: WEEKDAYS[wd], celdas: horas.map(() => 0), wd }));
  for (const o of orders) {
    const l = local(o.created_at);
    const row = heat.find((h) => h.wd === l.wd);
    const i = horas.indexOf(l.hour);
    if (row && i >= 0) row.celdas[i]++;
  }

  return {
    rango: { dias, inicio: r.start, fin: r.end, prueba: !!prueba },
    kpis: {
      ventas: cur.ventas, ventasCambio: pct(cur.ventas, old.ventas),
      pedidos: cur.pedidos, pedidosCambio: pct(cur.pedidos, old.pedidos),
      ticket: cur.ticket, ticketCambio: pct(cur.ticket, old.ticket),
      completado: f.completado, completadoCambio: fPrev.inicio ? f.completado - fPrev.completado : null,
    },
    serie,
    pago: split('payment'),
    entrega: split('delivery'),
    productos: qItems.all(r.start, r.end, incl).slice(0, 8),
    calor: { horas, filas: heat.map(({ dia, celdas }) => ({ dia, celdas })) },
    embudo: f,
  };
}

module.exports = { stats, local, startOfLocalDay };
