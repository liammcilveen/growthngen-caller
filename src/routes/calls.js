'use strict';

/**
 * Phase 4 — Outbound Call Trigger
 *
 * POST /calls/trigger
 *   Initiates a call via the ElevenLabs Outbound Call API.
 *   ElevenLabs manages the Twilio bridge internally — no TwiML needed.
 *   Mirrors the approach used by the Python AIOS caller (apps/sdr_caller/caller.py).
 *
 * Body: { hubspot_contact_id?, phone?, agent?: "will"|"kate" }
 *
 * Flow:
 *   1. Verify Bearer token
 *   2. Resolve phone + contact from HubSpot
 *   3. Build dynamic_variables from contact context
 *   4. POST to ElevenLabs /v1/convai/twilio/outbound-call
 *   5. Return { conversation_id, call_sid, status }
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { z } = require('zod');
const logger = require('../logger');
const { config } = require('../config');
const {
  findContactById,
  findContactByPhone,
  findAssociatedDeal,
  buildContactSummary,
  defaultContactSummary,
} = require('../services/hubspot');

const EL_BASE = 'https://api.elevenlabs.io';

// ── Bearer auth middleware ────────────────────────────────────────────────────

function requireTriggerAuth(req, res, next) {
  const apiKey = config.sdr.triggerApiKey;
  if (!apiKey) {
    logger.error('TRIGGER_API_KEY not set — rejecting all call trigger requests');
    return res.status(401).json({ error: 'Call trigger not configured' });
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

  // ── Resolve contact + phone ───────────────────────────────────────────────

  let phone = rawPhone;
  let contactId = hubspot_contact_id;
  let contact = null;
  let deal = null;

  if (hubspot_contact_id) {
    contact = await findContactById(hubspot_contact_id);
    if (!contact) {
      return res.status(404).json({ error: `HubSpot contact ${hubspot_contact_id} not found` });
    }
    phone = phone || contact.properties?.phone || '';
    if (!phone) {
      return res.status(422).json({ error: 'Contact has no phone number in HubSpot' });
    }
    deal = await findAssociatedDeal(hubspot_contact_id);
  } else if (phone) {
    contact = await findContactByPhone(phone);
    if (contact) {
      contactId = contact.id;
      deal = await findAssociatedDeal(contact.id);
    }
  }

  if (!phone) {
    return res.status(422).json({ error: 'Could not resolve a phone number for this contact' });
  }

  // ── Build dynamic variables from HubSpot context ─────────────────────────

  const summary = contact ? buildContactSummary(contact, deal) : defaultContactSummary();

  const dynamicVariables = {
    prospect_name: summary.prospect_name,
    first_name: summary.first_name,
    company_name: summary.company_name,
    job_title: summary.job_title,
    deal_stage: summary.deal_stage,
    last_contact_notes: summary.last_contact_notes,
    project_type: summary.project_type,
    project_value: summary.project_value,
    caller_id_hint: summary.caller_id_hint,
    hubspot_contact_id: summary.hubspot_contact_id,
    hubspot_deal_id: summary.deal_id,
  };

  // ── Pick agent + phone number ID ──────────────────────────────────────────

  const agentId = agent === 'kate' && config.elevenLabs.agentIdKate
    ? config.elevenLabs.agentIdKate
    : config.elevenLabs.agentId;

  const phoneNumberId = agent === 'kate' && config.elevenLabs.phoneNumberIdKate
    ? config.elevenLabs.phoneNumberIdKate
    : config.elevenLabs.phoneNumberId;

  if (!phoneNumberId) {
    logger.error({ agent }, 'ElevenLabs phone number ID not configured');
    return res.status(500).json({ error: 'ElevenLabs phone number not configured' });
  }

  // ── Initiate via ElevenLabs Outbound Call API ─────────────────────────────
  // Mirrors: client.conversational_ai.twilio.outbound_call(...) in Python AIOS caller.
  // ElevenLabs handles the Twilio bridge internally — no TwiML or WebSocket management needed.

  try {
    const elRes = await axios.post(
      `${EL_BASE}/v1/convai/twilio/outbound-call`,
      {
        agent_id: agentId,
        agent_phone_number_id: phoneNumberId,
        to_number: phone,
        conversation_initiation_client_data: {
          dynamic_variables: dynamicVariables,
        },
      },
      {
        headers: {
          'xi-api-key': config.elevenLabs.apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    const { conversation_id, call_sid } = elRes.data;

    logger.info({ conversation_id, call_sid, phone, agentId, contactId }, 'ElevenLabs outbound call initiated');

    res.json({
      conversation_id,
      call_sid: call_sid || null,
      status: 'initiated',
      to: phone,
      agent,
      hubspot_contact_id: contactId || null,
    });

  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data || err.message;
    logger.error({ err: err.message, status, detail, phone, agentId }, 'ElevenLabs outbound call failed');
    res.status(500).json({ error: 'Call initiation failed', detail });
  }
});

module.exports = router;
