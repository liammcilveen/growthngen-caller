'use strict';

const { createLogger, format, transports } = require('winston');
const path = require('path');
const fs = require('fs');

const logDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    new transports.File({ filename: path.join(logDir, 'app.log'), maxsize: 10_000_000, maxFiles: 5 }),
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message, ...meta }) => {
          // Winston receives object-style calls (pino convention: logger.info({...}, 'msg')).
          // When the first arg is a plain object without a message key, Winston sets
          // message = that object (reference, not string) — coercing gives [object Object].
          // Serialize it properly here.
          const msg = typeof message === 'object' && message !== null
            ? JSON.stringify(message)
            : String(message ?? '');
          const extras = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
          return `${timestamp} ${level}: ${msg}${extras}`;
        })
      ),
    }),
  ],
});

module.exports = logger;
