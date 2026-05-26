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
  // ElevenLabs wraps the payload: { type, event_timestamp, data: { conversation_id, ... } }
  // Fall back to req.body directly in case the structure ever changes.
  const payload = req.body.data || req.body;
  const { conversation_id, transcript, analysis, metadata, user_id } = payload;

  logger.info({ conversation_id, transcriptItems: transcript?.length || 0 }, 'post-call webhook received');

  // Respond immediately — ElevenLabs does not wait for post-call processing
  res.json({ received: true });

  // All processing is async after response
  setImmediate(async () => {
    try {
      await processPostCall({ conversation_id, transcript, analysis, metadata, user_id });
    } catch (err) {
      logger.error({ err: err.message, conversation_id }, 'post-call processing failed');
    }
  });
});

async function processPostCall({ conversation_id, transcript, analysis, metadata, user_id }) {
  const callMeta = metadata || {};
  const durationSeconds = callMeta.call_duration_secs || 0;

  // 1. Claude summarisation
  // Pass current AEST time so Claude can resolve relative callback times
  // (e.g. "in an hour", "this afternoon") to absolute ISO datetimes.
  const nowAest = new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const summary = await summariseCall(transcript || [], {
    conversation_id,
    duration: durationSeconds,
    current_time_aest: nowAest,     // e.g. "26/05/2026, 10:46" — for relative time resolution
  });

  logger.info({ disposition: summary.disposition, conversation_id }, 'post-call summary complete');

  // 2. Find HubSpot contact
  // Priority order:
  //   A. Call registry (most reliable — set at initiation time in calls.js)
  //   B. dynamic_variables passed through conversation_initiation_client_data
  //   C. Phone lookup via metadata.to_number (outbound prospect number)
  //   D. Phone lookup via metadata.caller_id (may be ElevenLabs' own number — least reliable)

  const registryEntry = registryLookup(conversation_id);
  if (registryEntry) registryRemove(conversation_id);
  // Which SDR made this call — used to assign the callback task to the correct queue
  const callingAgent = registryEntry?.agent || 'will';

  // Dynamic variables passed at call initiation — available in metadata on the post-call payload
  const dynVars = callMeta?.conversation_initiation_client_data?.dynamic_variables || {};

  // contactId priority: registry (most reliable) → dynamic_variables → phone lookup
  let contactId = registryEntry?.contactId || dynVars.hubspot_contact_id || null;
  const rawPhone = registryEntry?.phone
    || user_id  // ElevenLabs sends prospect's number as data.user_id
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

  // 3. Build call body — plain text (hs_call_body doesn't render markdown)
  const DISPOSITION_LABELS = {
    qualified_booked:         'Qualified — Meeting Booked',
    qualified_send_link:      'Qualified — Send Link',
    qualified_callback:       'Qualified — Callback Requested',
    interested_not_qualified: 'Interested — Not Yet Qualified',
    not_interested:           'Not Interested',
    gatekeeper_blocked:       'Gatekeeper Blocked',
    no_answer:                'No Answer',
    voicemail_left:           'Voicemail Left',
    wrong_number:             'Wrong Number',
    do_not_call:              'Do Not Call',
    human_requested:          'Human Follow-up Requested',
    declined_ai:              'Declined AI Call',
  };

  const dispositionLabel = DISPOSITION_LABELS[summary.disposition] || summary.disposition;
  const transcriptUrl = `https://elevenlabs.io/app/conversational-ai/history/${conversation_id}`;
  const mins = Math.floor(durationSeconds / 60);
  const secs = durationSeconds % 60;
  const durationLabel = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  const noteLines = [
    `AI SDR Call: ${dispositionLabel}`,
    `Duration: ${durationLabel}  |  Transcript: ${transcriptUrl}`,
    '',
    'Outcome',
    summary.outcome,
    '',
  ];

  if (summary.next_action) {
    noteLines.push('Next Action', summary.next_action, '');
  }

  if (summary.objections?.length) {
    noteLines.push('Objections Raised');
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
    noteLines.push('Qualification');
    qualLines.forEach((q) => noteLines.push(`  ${q}`));
    noteLines.push('');
  }

  if (summary.follow_up_draft) {
    noteLines.push('Suggested Follow-up', summary.follow_up_draft);
  }

  const noteBody = noteLines.join('\n');

  // 4. Log call engagement — full detail goes into the call body (no separate note needed)
  await logCallEngagement(contactId, {
    disposition: summary.disposition,
    durationSeconds,
    notes: noteBody,
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

  // 8b. Callback task — schedule a return call at the agreed time
  if (summary.disposition === 'qualified_callback') {
    // Parse callback time from Claude's extracted datetime, fall back to +1h
    let callbackDueMs = Date.now() + 1 * 60 * 60 * 1000;
    if (summary.callback_datetime) {
      const parsed = new Date(summary.callback_datetime).getTime();
      if (!isNaN(parsed) && parsed > Date.now()) callbackDueMs = parsed;
    }

    const timeLabel = summary.next_action || 'Callback requested';
    await createFollowUpTask(
      contactId,
      `SDR Callback: ${timeLabel}`,
      `${summary.outcome}\n\nSuggested follow-up:\n${summary.follow_up_draft || ''}`,
      callbackDueMs,
      callingAgent  // assigns to Will's or Kate's SDR queue — picked up by n8n
    );
    logger.info({ contactId, callbackDueMs, timeLabel, callingAgent }, 'SDR callback task created');
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
