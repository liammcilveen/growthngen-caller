'use strict';

/**
 * Set Post-Call Webhook + Personalisation Webhook on ElevenLabs Agents
 *
 * Configures webhooks on Will and Kate agents via the ElevenLabs API.
 * Run once on the droplet after any agent ID or host changes.
 *
 * What this does:
 *   1. Post-call webhook: registers a workspace-level webhook (if needed) and
 *      wires it to each agent via post_call_webhook_id. Falls back to legacy
 *      platform_settings.post_call_webhook if workspace API is unavailable.
 *   2. Personalisation webhook: enables conversation_initiation_client_data_from_webhook
 *      on each agent so contact context is injected before every outbound call.
 *
 * Usage:
 *   node src/scripts/setPostCallWebhook.js [--dry-run]
 *
 * Reads from .env:
 *   ELEVENLABS_API_KEY         (required)
 *   ELEVENLABS_AGENT_ID        (Will)
 *   ELEVENLABS_KATE_AGENT_ID   (Kate, optional)
 *   ELEVENLABS_WEBHOOK_SECRET  (HMAC secret for signature verification)
 *   VPS_HOST                   (droplet hostname — used to build the webhook URL)
 */

require('dotenv').config();
const axios = require('axios');

const EL_BASE = 'https://api.elevenlabs.io';
const DRY_RUN = process.argv.includes('--dry-run');

