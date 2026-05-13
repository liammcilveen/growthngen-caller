'use strict';

/**
 * HubSpot read service — contact and deal lookups.
 * Used by the personalisation webhook (Phase 1) and lookup_contact tool (Phase 2).
 * All writes go through hubspotWriter.js.
 */

const axios = require('axios');
const logger = require('../logger');
const { config } = require('../config');

const BASE = 'https://api.hubapi.com';

function headers() {
  return {
    Authorization: `Bearer ${config.hubspot.apiKey}`,
    'Content-Type': 'application/json',
  };
}

const CONTACT_PROPS = [
  'firstname', 'lastname', 'email', 'phone', 'company', 'jobtitle',
  'hs_lead_status', 'sdr_notes', 'sdr_call_disposition', 'lead_source_detail',
  // Cotality/project fields — present if previously enriched
  'cotality_project_type', 'cotality_project_value', 'cordell_project_type',
  // sdr_call_attempts and sdr_last_call_date removed — retired, auto-populated by HubSpot
];

const DEAL_PROPS = [
  'dealname', 'dealstage', 'amount', 'closedate', 'description',
  'hs_next_step', 'notes_last_updated',
];

/**
 * Normalize an AU phone number to E.164 format (+61...) for HubSpot search.
 * Handles: 0412345678, +61412345678, 61412345678
 */
function normalizePhone(raw) {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('61') && digits.length === 11) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 10) return `+61${digits.slice(1)}`;
  if (digits.length === 9) return `+61${digits}`; // Mobile without leading 0
  return raw; // Return as-is if format unknown
}

/**
 * Find a HubSpot contact by phone number.
 * Tries E.164 format first; falls back to local format (0412...).
 * Returns full contact object or null.
 */
async function findContactByPhone(rawPhone, timeoutMs = 1500) {
  const phone = normalizePhone(rawPhone);
  const localPhone = phone.startsWith('+61') ? `0${phone.slice(3)}` : phone;

  const trySearch = async (value) => {
    const payload = {
      filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value }] }],
      properties: CONTACT_PROPS,
      limit: 1,
    };
    const resp = await axios.post(`${BASE}/crm/v3/objects/contacts/search`, payload, {
      headers: headers(),
      timeout: timeoutMs,
    });
    return resp.data.results?.[0] || null;
  };

  try {
    let contact = await trySearch(phone);
    if (!contact && localPhone !== phone) contact = await trySearch(localPhone);
    if (contact) {
      logger.info({ contactId: contact.id, phone }, 'HubSpot contact found by phone');
    }
    return contact;
  } catch (err) {
    logger.warn({ err: err.message, phone }, 'HubSpot contact search failed');
    return null;
  }
}

/**
 * Find a HubSpot contact by ID.
 */
async function findContactById(contactId, timeoutMs = 1500) {
  try {
    const resp = await axios.get(
      `${BASE}/crm/v3/objects/contacts/${contactId}`,
      { headers: headers(), params: { properties: CONTACT_PROPS.join(',') }, timeout: timeoutMs }
    );
    return resp.data;
  } catch (err) {
    logger.warn({ err: err.message, contactId }, 'HubSpot contact fetch by ID failed');
    return null;
  }
}

/**
 * Find the most recent deal associated with a contact.
 */
async function findAssociatedDeal(contactId, timeoutMs = 1500) {
  if (!contactId) return null;
  try {
    // Get deal associations
    const assocResp = await axios.get(
      `${BASE}/crm/v4/objects/contacts/${contactId}/associations/deals`,
      { headers: headers(), timeout: timeoutMs }
    );
    const dealIds = assocResp.data.results?.map((r) => r.toObjectId) || [];
    if (!dealIds.length) return null;

    // Fetch the most recent deal
    const dealResp = await axios.get(
      `${BASE}/crm/v3/objects/deals/${dealIds[0]}`,
      { headers: headers(), params: { properties: DEAL_PROPS.join(',') }, timeout: timeoutMs }
    );
    logger.info({ dealId: dealIds[0], contactId }, 'HubSpot deal found');
    return dealResp.data;
  } catch (err) {
    logger.warn({ err: err.message, contactId }, 'HubSpot deal lookup failed');
    return null;
  }
}

/**
 * Build the structured contact summary for use in dynamic_variables and tool responses.
 */
function buildContactSummary(contact, deal) {
  if (!contact) return defaultContactSummary();

  const p = contact.properties || {};
  const d = deal?.properties || {};

  const fullName = [p.firstname, p.lastname].filter(Boolean).join(' ') || 'there';
  const firstName = p.firstname || fullName.split(' ')[0];

  // Extract any Cotality/project fields
  const projectType = p.cotality_project_type || p.cordell_project_type || '';
  const projectValue = p.cotality_project_value || '';

  return {
    hubspot_contact_id: contact.id || '',
    prospect_name: fullName,
    first_name: firstName,
    company_name: p.company || 'your company',
    job_title: p.jobtitle || '',
    email: p.email || '',
    phone: p.phone || '',
    lead_status: p.hs_lead_status || '',
    deal_stage: d.dealname ? `${d.dealname} (${d.dealstage || ''})` : '',
    last_contact_notes: p.sdr_notes || '',
    project_type: projectType,
    project_value: projectValue,
    caller_id_hint: _inferCallerHint(p.hs_lead_status),
    // Full deal details for tool responses
    deal_id: deal?.id || '',
    deal_name: d.dealname || '',
    deal_amount: d.amount || '',
    deal_close_date: d.closedate || '',
    deal_next_step: d.hs_next_step || '',
  };
}

function defaultContactSummary() {
  return {
    hubspot_contact_id: '',
    prospect_name: 'there',
    first_name: 'there',
    company_name: 'your company',
    job_title: '',
    email: '',
    phone: '',
    lead_status: '',
    deal_stage: '',
    last_contact_notes: '',
    project_type: '',
    project_value: '',
    caller_id_hint: 'cold',
    deal_id: '',
    deal_name: '',
    deal_amount: '',
    deal_close_date: '',
    deal_next_step: '',
  };
}

function _inferCallerHint(leadStatus) {
  if (!leadStatus) return 'cold';
  const warm = ['QUALIFIED', 'MEETING_BOOKED', 'IN_PROGRESS'];
  return warm.includes(leadStatus) ? 'warm' : 'cold';
}

module.exports = {
  findContactByPhone,
  findContactById,
  findAssociatedDeal,
  buildContactSummary,
  defaultContactSummary,
  normalizePhone,
};
