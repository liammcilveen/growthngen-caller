'use strict';

const crypto = require('crypto');
const logger = require('../logger');
const { config } = require('../config');

/**
 * HMAC-SHA256 signature verification for ElevenLabs webhook requests.
 *
 * ElevenLabs signs requests with the header: xi-elevenlabs-signature
 * Format: t=<timestamp>,v0=<hmac_hex>
 *
 * Verification: HMAC-SHA256(secret, "<timestamp>.<raw_body>")
 *
 * If ELEVENLABS_WEBHOOK_SECRET is not set, logs a warning and passes through
 * (fail-open for initial setup). Once secret is configured, fails closed (401).
 */
function verifyElevenLabsSignature(req, res, next) {
  const secret = config.elevenLabs.webhookSecret;

  if (!secret) {
    logger.warn('ELEVENLABS_WEBHOOK_SECRET not set — skipping signature verification');
    return next();
  }

  const sigHeader = req.headers['xi-elevenlabs-signature'] || req.headers['x-elevenlabs-signature'];

  if (!sigHeader) {
    logger.warn({ path: req.path }, 'Missing ElevenLabs signature header');
    return res.status(401).json({ error: 'Missing signature' });
  }

  // Parse: t=<timestamp>,v0=<hmac>
  const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=')));
  const timestamp = parts.t;
  const receivedHmac = parts.v0;

  if (!timestamp || !receivedHmac) {
    logger.warn({ sigHeader }, 'Malformed ElevenLabs signature header');
    return res.status(401).json({ error: 'Malformed signature' });
  }

  // Reject requests older than 5 minutes
  const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
  if (age > 300) {
    logger.warn({ age }, 'ElevenLabs webhook timestamp too old');
    return res.status(401).json({ error: 'Request too old' });
  }

  const rawBody = req.rawBody || '';
  const expectedHmac = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const signaturesMatch = crypto.timingSafeEqual(
    Buffer.from(receivedHmac, 'hex'),
    Buffer.from(expectedHmac, 'hex')
  );

  if (!signaturesMatch) {
    logger.warn({ path: req.path }, 'ElevenLabs signature mismatch — rejecting');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  next();
}

module.exports = { verifyElevenLabsSignature };
