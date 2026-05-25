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
 *   - ELEVENLABS_WEBHOOK_SKIP_VERIFY=true → bypass entirely (testing/setup phase)
 *   - No secret set → warn and pass through
 *   - Secret set, no signature header → warn and pass through (ElevenLabs not yet
 *     configured with our secret — common during initial setup)
 *   - Secret set, header present, signature WRONG → reject 401
 *     (this is an active forgery attempt, not a config lag)
 *
 * Once ElevenLabs workspace webhook is registered with the correct secret and
 * starts sending xi-elevenlabs-signature, verification tightens automatically.
 */
function verifyElevenLabsSignature(req, res, next) {
  // ── Escape hatch for initial setup / HMAC debugging ─────────────────────
  if (process.env.ELEVENLABS_WEBHOOK_SKIP_VERIFY === 'true') {
    logger.warn({ path: req.path }, 'ELEVENLABS_WEBHOOK_SKIP_VERIFY=true — skipping signature check');
    return next();
  }

  const secret = config.elevenLabs.webhookSecret;

  if (!secret) {
    logger.warn({ path: req.path }, 'ELEVENLABS_WEBHOOK_SECRET not set — passing through (fail-open)');
    return next();
  }

  const sigHeader = req.headers['xi-elevenlabs-signature'] || req.headers['x-elevenlabs-signature'];

  if (!sigHeader) {
    // ElevenLabs wasn't configured with our secret yet — pass through.
    // Diagnostic: log which headers DID arrive so we can spot alternate header names.
    const incomingHeaders = Object.keys(req.headers).filter((h) => h.includes('eleven') || h.includes('sign') || h.includes('xi'));
    logger.warn({ path: req.path, elevenlabsHeaders: incomingHeaders },
      'ElevenLabs signature header absent — passing through (check elevenlabsHeaders for alternates)');
    return next();
  }

  // Diagnostic: log that we received a signature so we know ElevenLabs is signing
  logger.info({ path: req.path, sigHeader: sigHeader.substring(0, 40) + '...' }, 'ElevenLabs signature received — verifying');

  // Parse: t=<timestamp>,v0=<hmac>
  const parts = Object.fromEntries(sigHeader.split(',').map((p) => {
    const idx = p.indexOf('=');
    return [p.substring(0, idx), p.substring(idx + 1)];
  }));
  const timestamp = parts.t;
  const receivedHmac = parts.v0;

  if (!timestamp || !receivedHmac) {
    logger.warn({ sigHeader }, 'Malformed ElevenLabs signature header');
    return res.status(401).json({ error: 'Malformed signature' });
  }

  // Reject requests older than 5 minutes
  const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
  if (age > 300) {
    logger.warn({ path: req.path, ageSeconds: age }, 'ElevenLabs webhook timestamp too old — rejecting');
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
    // Diagnostic: log the first 16 chars of each so we can spot obvious mismatches
    // without exposing the full secret
    logger.warn({
      path: req.path,
      receivedPrefix: receivedHmac.substring(0, 16),
      expectedPrefix: expectedHmac.substring(0, 16),
      rawBodyLength: rawBody.length,
      timestamp,
    }, 'ElevenLabs signature mismatch — rejecting');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  next();
}

module.exports = { verifyElevenLabsSignature };
