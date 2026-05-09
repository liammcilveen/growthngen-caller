'use strict';

const express = require('express');
const { config, validateConfig } = require('./config');
const logger = require('./logger');

// Validate required env vars before starting
validateConfig();

const app = express();

// Parse body once; capture raw bytes for HMAC verification via verify callback
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));
app.use(express.urlencoded({
  extended: false,
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
    }, 'request');
  });
  next();
});

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
});

// Routes
app.use('/webhooks', require('./webhooks/personalisation'));
app.use('/webhooks', require('./webhooks/tools'));
app.use('/webhooks', require('./webhooks/postCall'));
app.use('/calls', require('./routes/calls'));
app.use('/twiml', require('./twiml/connect'));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `No route: ${req.method} ${req.path}` });
});

// Global error handler — never let an unhandled error crash the server
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  logger.error({ err, path: req.path }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(config.port, () => {
  logger.info(`GrowthNGen Caller webhook service running on port ${config.port} [${config.nodeEnv}]`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down gracefully');
  server.close(() => process.exit(0));
});

module.exports = app;
