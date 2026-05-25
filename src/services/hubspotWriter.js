'use strict';

/**
 * HubSpot write service — all CRM mutations happen here.
 * Called by server tools (Phase 2) and post-call webhook (Phase 3).
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

// Maps SDR disposition codes to HubSpot hs_lead_status values
const DISPOSITION_TO_LEAD_STATUS = {
  qualified_booked:         'MEETING_BOOKED',
  qualified_send_link:      'QUALIFIED',
  qualified_callback:       'QUALIFIED',
  interested_not_qualified: 'UNQUALIFIED',
  not_interested:           'NOT_INTERESTED',
  gatekeeper_blocked:       'ATTEMPTED_TO_CONTACT',
  no_answer:                'ATTEMPTED_TO_CONTACT',
  voicemail_left:           'ATTEMPTED_TO_CONTACT',
  wrong_number:             'ATTEMPTED_TO_CONTACT',
  do_not_call:              'DO_NOT_CONTACT',
  human_requested:          'IN_PROGRESS',
  declined_ai:              'IN_PROGRESS',
};

// HubSpot call outcome GUIDs (verified via /calling/v1/dispositions)
const CALL_OUTCOME_GUIDS = {
  connected:      'f240bbac-87c9-4f6e-bf70-924b57d47db7',  // Connected
  no_answer:      '73a0d17f-1163-4015-bdd5-ec830791da20',  // No answer
  left_voicemail: 'b2cf5968-551e-4856-9783-52b3da59a7d0',  // Left voicemail
  left_message:   'a4c4c377-d246-4b32-a13b-75a56a4cd0ff',  // Left live message (gatekeeper)
  wrong_number:   '17b47fee-58de-441e-a44c-463f3571cbe0',  // Wrong number
};

/**
 * Update a contact's lead status, SDR disposition, and notes.
 */
async function updateLeadStatus(contactId, disposition, notes = '') {
  if (!contactId || !config.hubspot.apiKey) return null;

  const leadStatus = DISPOSITION_TO_LEAD_STATUS[disposition] || 'ATTEMPTED_TO_CONTACT';
  const props = {
    hs_lead_status: leadStatus,
    sdr_call_disposition: disposition,
    // sdr_last_call_date and sdr_call_attempts retired — auto-populated by HubSpot from call engagements
  };
  if (notes) props.sdr_notes = notes;

  try {
    await axios.patch(
      `${BASE}/crm/v3/objects/contacts/${contactId}`,
      { properties: props },
      { headers: headers(), timeout: 10000 }
    );
    logger.info({ contactId, leadStatus, disposition }, 'HubSpot lead status updated');
    return leadStatus;
  } catch (err) {
    logger.error({ err: err.message, contactId }, 'HubSpot updateLeadStatus failed');
    return null;
  }
}

/**
 * Add a note (engagement) to a contact.
 */
async function addNote(contactId, body) {
  if (!contactId || !body || !config.hubspot.apiKey) return null;

  const nowMs = Date.now();
  try {
    const resp = await axios.post(
      `${BASE}/crm/v3/objects/notes`,
      {
        properties: {
          hs_timestamp: String(nowMs),
          hs_note_body: body,
        },
        associations: [{
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
        }],
      },
      { headers: headers(), timeout: 10000 }
    );
    const noteId = resp.data.id;
    logger.info({ noteId, contactId }, 'HubSpot note created');
    return noteId;
  } catch (err) {
    logger.error({ err: err.message, contactId }, 'HubSpot addNote failed');
    return null;
  }
}

/**
 * Log a call engagement on a contact.
 */
