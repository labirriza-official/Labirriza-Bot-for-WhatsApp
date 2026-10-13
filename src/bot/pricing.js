'use strict';
const config = require('../config');
const menu = require('../menu');

const money = (n) => '$' + Number(n).toLocaleString('es-MX');

/** Convierte el carrito [{id, qty}] en renglones con precio actual del menú. */
function cartLines(cart) {
  return (cart || []).map((c) => {
    const p = menu.producto(c.id);
    if (!p) return null;
    return { id: p.id, name: p.nombre, short: p.corto || p.nombre.toUpperCase(), qty: c.qty, unit: p.precio, amount: p.precio * c.qty };
  }).filter(Boolean);
}

const subtotal = (cart) => cartLines(cart).reduce((s, l) => s + l.amount, 0);

function distanceKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Costo de envío.
 * - Sin zonas configuradas o sin coordenadas: costo fijo ENVIO_COSTO.
 * - Con zonas: según la distancia en línea recta al restaurante. Fuera de la última zona: { fuera: true }.
 */
function shippingFor(location) {
  const { zonas, costo } = config.envio;
  const r = config.restaurant;
  if (!zonas.length || r.lat == null || r.lng == null || !location || location.lat == null) {
    return { costo, km: null, fuera: false };
  }
  const km = distanceKm({ lat: r.lat, lng: r.lng }, location);
  const zona = zonas.find((z) => km <= z.km);
  if (!zona) return { costo: null, km, fuera: true };
  return { costo: zona.costo, km, fuera: false };
}

/** Sugerencias de billete para pago en efectivo: siguiente múltiplo de 50 y el siguiente billete grande. */
function cashOptions(total) {
  let first = Math.ceil(total / 50) * 50;
  if (first <= total) first += 50;
  const second = [200, 500, 1000, 2000].find((b) => b > first);
  return second ? [first, second] : [first];
}

module.exports = { money, cartLines, subtotal, shippingFor, cashOptions, distanceKm };
