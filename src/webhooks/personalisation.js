'use strict';

/**
 * Phase 1 — Personalisation Webhook
 *
 * ElevenLabs calls GET /webhooks/personalisation at the moment a Twilio call
 * connects, before any audio plays. Must respond within 2 seconds.
 *
 * ElevenLabs sends: caller_id, agent_id, called_number, call_sid (as query params or body)
 * We return: { dynamic_variables: { prospect_name, first_name, company_name, ... } }
 *
 * Graceful fallback: if HubSpot lookup fails or times out, returns safe defaults
 * so the call still connects.
 *
 * ElevenLabs agent config:
 *   Personalisation webhook URL: https://{VPS_HOST}/webhooks/personalisation
 *   Method: GET
 */

const express = require('express');
const router = express.Router();
const logger = require('../logger');
const { findContactByPhone, findAssociatedDeal, buildContactSummary, defaultContactSummary } = require('../services/hubspot');

router.get('/personalisation', async (req, res) => {
  const { caller_id, agent_id, called_number, call_sid } = { ...req.query, ...req.body };

  logger.info({ caller_id, agent_id, called_number, call_sid }, 'personalisation webhook received');

  let summary = defaultContactSummary();

  try {
    const phone = caller_id || called_number || '';

    if (phone) {
      // Run contact + deal lookups in parallel with a hard 1.8s timeout
      const [contact, deal] = await Promise.all([
        findContactByPhone(phone, 1800),
        // Deal lookup requires contact first — handled below
        Promise.resolve(null),
      ]);

      if (contact) {
        const dealData = await findAssociatedDeal(contact.id, 800);
        summary = buildContactSummary(contact, dealData);
        logger.info({ contactId: contact.id, dealId: dealData?.id }, 'personalisation enriched from HubSpot');
      } else {
        logger.info({ phone }, 'no HubSpot contact found — using defaults');
      }
    }
  } catch (err) {
    // Never let a HubSpot error block a call
    logger.warn({ err: err.message }, 'personalisation lookup error — returning defaults');
  }

  const response = {
    dynamic_variables: {
      prospect_name: summary.prospect_name,
      first_name: summary.first_name,
      company_name: summary.company_name,
      job_title: summary.job_title,
      deal_stage: summary.deal_stage,
      last_contact_notes: summary.last_contact_notes,
      sdr_call_attempts: summary.sdr_call_attempts,
      project_type: summary.project_type,
      project_value: summary.project_value,
      caller_id_hint: summary.caller_id_hint,
      // Pass through call metadata for server tools
      hubspot_contact_id: summary.hubspot_contact_id,
      hubspot_deal_id: summary.deal_id,
    },
  };

  logger.info({ dynamic_variables: response.dynamic_variables }, 'personalisation response');
  res.json(response);
});

module.exports = router;
