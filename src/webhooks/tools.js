'use strict';

/**
 * Phase 2 — Server Tool Endpoints
 *
 * ElevenLabs calls POST /webhooks/tools/:toolName during a live call
 * when Will invokes a tool. Each tool must respond within ~5 seconds.
 *
 * Tools:
 *   lookup_contact      — fetch full contact + deal from HubSpot
 *   book_meeting        — create a Cal.com booking + HubSpot meeting activity
 *   update_deal_stage   — update HubSpot deal pipeline stage
 *   flag_hot_lead       — set hot lead flag on deal + trigger workflow
 *   end_call            — log disposition, trigger async HubSpot update
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ELEVENLABS TOOL CONFIG JSON (paste into agent settings → Tools for each tool)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * lookup_contact:
 * {
 *   "name": "lookup_contact",
 *   "description": "Look up the full HubSpot contact and deal record for this prospect. Call this if you need to verify their details or refresh context during the call.",
 *   "url": "https://{VPS_HOST}/webhooks/tools/lookup_contact",
 *   "method": "POST",
 *   "parameters": {
 *     "type": "object",
 *     "properties": {
 *       "phone_number": { "type": "string", "description": "Prospect's phone number" },
 *       "hubspot_contact_id": { "type": "string", "description": "HubSpot contact ID if known" }
 *     }
 *   }
 * }
 *
 * book_meeting:
 * {
 *   "name": "book_meeting",
 *   "description": "Book a 15-minute discovery call with Liam McIlveen. Call this once the prospect agrees to a specific time. Always say 'Let me just pull that up for you' before calling this tool.",
 *   "url": "https://{VPS_HOST}/webhooks/tools/book_meeting",
 *   "method": "POST",
 *   "parameters": {
 *     "type": "object",
 *     "properties": {
 *       "prospect_name": { "type": "string", "description": "Full name of the prospect" },
 *       "email": { "type": "string", "description": "Prospect's email address for the calendar invite" },
 *       "preferred_time_slot": { "type": "string", "description": "The ISO time from the available slots the prospect chose" },
 *       "hubspot_contact_id": { "type": "string", "description": "HubSpot contact ID for meeting activity" }
 *     },
 *     "required": ["prospect_name", "email"]
 *   }
 * }
 *
 * update_deal_stage:
 * {
 *   "name": "update_deal_stage",
 *   "description": "Update the HubSpot deal pipeline stage. Use after a qualifying milestone — e.g. when a prospect confirms they use HubSpot, or when they're clearly not a fit.",
 *   "url": "https://{VPS_HOST}/webhooks/tools/update_deal_stage",
 *   "method": "POST",
 *   "parameters": {
 *     "type": "object",
 *     "properties": {
 *       "deal_id": { "type": "string", "description": "HubSpot deal ID" },
 *       "new_stage": { "type": "string", "description": "HubSpot deal stage ID or name" },
 *       "notes": { "type": "string", "description": "Context note to add to the deal" }
 *     },
 *     "required": ["deal_id", "new_stage"]
 *   }
 * }
 *
 * flag_hot_lead:
 * {
 *   "name": "flag_hot_lead",
 *   "description": "Flag this prospect as a hot lead in HubSpot. Call this immediately when you detect strong buying signals — they mention budget, timeline, or ask about pricing unprompted.",
 *   "url": "https://{VPS_HOST}/webhooks/tools/flag_hot_lead",
 *   "method": "POST",
 *   "parameters": {
 *     "type": "object",
 *     "properties": {
 *       "deal_id": { "type": "string", "description": "HubSpot deal ID" },
 *       "reason": { "type": "string", "description": "Why this is a hot lead (1-2 sentences)" }
 *     },
 *     "required": ["deal_id"]
 *   }
 * }
 *
 * end_call:
 * {
 *   "name": "end_call",
 *   "description": "Signal that this call is ending. MUST be called before going silent. Records the final disposition in HubSpot.",
 *   "url": "https://{VPS_HOST}/webhooks/tools/end_call",
 *   "method": "POST",
 *   "parameters": {
 *     "type": "object",
 *     "properties": {
 *       "disposition": {
 *         "type": "string",
 *         "enum": ["qualified_booked","qualified_send_link","qualified_callback","interested_not_qualified","not_interested","gatekeeper_blocked","no_answer","voicemail_left","wrong_number","do_not_call","human_requested","declined_ai"],
 *         "description": "The call outcome code"
 *       },
 *       "notes": { "type": "string", "description": "Brief summary of the call outcome" },
 *       "hubspot_contact_id": { "type": "string", "description": "HubSpot contact ID from dynamic_variables" },
 *       "callback_datetime": { "type": "string", "description": "ISO datetime for callback if disposition is qualified_callback" }
 *     },
 *     "required": ["disposition", "notes"]
 *   }
 * }
 */

const express = require('express');
const router = express.Router();
const { z } = require('zod');
const logger = require('../logger');
const { verifyElevenLabsSignature } = require('../middleware/verifyElevenLabs');
const {
  findContactByPhone,
  findContactById,
  findAssociatedDeal,
  buildContactSummary,
} = require('../services/hubspot');
const {
  updateLeadStatus,
  updateDealStage,
  setHotLeadFlag,
  createMeetingActivity,
} = require('../services/hubspotWriter');
const { getAvailableSlots, createBooking, formatSlotForSpeech } = require('../services/calendar');

// ── Validation Schemas ────────────────────────────────────────────────────────

const lookupContactSchema = z.object({
  phone_number: z.string().optional(),
  hubspot_contact_id: z.string().optional(),
});

