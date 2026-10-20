'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const log = require('./log');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  app.get('/salud', (req, res) => res.json({ ok: true }));

  app.use('/webhook', require('./routes/webhook'));
  app.use('/api/impresion', require('./routes/print').router);
  app.use('/api/panel', require('./routes/panel'));

  if (config.simulator.enabled) {
    app.use('/api/simulador', require('./routes/simulator'));
    app.get('/simulador', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'simulador', 'index.html')));
  }

  app.get('/', (req, res) => res.redirect('/panel/'));
  // Aviso de privacidad (Meta lo pide para publicar la app de WhatsApp)
  app.get(['/privacidad', '/eliminar-datos'], (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'privacidad.html')));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

  app.use((err, req, res, next) => {
    log.error(err);
    res.status(500).json({ error: 'Error interno' });
  });
  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(config.port, () => {
    log.info(`${config.restaurant.name} - servidor en el puerto ${config.port}`);
    if (!config.wa.token) log.warn('WhatsApp no está configurado (falta WHATSAPP_TOKEN). Puedes probar con /simulador.');
    if (!config.panelPassword) log.warn('Falta PANEL_PASSWORD: el panel no dejará entrar a nadie.');
    if (!config.printAgentToken) log.warn('Falta PRINT_AGENT_TOKEN: el agente de impresión no podrá conectarse.');
    if (config.wa.token && !config.wa.appSecret) log.warn('Falta WHATSAPP_APP_SECRET: no se está validando la firma de los mensajes de Meta.');
  });
}

module.exports = { createApp };
