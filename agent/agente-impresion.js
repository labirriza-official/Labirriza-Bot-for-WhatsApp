#!/usr/bin/env node
'use strict';
/**
 * AGENTE DE IMPRESIÓN - La Birriaza
 *
 * Corre en la PC del restaurante. Cada pocos segundos pregunta al servidor si hay comandas nuevas y las imprime:
 *  - conexion "usb": impresora conectada por USB a esta PC con Windows (usa imprimir-raw.ps1)
 *  - conexion "red": impresora conectada al módem por cable de red (puerto 9100)
 *
 * No necesita instalar nada más que Node.js 18 o superior.
 *
 * Uso:
 *   node agente-impresion.js            -> empieza a imprimir comandas
 *   node agente-impresion.js --prueba   -> imprime una hoja de prueba (para revisar la conexión con la impresora)
 *   node agente-impresion.js --impresoras -> lista las impresoras instaladas en Windows (para copiar el nombre exacto)
 *
 * Configuración: archivo config.json junto a este archivo (ver config.ejemplo.json) o variables de entorno
 *   SERVIDOR, TOKEN, CONEXION (usb|red), IMPRESORA_NOMBRE, IMPRESORA_IP, IMPRESORA_PUERTO, INTERVALO_SEG
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

function loadConfig() {
  let file = {};
  const p = path.join(__dirname, 'config.json');
  if (fs.existsSync(p)) file = JSON.parse(fs.readFileSync(p, 'utf8'));
  const c = {
    servidor: (process.env.SERVIDOR || file.servidor || '').replace(/\/$/, ''),
    token: process.env.TOKEN || file.token || '',
    conexion: (process.env.CONEXION || file.conexion || (file.impresoraIp ? 'red' : 'usb')).toLowerCase(),
    impresoraNombre: process.env.IMPRESORA_NOMBRE || file.impresoraNombre || '',
    impresoraIp: process.env.IMPRESORA_IP || file.impresoraIp || '',
    impresoraPuerto: +(process.env.IMPRESORA_PUERTO || file.impresoraPuerto || 9100),
    intervaloSeg: +(process.env.INTERVALO_SEG || file.intervaloSeg || 3),
  };
  return c;
}

const cfg = loadConfig();
const ts = () => new Date().toLocaleString('es-MX');
const log = (...a) => console.log(`[${ts()}]`, ...a);

const PS1 = path.join(__dirname, 'imprimir-raw.ps1');
const powershell = (args) => new Promise((resolve, reject) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...args],
    { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
      const msg = String(stderr || '').trim();
      if (err) return reject(new Error(msg || err.message));
      if (msg) log('⚠', msg);
      resolve(String(stdout || ''));
    });
});

/** Manda la comanda a la impresora USB instalada en Windows. */
async function imprimirUsb(bytes) {
  const tmp = path.join(os.tmpdir(), `comanda-${process.pid}-${Date.now()}.bin`);
  fs.writeFileSync(tmp, bytes);
  try {
    await powershell(['-Printer', cfg.impresoraNombre, '-File', tmp]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const destino = () => (cfg.conexion === 'usb' ? `USB "${cfg.impresoraNombre}"` : `${cfg.impresoraIp}:${cfg.impresoraPuerto}`);
const imprimir = (bytes) => (cfg.conexion === 'usb' ? imprimirUsb(bytes) : imprimirRed(bytes));

/** Manda bytes a la impresora por red (TCP 9100). */
function imprimirRed(bytes) {
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
  if (process.argv.includes('--impresoras')) {
    if (process.platform !== 'win32') { console.error('Esta opción solo funciona en Windows.'); process.exit(1); }
    console.log('Impresoras instaladas en esta computadora (copia el "Name" exacto en impresoraNombre):');
    console.log(await powershell(['-Listar']));
    return;
  }
  if (cfg.conexion === 'usb') {
    if (process.platform !== 'win32') { console.error('La conexión "usb" requiere Windows. En otro sistema usa "red".'); process.exit(1); }
    if (!cfg.impresoraNombre) { console.error('Falta "impresoraNombre" en config.json. Ejecuta ver-impresoras.bat para ver el nombre.'); process.exit(1); }
  } else if (!cfg.impresoraIp) {
    console.error('Falta la IP de la impresora (impresoraIp en config.json).'); process.exit(1);
  }
  if (process.argv.includes('--prueba')) {
    log(`Enviando hoja de prueba a ${destino()}...`);
    try { await imprimir(hojaDePrueba()); log('✔ Hoja de prueba enviada'); } catch (e) { log('✖', e.message); process.exit(1); }
    return;
  }
  if (!cfg.servidor || !cfg.token) { console.error('Faltan "servidor" y/o "token" en config.json.'); process.exit(1); }
  log(`Agente de impresión iniciado. Servidor: ${cfg.servidor} · Impresora: ${destino()}`);
  log('Deja esta ventana abierta. Las comandas se imprimen solas.');
  ciclo();
}

main();
