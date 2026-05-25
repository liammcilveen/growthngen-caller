'use strict';

/**
 * HubSpot Lead Status Webhook
 *
 * HubSpot workflow POSTs here when hs_lead_status → MAKE_CALL.
 * We respond immediately, then trigger an outbound call async.
 *
 * HubSpot Workflow setup:
 *   Trigger: Contact property "hs_lead_status" changes to "MAKE_CALL"
 *   Action:  Send webhook → POST https://{host}/webhooks/hubspot-lead-status?token={HUBSPOT_WEBHOOK_TOKEN}
 *   Recommended body properties to include: sdr_assigned_agent
 *
 * Auth: query-param ?token= or X-Webhook-Token header. Set HUBSPOT_WEBHOOK_TOKEN in .env.
 *
 * Calling-hours guard: 10:00–16:00 AEST Mon–Fri (Australia/Sydney, DST-aware).
 * Outside that window the webhook is acknowledged but no call is placed.
 *
 * Deduplication: in-memory set blocks a second trigger for the same contact
 * within 60 seconds — handles HubSpot retries or accidental double-saves.
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const logger = require('../logger');
const { config } = require('../config');

// ── Calling-hours guard ───────────────────────────────────────────────────────

function withinCallingHours() {
  const now = new Date();
  // Australia/Sydney handles DST automatically (AEST winter / AEDT summer)
  const syd = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Sydney' }));
  const day = syd.getDay(); // 0 = Sun, 6 = Sat
  const mins = syd.getHours() * 60 + syd.getMinutes();
  if (day === 0 || day === 6) return false; // no weekend calls
  return mins >= 10 * 60 && mins < 16 * 60; // 10:00 – 16:00 only
}

// ── Deduplication ─────────────────────────────────────────────────────────────

const recentlyTriggered = new Map(); // contactId → expiresAt
const DEDUP_TTL_MS = 60 * 1000; // 60 s

function isDuplicate(contactId) {
  const exp = recentlyTriggered.get(contactId);
  if (!exp) return false;
  if (Date.now() > exp) { recentlyTriggered.delete(contactId); return false; }
  return true;
}
function markTriggered(contactId) {
  recentlyTriggered.set(contactId, Date.now() + DEDUP_TTL_MS);
}

// Prune stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, exp] of recentlyTriggered) {
    if (now > exp) recentlyTriggered.delete(id);
  }
}, 5 * 60 * 1000).unref();

// ── Token auth ────────────────────────────────────────────────────────────────

function verifyToken(req, res, next) {
  const expected = config.sdr.hubspotWebhookToken;
  if (!expected) return next(); // token not configured — allow through (dev only)
  const provided = req.query.token || req.headers['x-webhook-token'];
  if (provided !== expected) {
    logger.warn({ ip: req.ip }, 'hubspot-lead-status: unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── POST /webhooks/hubspot-lead-status ────────────────────────────────────────

router.post('/hubspot-lead-status', verifyToken, (req, res) => {
  // Respond immediately — HubSpot times out in ~5 s and retries on delay
  res.json({ received: true });

  setImmediate(async () => {
    try {
      const body = req.body;

      // HubSpot sends different payload shapes depending on workflow action version:
      //   Shape A (Ops Hub, newer): { objectId: 1951, properties: { sdr_assigned_agent: "kate" } }
      //   Shape B (legacy):         { vid: 1951, properties: { sdr_assigned_agent: { value: "kate" } } }
      //   Shape C (custom body):    { hs_object_id: "1951", sdr_assigned_agent: "kate" }
      const contactId = String(
        body.objectId || body.vid || body.hs_object_id || body.id || ''
      );

      if (!contactId) {
        logger.warn({ body }, 'hubspot-lead-status: no contactId in payload — check workflow config');
        return;
      }

      // Resolve agent — check top-level and nested properties, handle string or { value } shape
      const props = body.properties || body;
      const rawAgent = (typeof props.sdr_assigned_agent === 'object' && props.sdr_assigned_agent !== null)
        ? props.sdr_assigned_agent?.value
        : props.sdr_assigned_agent;
      const agent = ['will', 'kate'].includes(rawAgent) ? rawAgent : 'will';

      logger.info({ contactId, agent }, 'hubspot-lead-status webhook received');

      // Calling-hours guard
      if (!withinCallingHours()) {
        logger.info({ contactId, agent }, 'hubspot-lead-status: outside AU calling hours — call skipped');
        return;
      }

      // Dedup guard
      if (isDuplicate(contactId)) {
        logger.info({ contactId }, 'hubspot-lead-status: duplicate trigger suppressed within 60 s');
        return;
      }
      markTriggered(contactId);

      // Trigger via internal HTTP — reuses all auth, validation, and logging in /calls/trigger
      const port = config.port || 3000;
      const result = await axios.post(
        `http://localhost:${port}/calls/trigger`,
        { hubspot_contact_id: contactId, agent },
        {
          headers: {
            'Authorization': `Bearer ${config.sdr.triggerApiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        }
      );

      logger.info(
        { contactId, agent, conversation_id: result.data?.conversation_id },
        'hubspot-lead-status: call initiated'
      );
    } catch (err) {
      const detail = err.response?.data || err.message;
      logger.error({ err: err.message, detail }, 'hubspot-lead-status: trigger failed');
    }
  });
});

module.exports = router;
