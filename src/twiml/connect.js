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

router.post('/connect', (req, res) => {
  const agentId = req.query.agent_id || config.elevenLabs.agentId;
  const callSid = req.body.CallSid || '';

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