const apiKey = process.env.ELEVENLABS_API_KEY;
const rawHost = (process.env.VPS_HOST || '170-64-143-32.sslip.io').replace(/^https?:\/\//, '');
const POST_CALL_WEBHOOK_URL = `https://${rawHost}/webhooks/post-call`;
const PERSONALISATION_WEBHOOK_URL = `https://${rawHost}/webhooks/personalisation`;
const WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET || '';

if (!apiKey) {
  console.error('ELEVENLABS_API_KEY not set in .env');
  process.exit(1);
}

const elHeaders = {
  'xi-api-key': apiKey,
  'Content-Type': 'application/json',
};

// ── Workspace webhook management ─────────────────────────────────────────────

/**
 * List all workspace-level webhooks.
 * ElevenLabs ConvAI workspace webhooks API (used for post_call_webhook_id).
 */
async function listWorkspaceWebhooks() {
  try {
    const { data } = await axios.get(`${EL_BASE}/v1/convai/webhooks`, {
      headers: elHeaders,
      timeout: 10000,
    });
    return data.webhooks || data || [];
  } catch (err) {
    // 404 means this workspace doesn't support the endpoint (older API version)
    if (err.response?.status === 404) return null;
    throw err;
  }
}

/**
 * Create or find an existing workspace webhook for our post-call URL.
 * Returns { id, url } or null if the workspace API is not available.
 */
async function ensureWorkspaceWebhook() {
  const webhooks = await listWorkspaceWebhooks();
  if (webhooks === null) {
    console.log('  Workspace webhook API not available — will use legacy platform_settings approach');
    return null;
  }

  // Check if one already exists for our URL
  const existing = webhooks.find((w) => w.url === POST_CALL_WEBHOOK_URL);
  if (existing) {
    console.log(`  Existing workspace webhook found: ${existing.id} → ${existing.url}`);
    return existing;
  }

  if (DRY_RUN) {
    console.log(`  [dry-run] Would create workspace webhook for: ${POST_CALL_WEBHOOK_URL}`);
    return { id: 'dry-run-id', url: POST_CALL_WEBHOOK_URL };
  }

  const payload = {
    url: POST_CALL_WEBHOOK_URL,
    ...(WEBHOOK_SECRET ? { secret: WEBHOOK_SECRET } : {}),
  };

  const { data } = await axios.post(`${EL_BASE}/v1/convai/webhooks`, payload, {
    headers: elHeaders,
    timeout: 10000,
  });

  console.log(`  Created workspace webhook: ${data.id} → ${data.url}`);
  return data;
}

// ── Agent helpers ─────────────────────────────────────────────────────────────

async function getAgent(agentId) {
  const { data } = await axios.get(`${EL_BASE}/v1/convai/agents/${agentId}`, {
    headers: elHeaders,
    timeout: 10000,
  });
  return data;
}

async function patchAgent(agentId, patch) {
  const result = await axios.patch(`${EL_BASE}/v1/convai/agents/${agentId}`, patch, {
    headers: elHeaders,
    timeout: 10000,
  });
  return result;
}

// ── Main agent configuration ──────────────────────────────────────────────────

async function configureAgent(name, agentId, workspaceWebhookId) {
  console.log(`\n── ${name} (${agentId}) ──`);

  const agent = await getAgent(agentId);
  const ps = agent.platform_settings || {};
  const wo = ps.workspace_overrides || {};
  const overrides = ps.overrides || {};

  // Current state
  const currentPostCallId = wo.webhooks?.post_call_webhook_id || null;
  const currentPersonalisationUrl = wo.conversation_initiation_client_data_webhook?.url || null;
  const personalisationEnabled = overrides.enable_conversation_initiation_client_data_from_webhook === true;

  console.log(`  Post-call webhook ID : ${currentPostCallId || 'not set'}`);
  console.log(`  Personalisation URL  : ${currentPersonalisationUrl || 'not set'}`);
  console.log(`  Personalisation on   : ${personalisationEnabled}`);

  if (DRY_RUN) {
    if (workspaceWebhookId) {
      console.log(`  [dry-run] Would set post_call_webhook_id to: ${workspaceWebhookId}`);
    } else {
      console.log(`  [dry-run] Would set legacy platform_settings.post_call_webhook.url to: ${POST_CALL_WEBHOOK_URL}`);
    }
    console.log(`  [dry-run] Would set personalisation webhook to: ${PERSONALISATION_WEBHOOK_URL}`);
    console.log(`  [dry-run] Would enable conversation_initiation_client_data_from_webhook`);
    return;
  }

  // Build the patch — preserve existing settings, only change webhook fields
  const patch = {
    platform_settings: {
      ...ps,
      overrides: {
        ...overrides,
        // Enable personalisation webhook (contact context injected before calls)
        enable_conversation_initiation_client_data_from_webhook: true,
      },
      workspace_overrides: {
        ...wo,
        // Set personalisation webhook URL
        conversation_initiation_client_data_webhook: {
          url: PERSONALISATION_WEBHOOK_URL,
          request_headers: {},
        },
        webhooks: {
          ...(wo.webhooks || {}),
          // Wire post-call webhook by workspace webhook ID (preferred)
          // or leave null and rely on legacy approach below
          post_call_webhook_id: workspaceWebhookId || wo.webhooks?.post_call_webhook_id || null,
        },
      },
      // Legacy fallback: set post_call_webhook directly on platform_settings.
      // ElevenLabs may ignore this in newer API versions but it doesn't hurt.
      post_call_webhook: {
        url: POST_CALL_WEBHOOK_URL,
        ...(WEBHOOK_SECRET ? { secret: WEBHOOK_SECRET } : {}),
      },
    },
  };

  const result = await patchAgent(agentId, patch);
  console.log(`  PATCH HTTP ${result.status}`);

  // Verify
  const verify = await getAgent(agentId);
  const vps = verify.platform_settings || {};
  const vwo = vps.workspace_overrides || {};
  const vOverrides = vps.overrides || {};

  console.log(`  Post-call webhook ID : ${vwo.webhooks?.post_call_webhook_id || 'still null'}`);
  console.log(`  Personalisation URL  : ${vwo.conversation_initiation_client_data_webhook?.url || 'not set'}`);
  console.log(`  Personalisation on   : ${vOverrides.enable_conversation_initiation_client_data_from_webhook === true}`);
  console.log('  ✓ Done');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('ElevenLabs Webhook Setup');
  console.log('────────────────────────────────────────────');
  console.log(`Post-call URL        : ${POST_CALL_WEBHOOK_URL}`);
  console.log(`Personalisation URL  : ${PERSONALISATION_WEBHOOK_URL}`);
  console.log(`Secret set           : ${WEBHOOK_SECRET ? 'yes' : 'no'}`);
  console.log(`Dry run              : ${DRY_RUN}`);
  console.log('────────────────────────────────────────────');

  const agents = [
    { name: 'Will', id: process.env.ELEVENLABS_AGENT_ID },
    { name: 'Kate', id: process.env.ELEVENLABS_KATE_AGENT_ID },
  ].filter((a) => a.id);

  if (!agents.length) {
    console.error('No agent IDs found — set ELEVENLABS_AGENT_ID and/or ELEVENLABS_KATE_AGENT_ID in .env');
    process.exit(1);
  }

  // Step 1: Ensure workspace-level post-call webhook exists
  console.log('\nChecking workspace webhook...');
  let workspaceWebhookId = null;
  if (!DRY_RUN) {
    const webhook = await ensureWorkspaceWebhook().catch((err) => {
      console.warn(`  Workspace webhook setup failed: ${err.message} — will use legacy approach`);
      return null;
    });
    workspaceWebhookId = webhook?.id || null;
  } else {
    console.log('  [dry-run] Skipping workspace webhook check');
  }

  // Step 2: Configure each agent
  for (const { name, id } of agents) {
    try {
      await configureAgent(name, id, workspaceWebhookId);
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`  ✗ ${name} failed: ${detail}`);
    }
  }

  console.log('\n────────────────────────────────────────────');
  console.log('Done.');
  console.log('Next: verify in ElevenLabs console → Agents → [agent] → Webhooks');
  console.log('      and → Workspace → Webhooks for the workspace-level entry.');
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
