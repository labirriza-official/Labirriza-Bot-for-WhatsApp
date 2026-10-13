#!/usr/bin/env node
'use strict';
/**
 * AGENTE DE IMPRESIÓN - La Birriaza
 *
 * Corre en una PC (o mini PC / Raspberry Pi) conectada a la misma red que la impresora térmica.
 * Cada pocos segundos pregunta al servidor si hay comandas nuevas y las manda a la impresora por red (puerto 9100).
 *
 * No necesita instalar nada más que Node.js 18 o superior.
 *
 * Uso:
 *   node agente-impresion.js            -> empieza a imprimir comandas
 *   node agente-impresion.js --prueba   -> imprime una hoja de prueba (para revisar la conexión con la impresora)
 *
 * Configuración: archivo config.json junto a este archivo (ver config.ejemplo.json) o variables de entorno
 *   SERVIDOR, TOKEN, IMPRESORA_IP, IMPRESORA_PUERTO, INTERVALO_SEG
 */
const fs = require('fs');
const net = require('net');
const path = require('path');

function loadConfig() {
  let file = {};
  const p = path.join(__dirname, 'config.json');
  if (fs.existsSync(p)) file = JSON.parse(fs.readFileSync(p, 'utf8'));
  const c = {
    servidor: (process.env.SERVIDOR || file.servidor || '').replace(/\/$/, ''),
    token: process.env.TOKEN || file.token || '',
    impresoraIp: process.env.IMPRESORA_IP || file.impresoraIp || '',
    impresoraPuerto: +(process.env.IMPRESORA_PUERTO || file.impresoraPuerto || 9100),
    intervaloSeg: +(process.env.INTERVALO_SEG || file.intervaloSeg || 3),
  };
  return c;
}

const cfg = loadConfig();
const ts = () => new Date().toLocaleString('es-MX');
const log = (...a) => console.log(`[${ts()}]`, ...a);

/** Manda bytes a la impresora por TCP. */
function imprimir(bytes) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: cfg.impresoraIp, port: cfg.impresoraPuerto });
    let done = false;
    const fin = (err) => { if (done) return; done = true; sock.destroy(); err ? reject(err) : resolve(); };
    sock.setTimeout(10_000, () => fin(new Error('La impresora no respondió (tiempo agotado)')));
    sock.on('error', (e) => fin(new Error(`No se pudo conectar a la impresora ${cfg.impresoraIp}:${cfg.impresoraPuerto} (${e.code || e.message})`)));
    sock.on('connect', () => {
      sock.write(bytes, (err) => {
        if (err) return fin(err);
        sock.end();
        // pequeña espera para que la impresora reciba todo antes de cerrar
        setTimeout(() => fin(), 300);
      });
    });
  });
}

async function api(method, ruta, body) {
  const res = await fetch(`${cfg.servidor}/api/impresion${ruta}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) throw new Error('El servidor rechazó el TOKEN. Revisa que sea igual a PRINT_AGENT_TOKEN.');
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`Servidor respondió ${res.status}`);
  return res.json();
}

let avisoConexion = false;
async function ciclo() {
  try {
    // Imprime todas las comandas pendientes una tras otra
    for (;;) {
      const job = await api('GET', '/siguiente');
      if (avisoConexion) { log('✔ Conexión con el servidor restablecida'); avisoConexion = false; }
      if (!job) break;
      try {
        await imprimir(Buffer.from(job.datos, 'base64'));
        await api('POST', `/${job.id}/listo`);
        log(`🖨  Comanda del pedido #${String(job.pedido).padStart(4, '0')} impresa`);
      } catch (e) {
        log(`✖ No se imprimió el pedido #${job.pedido}: ${e.message}. Se reintentará.`);
        await api('POST', `/${job.id}/error`, { error: e.message }).catch(() => {});
        break;
      }
    }
  } catch (e) {
    if (!avisoConexion) { log('✖ Sin conexión con el servidor:', e.message); avisoConexion = true; }
  } finally {
    setTimeout(ciclo, cfg.intervaloSeg * 1000);
  }
}

function hojaDePrueba() {
  const ESC = 0x1b, GS = 0x1d;
  const t = (s) => Buffer.from(s.normalize('NFD').replace(/[̀-ͯ]/g, '') + '\n', 'ascii');
  return Buffer.concat([
    Buffer.from([ESC, 0x40, ESC, 0x61, 1, GS, 0x21, 0x11]), t('LA BIRRIAZA'),
    Buffer.from([GS, 0x21, 0x00]), t('Prueba de impresion'), t(ts()),
    t('Si lees esto, la impresora y el'), t('agente estan bien conectados.'),
    Buffer.from([ESC, 0x64, 4, GS, 0x56, 0x42, 0x00]),
  ]);
}

async function main() {
  if (!cfg.impresoraIp) { console.error('Falta la IP de la impresora (impresoraIp en config.json).'); process.exit(1); }
  if (process.argv.includes('--prueba')) {
    log(`Enviando hoja de prueba a ${cfg.impresoraIp}:${cfg.impresoraPuerto}...`);
    try { await imprimir(hojaDePrueba()); log('✔ Hoja de prueba enviada'); } catch (e) { log('✖', e.message); process.exit(1); }
    return;
  }
  if (!cfg.servidor || !cfg.token) { console.error('Faltan "servidor" y/o "token" en config.json.'); process.exit(1); }
  log(`Agente de impresión iniciado. Servidor: ${cfg.servidor} · Impresora: ${cfg.impresoraIp}:${cfg.impresoraPuerto}`);
  log('Deja esta ventana abierta. Las comandas se imprimen solas.');
  ciclo();
}

main();
