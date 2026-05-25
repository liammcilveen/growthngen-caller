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
 * Fail-open rules (designed for progressive hardening):
 *   - If ELEVENLABS_WEBHOOK_SECRET is not set → warn and pass through
 *   - If secret is set but ElevenLabs sends no signature → warn and pass through
 *     (happens when the ElevenLabs agent webhook wasn't registered with the secret yet)
 *   - If secret is set AND header is present but signature is WRONG → reject 401
 *     (this is an active forgery attempt, not a config lag)
 *
 * Once ElevenLabs workspace webhook is registered with the correct secret and
 * starts sending the xi-elevenlabs-signature header, verification tightens
 * automatically — no code change needed.
 */
function verifyElevenLabsSignature(req, res, next) {
  const secret = config.elevenLabs.webhookSecret;

  if (!secret) {
    logger.warn('ELEVENLABS_WEBHOOK_SECRET not set — passing through (fail-open)');
    return next();
  }

  const sigHeader = req.headers['xi-elevenlabs-signature'] || req.headers['x-elevenlabs-signature'];

  if (!sigHeader) {
    // ElevenLabs wasn't configured with our secret yet — pass through with warning.
    // Once the workspace webhook secret is set on ElevenLabs' side, every call
    // will include the header and verification will kick in automatically.
    logger.warn({ path: req.path }, 'ElevenLabs signature header absent — passing through until webhook secret synced');
    return next();
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

  let signaturesMatch = false;
  try {
    const a = Buffer.from(receivedHmac, 'hex');
    const b = Buffer.from(expectedHmac, 'hex');
    signaturesMatch = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    signaturesMatch = false;
  }

  if (!signaturesMatch) {
    logger.warn({ path: req.path }, 'ElevenLabs signature mismatch — rejecting');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  next();
}

module.exports = { verifyElevenLabsSignature };
