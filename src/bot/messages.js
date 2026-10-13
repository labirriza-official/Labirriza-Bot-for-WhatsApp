'use strict';
/**
 * Mensajes de salida en un formato propio, independiente de WhatsApp.
 * src/whatsapp/cloud.js los convierte al formato de la API de Meta y el simulador los dibuja.
 *
 * Límites de WhatsApp que se respetan aquí:
 *  - botones: máximo 3, título de 20 caracteres
 *  - listas: máximo 10 filas en total, título de fila 24, descripción 72, texto del botón 20
 *  - cuerpo de mensaje interactivo: 1024 caracteres
 */
const cut = (s, n) => {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
};

const text = (body) => ({ type: 'text', body: cut(body, 4096) });

function buttons(body, btns, { header, footer } = {}) {
  if (btns.length < 1 || btns.length > 3) throw new Error('WhatsApp admite de 1 a 3 botones');
  return {
    type: 'buttons',
    body: cut(body, 1024),
    header: header ? cut(header, 60) : undefined,
    footer: footer ? cut(footer, 60) : undefined,
    buttons: btns.map((b) => ({ id: cut(b.id, 256), title: cut(b.title, 20) })),
  };
}

function list(body, buttonText, sections, { header, footer } = {}) {
  const total = sections.reduce((n, s) => n + s.rows.length, 0);
  if (total < 1 || total > 10) throw new Error(`Una lista de WhatsApp admite de 1 a 10 opciones (llegaron ${total})`);
  return {
    type: 'list',
    body: cut(body, 1024),
    header: header ? cut(header, 60) : undefined,
    footer: footer ? cut(footer, 60) : undefined,
    button: cut(buttonText, 20),
    sections: sections.map((s) => ({
      title: s.title ? cut(s.title, 24) : undefined,
      rows: s.rows.map((r) => ({
        id: cut(r.id, 200),
        title: cut(r.title, 24),
        description: r.description ? cut(r.description, 72) : undefined,
      })),
    })),
  };
}

/** Imagen por URL pública (la toma Meta desde nuestro servidor). */
const image = (path, caption) => ({ type: 'image', path, caption: caption ? cut(caption, 1024) : undefined });

/** Botón nativo de WhatsApp "Enviar ubicación". */
const locationRequest = (body) => ({ type: 'location_request', body: cut(body, 1024) });

module.exports = { text, buttons, list, image, locationRequest };
