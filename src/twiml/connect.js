'use strict';

/**
 * TwiML endpoint — Twilio calls this URL when an outbound call connects.
 * Returns XML that connects the call audio to the ElevenLabs agent via WebSocket.
 *
 * Used by Phase 4 /calls/trigger when initiating calls via Twilio REST API.
 */

const express = require('express');
const router = express.Router();
const logger = require('../logger');
const { config } = require('../config');

const VALID_AGENT_IDS = new Set([
  config.elevenLabs.agentId,
  config.elevenLabs.agentIdKate,
].filter(Boolean));

router.post('/connect', (req, res) => {
  const requestedId = req.query.agent_id;
  const agentId = (requestedId && VALID_AGENT_IDS.has(requestedId))
    ? requestedId
    : config.elevenLabs.agentId;

  if (requestedId && !VALID_AGENT_IDS.has(requestedId)) {
    logger.warn({ requestedId }, 'TwiML connect: unknown agent_id — falling back to default');
  }

  // Strip everything except alphanumeric and underscores from CallSid before embedding in XML
  const callSid = (req.body.CallSid || '').replace(/[^A-Za-z0-9_]/g, '');

  logger.info({ agentId, callSid }, 'TwiML connect request');

  // ElevenLabs native Twilio WebSocket stream URL
  const wsUrl = `wss://api.elevenlabs.io/v1/convai/twilio?agent_id=${agentId}`;

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="call_sid" value="${callSid}" />
      <Parameter name="vps_host" value="${config.sdr.vpsHost}" />
    </Stream>
  </Connect>
</Response>`);
});

module.exports = router;