const bookMeetingSchema = z.object({
  prospect_name: z.string().min(1),
  email: z.string().email(),
  preferred_time_slot: z.string().optional(),
  hubspot_contact_id: z.string().optional(),
});

const updateDealStageSchema = z.object({
  deal_id: z.string().min(1),
  new_stage: z.string().min(1),
  notes: z.string().optional(),
});

const flagHotLeadSchema = z.object({
  deal_id: z.string().min(1),
  reason: z.string().optional(),
});

const VALID_DISPOSITIONS = [
  'qualified_booked', 'qualified_send_link', 'qualified_callback',
  'interested_not_qualified', 'not_interested', 'gatekeeper_blocked',
  'no_answer', 'voicemail_left', 'wrong_number', 'do_not_call',
  'human_requested', 'declined_ai',
];

const endCallSchema = z.object({
  disposition: z.enum(VALID_DISPOSITIONS),
  notes: z.string().min(1),
  hubspot_contact_id: z.string().optional(),
  callback_datetime: z.string().optional(),
});

// ── Helper ────────────────────────────────────────────────────────────────────

function validate(schema, body, res) {
  const result = schema.safeParse(body);
  if (!result.success) {
    res.status(400).json({ error: 'Invalid input', details: result.error.flatten() });
    return null;
  }
  return result.data;
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.post('/tools/lookup_contact', verifyElevenLabsSignature, async (req, res) => {
  logger.info({ body: req.body }, 'tool: lookup_contact');
  const input = validate(lookupContactSchema, req.body, res);
  if (!input) return;

  let contact = null;
  if (input.hubspot_contact_id) {
    contact = await findContactById(input.hubspot_contact_id);
  } else if (input.phone_number) {
    contact = await findContactByPhone(input.phone_number);
  }

  if (!contact) {
    return res.json({ found: false, message: 'No contact found in HubSpot for this prospect.' });
  }

  const deal = await findAssociatedDeal(contact.id);
  const summary = buildContactSummary(contact, deal);
  res.json({ found: true, contact: summary });
});

// ─────────────────────────────────────────────────────────────────────────────

router.post('/tools/book_meeting', verifyElevenLabsSignature, async (req, res) => {
  logger.info({ body: req.body }, 'tool: book_meeting');
  const input = validate(bookMeetingSchema, req.body, res);
  if (!input) return;

  // If no preferred_time_slot, fetch available slots and pick the first
  let startTime = input.preferred_time_slot;
  if (!startTime) {
    const slots = await getAvailableSlots(7);
    if (!slots.length) {
      return res.json({
        success: false,
        message: "Liam's calendar is fully booked this week. Can I take your email and have our team reach out directly to find a time?",
      });
    }
    startTime = slots[0].time;
  }

  const booking = await createBooking(startTime, {
    name: input.prospect_name,
    email: input.email,
    timeZone: 'Australia/Sydney',
  });

  if (!booking) {
    return res.json({
      success: false,
      message: `I had a small hiccup booking that in — I'll make sure our team sends you a calendar invite at ${input.email} for ${formatSlotForSpeech(startTime)}.`,
    });
  }

  // Create HubSpot meeting activity asynchronously (don't block response)
  if (input.hubspot_contact_id) {
    setImmediate(() => {
      createMeetingActivity(input.hubspot_contact_id, {
        startTime: booking.startTime,
        endTime: booking.endTime,
        title: `GrowthNGen Discovery Call — ${input.prospect_name}`,
        body: `Booked by AI SDR (Will). Cal.com booking UID: ${booking.uid}`,
      }).catch((err) => logger.warn({ err: err.message }, 'HubSpot meeting activity creation failed'));
    });
  }

  res.json({
    success: true,
    booking_uid: booking.uid,
    start_time: booking.startTime,
    meet_link: booking.meetLink,
    message: `Locked in — ${formatSlotForSpeech(booking.startTime)} AEST. Calendar invite going to ${input.email}.`,
  });
});

// ─────────────────────────────────────────────────────────────────────────────

router.post('/tools/update_deal_stage', verifyElevenLabsSignature, async (req, res) => {
  logger.info({ body: req.body }, 'tool: update_deal_stage');
  const input = validate(updateDealStageSchema, req.body, res);
  if (!input) return;

  const success = await updateDealStage(input.deal_id, input.new_stage, input.notes || '');
  res.json({ success, deal_id: input.deal_id, new_stage: input.new_stage });
});

// ─────────────────────────────────────────────────────────────────────────────

router.post('/tools/flag_hot_lead', verifyElevenLabsSignature, async (req, res) => {
  logger.info({ body: req.body }, 'tool: flag_hot_lead');
  const input = validate(flagHotLeadSchema, req.body, res);
  if (!input) return;

  const success = await setHotLeadFlag(input.deal_id, input.reason || '');
  res.json({ success });
});

// ─────────────────────────────────────────────────────────────────────────────

router.post('/tools/end_call', verifyElevenLabsSignature, async (req, res) => {
  logger.info({ body: req.body }, 'tool: end_call');
  const input = validate(endCallSchema, req.body, res);
  if (!input) return;

  logger.info({ disposition: input.disposition, notes: input.notes }, 'END_CALL');

  // Trigger HubSpot update asynchronously — don't block end_call response
  if (input.hubspot_contact_id) {
    setImmediate(() => {
      updateLeadStatus(input.hubspot_contact_id, input.disposition, input.notes)
        .catch((err) => logger.warn({ err: err.message }, 'end_call HubSpot update failed'));
    });
  }

  res.json({ success: true, disposition: input.disposition });
});

module.exports = router;