async function logCallEngagement(contactId, { disposition, durationSeconds = 0, notes = '', recordingUrl = '' }) {
  if (!contactId || !config.hubspot.apiKey) return null;

  const outcomeGuid =
    disposition === 'no_answer'          ? CALL_OUTCOME_GUIDS.no_answer
    : disposition === 'voicemail_left'   ? CALL_OUTCOME_GUIDS.left_voicemail
    : disposition === 'wrong_number'     ? CALL_OUTCOME_GUIDS.wrong_number
    : disposition === 'gatekeeper_blocked' ? CALL_OUTCOME_GUIDS.left_message
    : CALL_OUTCOME_GUIDS.connected;

  const nowMs = Date.now();
  const props = {
    hs_timestamp: String(nowMs),
    hs_call_title: `AI SDR Call — Will (GrowthNGen)`,
    hs_call_body: notes,
    hs_call_duration: String(durationSeconds * 1000),
    hs_call_status: 'COMPLETED',
    hs_call_direction: 'OUTBOUND',
    hs_call_disposition: outcomeGuid,
  };
  if (recordingUrl) props.hs_call_recording_url = recordingUrl;

  try {
    const resp = await axios.post(
      `${BASE}/crm/v3/objects/calls`,
      {
        properties: props,
        associations: [{
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 194 }],
        }],
      },
      { headers: headers(), timeout: 10000 }
    );
    logger.info({ callEngagementId: resp.data.id, contactId }, 'HubSpot call engagement logged');
    return resp.data.id;
  } catch (err) {
    logger.error({ err: err.message, contactId }, 'HubSpot logCallEngagement failed');
    return null;
  }
}

// Disposition → GrowthNGen pipeline stage
const DISPOSITION_TO_DEAL_STAGE = {
  qualified_booked:    '1127536670',  // Demo Booked
  qualified_send_link: '1165694819',  // Contact Made
  qualified_callback:  '1165694818',  // Attempting Contact
};
const DEFAULT_DEAL_STAGE = '1165694817'; // Qualified Opportunity

/**
 * Create a deal in the GrowthNGen pipeline (qualified_booked / qualified_send_link).
 */
async function createDeal(contactId, companyName, disposition, notes = '') {
  if (!contactId || !config.hubspot.apiKey) return null;

  const dealStage = DISPOSITION_TO_DEAL_STAGE[disposition] || DEFAULT_DEAL_STAGE;

  try {
    const resp = await axios.post(
      `${BASE}/crm/v3/objects/deals`,
      {
        properties: {
          dealname: `${companyName} — GrowthNGen`,
          pipeline: config.hubspot.pipelineId,
          dealstage: dealStage,
          opportunity_source: 'Prospecting',
          description: notes,
        },
      },
      { headers: headers(), timeout: 10000 }
    );
    const dealId = resp.data.id;

    // Associate deal with contact
    if (dealId) {
      await axios.put(
        `${BASE}/crm/v4/objects/deals/${dealId}/associations/contacts/${contactId}`,
        [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
        { headers: headers(), timeout: 10000 }
      );
    }
    logger.info({ dealId, contactId, companyName }, 'HubSpot deal created');
    return dealId;
  } catch (err) {
    logger.error({ err: err.message, contactId }, 'HubSpot createDeal failed');
    return null;
  }
}

/**
 * Update a deal's pipeline stage and add a note.
 */
async function updateDealStage(dealId, stageName, notes = '') {
  if (!dealId || !config.hubspot.apiKey) return false;

  try {
    await axios.patch(
      `${BASE}/crm/v3/objects/deals/${dealId}`,
      { properties: { dealstage: stageName } },
      { headers: headers(), timeout: 10000 }
    );
    if (notes) {
      // Add note via deal association
      const nowMs = Date.now();
      await axios.post(
        `${BASE}/crm/v3/objects/notes`,
        {
          properties: { hs_timestamp: String(nowMs), hs_note_body: notes },
          associations: [{
            to: { id: dealId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }],
          }],
        },
        { headers: headers(), timeout: 10000 }
      );
    }
    logger.info({ dealId, stageName }, 'HubSpot deal stage updated');
    return true;
  } catch (err) {
    logger.error({ err: err.message, dealId }, 'HubSpot updateDealStage failed');
    return false;
  }
}

