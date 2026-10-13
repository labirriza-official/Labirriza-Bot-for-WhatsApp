'use strict';
/**
 * Generador de comandos ESC/POS (impresoras térmicas Epson y compatibles de 58/80 mm).
 * Sin dependencias: produce un Buffer que se manda tal cual al puerto 9100 de la impresora.
 */

const ESC = 0x1b;
const GS = 0x1d;

// Página de códigos PC850 (ESC t 2): acentos y ñ del español
const CP850 = {
  'á': 0xa0, 'é': 0x82, 'í': 0xa1, 'ó': 0xa2, 'ú': 0xa3, 'ñ': 0xa4, 'Ñ': 0xa5, '¿': 0xa8, '¡': 0xad,
  'Á': 0xb5, 'É': 0x90, 'Í': 0xd6, 'Ó': 0xe0, 'Ú': 0xe9, 'ü': 0x81, 'Ü': 0x9a, '°': 0xf8,
};

const stripAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[¿¡]/g, '');

function encode(text, codepage) {
  const bytes = [];
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0);
    if (code < 0x80) { bytes.push(code); continue; }
    if (codepage === 'cp850' && CP850[ch] !== undefined) { bytes.push(CP850[ch]); continue; }
    const plain = stripAccents(ch);
    for (const c of plain) bytes.push(c.charCodeAt(0) < 0x80 ? c.charCodeAt(0) : 0x3f);
  }
  return bytes;
}

class EscPos {
  constructor({ codepage = 'cp850' } = {}) {
    this.codepage = codepage;
    this.parts = [];
    this.raw(ESC, 0x40); // inicializar
    if (codepage === 'cp850') this.raw(ESC, 0x74, 2);
  }

  raw(...bytes) { this.parts.push(Buffer.from(bytes.flat())); return this; }
  text(s) { this.parts.push(Buffer.from(encode(s, this.codepage))); return this; }
  line(s = '') { return this.text(s + '\n'); }
  align(a) { return this.raw(ESC, 0x61, { left: 0, center: 1, right: 2 }[a] ?? 0); }
  bold(on) { return this.raw(ESC, 0x45, on ? 1 : 0); }
  invert(on) { return this.raw(GS, 0x42, on ? 1 : 0); }
  /** Tamaño de letra: ancho y alto de 1 a 8. */
  size(w = 1, h = 1) { return this.raw(GS, 0x21, ((w - 1) << 4) | (h - 1)); }
  feed(n = 1) { return this.raw(ESC, 0x64, n); }
  cut() { return this.feed(4).raw(GS, 0x56, 0x42, 0x00); }

  /** QR nativo de la impresora (GS ( k). */
  qr(data, { moduleSize = 6 } = {}) {
    const d = Buffer.from(data, 'utf8');
    const len = d.length + 3;
    this.raw(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00); // modelo 2
    this.raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, moduleSize); // tamaño del módulo
    this.raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31); // corrección de errores M
    this.raw(GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30);
    this.parts.push(d);
    return this.raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30); // imprimir
  }

  /** Imagen de 1 bit (GS v 0). bits: Buffer con filas de ceil(width/8) bytes, bit en 1 = negro. */
  raster(width, height, bits) {
    const bw = Math.ceil(width / 8);
    this.raw(GS, 0x76, 0x30, 0x00, bw & 0xff, (bw >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff);
    this.parts.push(Buffer.from(bits));
    return this;
  }

  build() { return Buffer.concat(this.parts); }
}

/** Convierte una matriz de QR (de la librería qrcode) en una imagen de 1 bit escalada. */
function qrToRaster(modules, scale = 6, quiet = 2) {
  const n = modules.size;
  const size = (n + quiet * 2) * scale;
  const bw = Math.ceil(size / 8);
  const bits = Buffer.alloc(bw * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const my = Math.floor(y / scale) - quiet;
      if (mx >= 0 && my >= 0 && mx < n && my < n && modules.get(my, mx)) bits[y * bw + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { width: size, height: size, bits };
}

module.exports = { EscPos, encode, stripAccents, qrToRaster };
