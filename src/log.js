'use strict';
const ts = () => new Date().toISOString();
module.exports = {
  info: (...a) => console.log(ts(), '[info]', ...a),
  warn: (...a) => console.warn(ts(), '[aviso]', ...a),
  error: (...a) => console.error(ts(), '[error]', ...a),
};
