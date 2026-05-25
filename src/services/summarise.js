'use strict';

/**
 * Post-call summarisation via Claude API.
 * Takes a raw ElevenLabs transcript and extracts structured call data.
 */

const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../logger');
const { config } = require('../config');

const VALID_DISPOSITIONS = [
  'qualified_booked', 'qualified_send_link', 'qualified_callback',
  'interested_not_qualified', 'not_interested', 'gatekeeper_blocked',
  'no_answer', 'voicemail_left', 'wrong_number', 'do_not_call',
  'human_requested', 'declined_ai',
];

const SYSTEM_PROMPT = `You are a CRM analyst reviewing a transcript of an outbound AI SDR call made by Will, a GrowthNGen AI agent, to a construction industry prospect in Australia.

GrowthNGen automates the flow of Cotality construction project data into HubSpot CRM, eliminating manual data entry for construction sales teams. Will qualifies prospects on: HubSpot usage, construction data source (Cordell Connect, BCI, etc.), team size, and pain points.

Extract the following in valid JSON — no preamble, no markdown fences, just the JSON object:

{
  "outcome": "1-2 sentence plain English summary of how the call went",
  "disposition": "one of: qualified_booked|qualified_send_link|qualified_callback|interested_not_qualified|not_interested|gatekeeper_blocked|no_answer|voicemail_left|wrong_number|do_not_call|human_requested|declined_ai",
  "objections": ["list of objections the prospect raised"],
  "next_action": "specific next action agreed or implied (e.g. 'Send intro email', 'Call back Thursday 10am')",
  "data_points": {
    "crm": "CRM they use if mentioned (e.g. HubSpot Professional)",
    "data_source": "construction data tool if mentioned (e.g. Cordell Connect, BCI, none)",
    "team_size": "sales/BD team size if mentioned",
    "pain_points": ["list of specific pain points mentioned"],
    "project_names": ["any construction project names or types mentioned"],
    "budget_signals": "any pricing or budget signals mentioned"
  },
  "follow_up_draft": "1-2 sentence follow-up message to send after this call, in Will's voice, referencing something specific from the conversation"
}`;

/**
 * Format an ElevenLabs transcript array into readable text.
 * ElevenLabs format: [{ role: "agent"|"user", message: "..." }]
 */
function formatTranscript(transcriptItems) {
  if (!Array.isArray(transcriptItems) || !transcriptItems.length) return '';
  return transcriptItems
    .map((item) => {
      const speaker = item.role === 'agent' ? 'Will' : 'Prospect';
      return `${speaker}: ${item.message || ''}`;
    })
    .filter((line) => line.trim().length > 6)
    .join('\n');
}

/**
 * Summarise a call transcript using Claude Haiku.
 * Returns a structured summary object.
 * Falls back to a safe default if Claude errors or returns unparseable JSON.
 */
async function summariseCall(transcriptItems, metadata = {}) {
  const transcriptText = formatTranscript(transcriptItems);

  if (!transcriptText) {
    logger.warn('summariseCall: empty transcript — returning default');
    return defaultSummary('no_answer', 'No transcript available.');
  }

  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const userMessage = `Call metadata: ${JSON.stringify(metadata)}\n\nTranscript:\n${transcriptText}`;

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const raw = message.content?.[0]?.text || '';
    // Strip markdown code fences if Claude wraps the response despite instructions
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);

    // Validate disposition
    if (!VALID_DISPOSITIONS.includes(parsed.disposition)) {
      parsed.disposition = inferDispositionFromText(transcriptText);
    }

    logger.info({ disposition: parsed.disposition }, 'Claude post-call summary complete');
    return parsed;
  } catch (err) {
    logger.error({ err: err.message }, 'Claude summarisation failed — using fallback');
    return defaultSummary(inferDispositionFromText(transcriptText), 'Summary unavailable — see raw transcript.');
  }
}

function defaultSummary(disposition, outcome) {
  return {
    outcome,
    disposition,
    objections: [],
    next_action: '',
    data_points: { crm: '', data_source: '', team_size: '', pain_points: [], project_names: [], budget_signals: '' },
    follow_up_draft: '',
  };
}

function inferDispositionFromText(text) {
  const t = text.toLowerCase();
  if (t.includes('booked') || t.includes('locked in') || t.includes('calendar invite')) return 'qualified_booked';
  if (t.includes('send me an email') || t.includes('send email')) return 'qualified_send_link';
  if (t.includes('call me back') || t.includes('call back') || t.includes('better time')) return 'qualified_callback';
  if (t.includes('not interested') || t.includes('hard no')) return 'not_interested';
  if (t.includes('wrong') || t.includes('wrong number')) return 'wrong_number';
  if (t.includes('don\'t talk to ai') || t.includes('not talking to') || t.includes('robot')) return 'declined_ai';
  if (t.includes('do not call') || t.includes('remove me')) return 'do_not_call';
  if (t.includes('speak to a human') || t.includes('real person')) return 'human_requested';
  return 'interested_not_qualified';
}

module.exports = { summariseCall, formatTranscript };
