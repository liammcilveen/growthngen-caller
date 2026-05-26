'use strict';

/**
 * Call Registry — in-memory map of active/recent calls.
 *
 * Populated by calls.js when ElevenLabs confirms a call is initiated.
 * Consumed by postCall.js when the post-call webhook fires.
 *
 * Solves the contact-lookup problem: for ElevenLabs outbound calls,
 * the post-call webhook's caller_id is the ElevenLabs phone number
 * (not the prospect's number), so phone-based HubSpot lookup fails.
 * Storing conversation_id → contactId at initiation time is reliable.
 *
 * Entries auto-expire after 2 hours to prevent memory creep on long-running
 * processes (post-call fires within seconds; 2h is a generous safety margin).
 */

const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const registry = new Map(); // conversation_id → { contactId, phone, agent, expiresAt }

/**
 * Register a call after ElevenLabs confirms initiation.
 */
function register(conversationId, { contactId, phone, agent }) {
  registry.set(conversationId, {
    contactId: contactId || null,
    phone: phone || '',
    agent: agent || 'will',
    expiresAt: Date.now() + TTL_MS,
  });
}

/**
 * Look up a call by conversation ID.
 * Returns the stored data or null if not found / expired.
 */
function lookup(conversationId) {
  const entry = registry.get(conversationId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    registry.delete(conversationId);
    return null;
  }
  return entry;
}

/**
 * Remove a call from the registry after post-call processing.
 */
function remove(conversationId) {
  registry.delete(conversationId);
}

/**
 * Returns true if at least one non-expired call is currently registered.
 * Used by GET /calls/active so the n8n scheduler can skip a tick rather
 * than firing a second call while one is still in progress.
 */
function active() {
  prune();
  return registry.size > 0;
}

/**
 * Prune expired entries. Called internally — no need to invoke manually.
 */
function prune() {
  const now = Date.now();
  for (const [id, entry] of registry) {
    if (now > entry.expiresAt) registry.delete(id);
  }
}

// Prune expired entries every 30 minutes
setInterval(prune, 30 * 60 * 1000).unref();

module.exports = { register, lookup, remove, active };