/**
 * Flag a deal as a hot lead and optionally enroll in a HubSpot workflow.
 */
async function setHotLeadFlag(dealId, reason = '') {
  if (!dealId || !config.hubspot.apiKey) return false;

  try {
    await axios.patch(
      `${BASE}/crm/v3/objects/deals/${dealId}`,
      { properties: { sdr_hot_lead: 'true' } },
      { headers: headers(), timeout: 10000 }
    );
    logger.info({ dealId, reason }, 'HubSpot hot lead flag set');

    // Enroll in workflow if configured
    const workflowId = config.hubspot.hotLeadWorkflowId;
    if (workflowId) {
      await enrollInWorkflow(dealId, workflowId);
    }
    return true;
  } catch (err) {
    logger.error({ err: err.message, dealId }, 'HubSpot setHotLeadFlag failed');
    return false;
  }
}

/**
 * Enroll an object in a HubSpot workflow.
 */
async function enrollInWorkflow(objectId, workflowId) {
  try {
    await axios.post(
      `${BASE}/automation/v2/workflows/${workflowId}/enrollments/contacts/${objectId}`,
      {},
      { headers: headers(), timeout: 10000 }
    );
    logger.info({ objectId, workflowId }, 'HubSpot workflow enrollment triggered');
  } catch (err) {
    logger.warn({ err: err.message, objectId, workflowId }, 'HubSpot workflow enrollment failed (non-fatal)');
  }
}

/**
 * Create a follow-up task for Liam on a contact.
 */
async function createFollowUpTask(contactId, subject, body = '') {
  if (!contactId || !config.hubspot.apiKey) return null;

  const nowMs = Date.now();
  const dueMsNextDay = nowMs + 24 * 60 * 60 * 1000;

  const props = {
    hs_task_subject: subject,
    hs_task_body: body,
    hs_task_status: 'NOT_STARTED',
    hs_task_type: 'CALL',
    hs_timestamp: String(nowMs),
    hs_task_due_date: String(dueMsNextDay),
  };
  if (config.hubspot.ownerId) props.hubspot_owner_id = config.hubspot.ownerId;

  try {
    const resp = await axios.post(
      `${BASE}/crm/v3/objects/tasks`,
      {
        properties: props,
        associations: [{
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }],
        }],
      },
      { headers: headers(), timeout: 10000 }
    );
    logger.info({ taskId: resp.data.id, contactId }, 'HubSpot follow-up task created');
    return resp.data.id;
  } catch (err) {
    logger.error({ err: err.message, contactId }, 'HubSpot createFollowUpTask failed');
    return null;
  }
}

/**
 * Create a HubSpot meeting activity on a contact.
 */
async function createMeetingActivity(contactId, { startTime, endTime, title, body = '' }) {
  if (!contactId || !config.hubspot.apiKey) return null;

  try {
    const resp = await axios.post(
      `${BASE}/crm/v3/objects/meetings`,
      {
        properties: {
          hs_timestamp: String(Date.now()),
          hs_meeting_title: title,
          hs_meeting_body: body,
          hs_meeting_start_time: String(new Date(startTime).getTime()),
          hs_meeting_end_time: String(new Date(endTime).getTime()),
          hs_meeting_outcome: 'SCHEDULED',
        },
        associations: [{
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 200 }],
        }],
      },
      { headers: headers(), timeout: 10000 }
    );
    logger.info({ meetingId: resp.data.id, contactId }, 'HubSpot meeting activity created');
    return resp.data.id;
  } catch (err) {
    logger.error({ err: err.message, contactId }, 'HubSpot createMeetingActivity failed');
    return null;
  }
}

module.exports = {
  updateLeadStatus,
  addNote,
  logCallEngagement,
  createDeal,
  updateDealStage,
  setHotLeadFlag,
  enrollInWorkflow,
  createFollowUpTask,
  createMeetingActivity,
};
