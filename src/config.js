'use strict';
const path = require('path');
require('dotenv').config({ path: process.env.ENV_FILE || path.join(__dirname, '..', '.env'), quiet: true });

const env = (k, d = '') => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const num = (k, d) => {
  const v = parseFloat(env(k, ''));
  return Number.isFinite(v) ? v : d;
};
const bool = (k, d) => {
  const v = env(k, '');
  if (v === '') return d;
  return ['1', 'true', 'si', 'sí', 'yes'].includes(v.toLowerCase());
};

function parseZonas(s) {
  if (!s) return [];
  return s.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const [km, costo] = p.split(':').map(Number);
    return { km, costo };
  }).filter((z) => Number.isFinite(z.km) && Number.isFinite(z.costo)).sort((a, b) => a.km - b.km);
}

function parseHorario(s) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec((s || '').trim());
  if (!m) return null;
  return { abre: +m[1] * 60 + +m[2], cierra: +m[3] * 60 + +m[4], texto: s.trim() };
}

const config = {
  port: num('PORT', 3000),
  publicUrl: env('PUBLIC_URL', '').replace(/\/$/, ''),
  dataDir: path.resolve(env('DATA_DIR', path.join(__dirname, '..', 'data'))),
  tz: env('TZ', 'America/Mexico_City'),

  wa: {
    token: env('WHATSAPP_TOKEN'),
    phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
    apiVersion: env('WHATSAPP_API_VERSION', 'v21.0'),
    verifyToken: env('WHATSAPP_VERIFY_TOKEN'),
    appSecret: env('WHATSAPP_APP_SECRET'),
  },

  panelPassword: env('PANEL_PASSWORD'),
  sessionSecret: env('SESSION_SECRET', 'dev-secret-cambiar'),
  printAgentToken: env('PRINT_AGENT_TOKEN'),

  simulator: { enabled: bool('SIMULATOR_ENABLED', true), prints: bool('SIMULATOR_PRINTS', true) },

  restaurant: {
    name: env('RESTAURANT_NAME', 'La Birriaza'),
    slogan: env('RESTAURANT_SLOGAN', 'Una experiencia para compartir'),
    horario: parseHorario(env('HORARIO')),
    telefono: env('TELEFONO_CONTACTO'),
    lat: num('RESTAURANT_LAT', null),
    lng: num('RESTAURANT_LNG', null),
  },

  envio: { costo: num('ENVIO_COSTO', 20), zonas: parseZonas(env('ENVIO_ZONAS')) },

  pago: {
    banco: env('PAGO_BANCO', 'Mercado Pago W'),
    titular: env('PAGO_TITULAR', 'Gustavo Ignacio Aco Monroy'),
    clabe: env('PAGO_CLABE', '722969014746864643'),
  },

  promociones: env('PROMOCIONES', '').replace(/\\n/g, '\n'),

  ticket: {
    cols: num('TICKET_COLS', 48),
    qrMode: env('TICKET_QR_MODE', 'native'),
    codepage: env('TICKET_CODEPAGE', 'cp850'),
    logo: bool('TICKET_LOGO', true),
  },

  // Tiempo sin actividad tras el cual la conversación empieza de nuevo
  sessionTtlMin: num('SESSION_TTL_MIN', 180),
  // Minutos que el bot deja de responder cuando el cliente pide hablar con alguien
  humanPauseMin: num('HUMAN_PAUSE_MIN', 30),
};

module.exports = config;
