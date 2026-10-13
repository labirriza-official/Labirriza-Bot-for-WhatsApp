'use strict';
const fs = require('fs');
const path = require('path');

const MENU_FILE = process.env.MENU_FILE || path.join(__dirname, '..', 'menu.json');

let cache = null;
let mtime = 0;

/** Lee menu.json (se recarga solo si el archivo cambia, sin reiniciar el servidor). */
function load() {
  const st = fs.statSync(MENU_FILE);
  if (!cache || st.mtimeMs !== mtime) {
    const raw = JSON.parse(fs.readFileSync(MENU_FILE, 'utf8'));
    const byId = new Map();
    for (const cat of raw.categorias) {
      for (const p of cat.productos) {
        if (byId.has(p.id)) throw new Error(`menu.json: id repetido "${p.id}"`);
        byId.set(p.id, { ...p, categoria: cat.id });
      }
    }
    cache = { categorias: raw.categorias, byId };
    mtime = st.mtimeMs;
  }
  return cache;
}

const categorias = () => load().categorias;
const producto = (id) => load().byId.get(id) || null;
const categoria = (id) => load().categorias.find((c) => c.id === id) || null;

module.exports = { categorias, producto, categoria };
