'use strict';

/**
 * Phase 4 — Outbound Call Trigger
 *
 * POST /calls/trigger
 *   Initiates a Twilio outbound call to a prospect.
 *   Requires Bearer token in Authorization header (TRIGGER_API_KEY).
 *
 * Body: { hubspot_contact_id?, phone?, agent?: "will"|"kate" }
 *
 * Flow:
 *   1. Verify Bearer token
 *   2. Look up contact in HubSpot (if contact_id provided)
 *   3. Initiate Twilio call → TwiML connects to ElevenLabs
 *   4. Log the initiated call
 *   5. Return { call_sid, status }
 */

const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const { z } = require('zod');
const logger = require('../logger');
const { config } = require('../config');
const { findContactById, findContactByPhone } = require('../services/hubspot');

const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);

// ── Bearer auth middleware ────────────────────────────────────────────────────

function requireTriggerAuth(req, res, next) {
  const apiKey = config.sdr.triggerApiKey;
  if (!apiKey) {
    // No key configured — warn and allow (dev mode)
    logger.warn('TRIGGER_API_KEY not set — call trigger endpoint is unprotected');
    return next();
  }
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== apiKey) {
    logger.warn({ path: req.path, ip: req.ip }, 'Unauthorized call trigger attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Schema ───────────────────────────────────────────────────────────────────

const triggerSchema = z.object({
  hubspot_contact_id: z.string().optional(),
  phone: z.string().optional(),
  agent: z.enum(['will', 'kate']).optional().default('will'),
}).refine((d) => d.hubspot_contact_id || d.phone, {
  message: 'Either hubspot_contact_id or phone is required',
});

// ── POST /calls/trigger ───────────────────────────────────────────────────────

router.post('/trigger', requireTriggerAuth, async (req, res) => {
  logger.info({ body: req.body }, 'call trigger received');

  const parsed = triggerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  }

  const { hubspot_contact_id, phone: rawPhone, agent } = parsed.data;

  // Resolve phone number
  let phone = rawPhone;
  let contactId = hubspot_contact_id;

  if (hubspot_contact_id && !phone) {
    const contact = await findContactById(hubspot_contact_id);
    if (!contact) {
      return res.status(404).json({ error: `HubSpot contact ${hubspot_contact_id} not found` });
    }
    phone = contact.properties?.phone || '';
    if (!phone) {
      return res.status(422).json({ error: 'Contact has no phone number in HubSpot' });
    }
  } else if (phone && !contactId) {
    const contact = await findContactByPhone(phone);
    contactId = contact?.id || null;
  }

  if (!phone) {
    return res.status(422).json({ error: 'Could not resolve a phone number for this contact' });
  }

  // Pick agent
  const agentId = agent === 'kate' && config.elevenLabs.agentIdKate
    ? config.elevenLabs.agentIdKate
    : config.elevenLabs.agentId;

  // TwiML URL — the VPS endpoint that returns the <Connect><Stream> XML
  const vpsHost = config.sdr.vpsHost;
  const twimlUrl = vpsHost.startsWith('http')
    ? `${vpsHost}/twiml/connect?agent_id=${agentId}`
    : `https://${vpsHost}/twiml/connect?agent_id=${agentId}`;

  try {
    const call = await twilioClient.calls.create({
      to: phone,
      from: config.twilio.phoneNumber,
      url: twimlUrl,
      method: 'POST',
      statusCallback: vpsHost.startsWith('http')
        ? `${vpsHost}/webhooks/post-call`
        : `https://${vpsHost}/webhooks/post-call`,
      statusCallbackMethod: 'POST',
    });

    logger.info({ callSid: call.sid, phone, agentId, contactId }, 'Twilio call initiated');

    res.json({
      call_sid: call.sid,
      status: call.status,
      to: phone,
      agent: agent,
      hubspot_contact_id: contactId || null,
    });

  } catch (err) {
    logger.error({ err: err.message, phone }, 'Twilio call initiation failed');
    res.status(500).json({ error: 'Call initiation failed', detail: err.message });
  }
});

module.exports = router;
