'use strict';

require('dotenv').config();

const required = (key) => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
};

const optional = (key, defaultValue = '') => process.env[key] || defaultValue;

// Validate required vars at startup (fail fast before accepting traffic)
function validateConfig() {
  const missing = [];
  const mustHave = [
    'HUBSPOT_API_KEY',
    'ELEVENLABS_API_KEY',
    'ELEVENLABS_AGENT_ID',
    'ELEVENLABS_WEBHOOK_SECRET',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_PHONE_NUMBER',
    'ANTHROPIC_API_KEY',
    'TRIGGER_API_KEY',
  ];
  for (const key of mustHave) {
    if (!process.env[key]) missing.push(key);
  }
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

const config = {
  port: parseInt(optional('PORT', '3000'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),

  elevenLabs: {
    apiKey: optional('ELEVENLABS_API_KEY'),
    agentId: optional('ELEVENLABS_AGENT_ID'),
    agentIdKate: optional('ELEVENLABS_KATE_AGENT_ID'),
    phoneNumberId: optional('ELEVENLABS_PHONE_NUMBER_ID'),
    phoneNumberIdKate: optional('ELEVENLABS_KATE_PHONE_NUMBER_ID'),
    webhookSecret: optional('ELEVENLABS_WEBHOOK_SECRET'),
  },

  twilio: {
    accountSid: optional('TWILIO_ACCOUNT_SID'),
    authToken: optional('TWILIO_AUTH_TOKEN'),
    phoneNumber: optional('TWILIO_PHONE_NUMBER'),
  },

  hubspot: {
    apiKey: optional('HUBSPOT_API_KEY'),
    ownerId: optional('HUBSPOT_OWNER_ID'),
    hotLeadWorkflowId: optional('HUBSPOT_HOT_LEAD_WORKFLOW_ID'),
    pipelineId: optional('HUBSPOT_PIPELINE_ID', '772428074'),
    dealStageQualified: optional('HUBSPOT_DEAL_STAGE_QUALIFIED', '1165694817'),
  },

  anthropic: {
    apiKey: optional('ANTHROPIC_API_KEY'),
  },

  calcom: {
    apiKey: optional('CALCOM_API_KEY'),
    eventTypeId: parseInt(optional('CALCOM_EVENT_TYPE_ID', '5216635'), 10),
    baseUrl: optional('CALCOM_BASE_URL', 'https://api.cal.com/v1'),
  },

  sdr: {
    triggerApiKey: optional('TRIGGER_API_KEY'),
    hubspotWebhookToken: optional('HUBSPOT_WEBHOOK_TOKEN'),
    vpsHost: optional('VPS_HOST', 'localhost:3000'),
  },
};

module.exports = { config, validateConfig };
