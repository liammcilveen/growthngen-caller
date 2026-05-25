'use strict';

/**
 * Phase 3 — Post-Call Webhook
 *
 * ElevenLabs calls POST /webhooks/post-call after every call ends.
 * Payload includes: conversation_id, transcript, analysis, metadata
 *
 * This webhook:
 *   1. Verifies HMAC signature (enforced — contains sensitive data)
 *   2. Sends transcript to Claude for structured summarisation
 *   3. Writes the summary as a HubSpot note on the contact
 *   4. Updates deal stage if the disposition warrants it
 *   5. Creates a follow-up task for Liam if human contact was requested
 *
 * ElevenLabs agent config:
 *   Post-call webhook URL: https://{VPS_HOST}/webhooks/post-call
 *   Method: POST
 */

const express = require('express');
const router = express.Router();
const logger = require('../logger');
const { verifyElevenLabsSignature } = require('../middleware/verifyElevenLabs');
const { findContactByPhone, findAssociatedDeal, normalizePhone } = require('../services/hubspot');
const { lookup: registryLookup, remove: registryRemove } = require('../services/callRegistry');
const {
  addNote,
  logCallEngagement,
  createDeal,
  createFollowUpTask,
  updateLeadStatus,
  setHotLeadFlag,
} = require('../services/hubspotWriter');
const { summariseCall } = require('../services/summarise');

// Dispositions that create a HubSpot deal
const DEAL_DISPOSITIONS = new Set(['qualified_booked', 'qualified_send_link']);

// Dispositions that create a follow-up task for Liam
const TASK_DISPOSITIONS = {
  human_requested: 'Prospect requested human follow-up — call back as Liam',
  declined_ai: 'Prospect declined AI calling — manual outreach required',
};

router.post('/post-call', verifyElevenLabsSignature, async (req, res) => {
  const { conversation_id, transcript, analysis, metadata } = req.body;

  logger.info({ conversation_id, transcriptItems: transcript?.length || 0 }, 'post-call webhook received');

  // Respond immediately — ElevenLabs does not wait for post-call processing
  res.json({ received: true });

  // All processing is async after response
  setImmediate(async () => {
    try {
      await processPostCall({ conversation_id, transcript, analysis, metadata });
    } catch (err) {
      logger.error({ err: err.message, conversation_id }, 'post-call processing failed');
    }
  });
});

async function processPostCall({ conversation_id, transcript, analysis, metadata }) {
  const callMeta = metadata || {};
  const durationSeconds = callMeta.call_duration_secs || 0;

  // 1. Claude summarisation
  const summary = await summariseCall(transcript || [], { conversation_id, duration: durationSeconds });

  logger.info({ disposition: summary.disposition, conversation_id }, 'post-call summary complete');

  // 2. Find HubSpot contact
  // Priority order:
  //   A. Call registry (most reliable — set at initiation time in calls.js)
  //   B. dynamic_variables passed through conversation_initiation_client_data
  //   C. Phone lookup via metadata.to_number (outbound prospect number)
  //   D. Phone lookup via metadata.caller_id (may be ElevenLabs' own number — least reliable)

  const registryEntry = registryLookup(conversation_id);
  if (registryEntry) registryRemove(conversation_id);

  // Dynamic variables passed at call initiation — available in metadata on the post-call payload
  const dynVars = callMeta?.conversation_initiation_client_data?.dynamic_variables || {};

  // contactId priority: registry (most reliable) → dynamic_variables → phone lookup
  let contactId = registryEntry?.contactId || dynVars.hubspot_contact_id || null;
  const rawPhone = registryEntry?.phone
    || callMeta.to_number || callMeta.caller_id || callMeta.from_phone || '';

  if (!contactId && rawPhone) {
    const contact = await findContactByPhone(rawPhone);
    contactId = contact?.id || null;
  }

  if (!contactId) {
    logger.warn({ conversation_id, rawPhone }, 'post-call: no HubSpot contact found — logging summary only');
    logger.info({ summary }, 'post-call summary (no contact)');
    return;
  }

  // 3. Build note body
  const noteLines = [
    `**AI SDR Call — ${summary.disposition}**`,
    `Conversation: ${conversation_id}`,
    `Duration: ${durationSeconds}s`,
    '',
    `**Outcome:** ${summary.outcome}`,
    '',
  ];

  if (summary.next_action) noteLines.push(`**Next action:** ${summary.next_action}`, '');

  if (summary.objections?.length) {
    noteLines.push('**Objections raised:**');
    summary.objections.forEach((o) => noteLines.push(`  • ${o}`));
    noteLines.push('');
  }

  const dp = summary.data_points || {};
  const qualLines = [];
  if (dp.crm) qualLines.push(`CRM: ${dp.crm}`);
  if (dp.data_source) qualLines.push(`Data source: ${dp.data_source}`);
  if (dp.team_size) qualLines.push(`Team size: ${dp.team_size}`);
  if (dp.pain_points?.length) qualLines.push(`Pain points: ${dp.pain_points.join(', ')}`);
  if (dp.budget_signals) qualLines.push(`Budget signals: ${dp.budget_signals}`);
  if (qualLines.length) {
    noteLines.push('**Qualification:**');
    qualLines.forEach((q) => noteLines.push(`  ${q}`));
    noteLines.push('');
  }

  if (summary.follow_up_draft) {
    noteLines.push(`**Suggested follow-up:** ${summary.follow_up_draft}`);
  }

  const noteBody = noteLines.join('\n');

  // 4. Write HubSpot note
  await addNote(contactId, noteBody);

  // 5. Log call engagement
  await logCallEngagement(contactId, {
    disposition: summary.disposition,
    durationSeconds,
    notes: summary.outcome,
  });

  // 6. Update lead status
  await updateLeadStatus(contactId, summary.disposition, summary.outcome);

  // 7. Create deal if qualified
  const deal = await findAssociatedDeal(contactId, 3000);
  if (DEAL_DISPOSITIONS.has(summary.disposition) && !deal?.id) {
    const contact = await findContactByPhone(rawPhone);
    const companyName = contact?.properties?.company || 'Unknown';
    await createDeal(contactId, companyName, summary.disposition, summary.outcome);
  }

  // 8. Create follow-up task for Liam if needed
  if (TASK_DISPOSITIONS[summary.disposition]) {
    await createFollowUpTask(
      contactId,
      TASK_DISPOSITIONS[summary.disposition],
      `${summary.outcome}\n\n${summary.follow_up_draft || ''}`
    );
  }

  // 8b. Callback task — schedule a return call with context
  if (summary.disposition === 'qualified_callback') {
    await createFollowUpTask(
      contactId,
      `SDR Callback — ${rawPhone}`,
      `${summary.outcome}\n\n${summary.follow_up_draft || ''}`
    );
  }

  // 9. Hot lead workflow if flagged
  if (analysis?.call_successful === 'success' && summary.disposition === 'qualified_booked') {
    // Hot lead = booked + strong signals
    if ((summary.data_points?.budget_signals || '').length > 0) {
      if (deal?.id) await setHotLeadFlag(deal.id, 'Budget signals detected in post-call analysis');
    }
  }

  logger.info({ contactId, disposition: summary.disposition, conversation_id }, 'post-call processing complete');
}

module.exports = router;
