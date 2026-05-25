'use strict';

/**
 * Set Post-Call Webhook on ElevenLabs Agents
 *
 * Configures the post-call webhook URL on Will and Kate agents via the
 * ElevenLabs API. Run once on the droplet after any agent ID or host changes.
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
const webhookHost = process.env.VPS_HOST || '170-64-143-32.sslip.io';
const WEBHOOK_URL = `https://${webhookHost}/webhooks/post-call`;
const WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET || '';

if (!apiKey) {
  console.error('ELEVENLABS_API_KEY not set in .env');
  process.exit(1);
}

async function getAgent(agentId) {
  const { data } = await axios.get(`${EL_BASE}/v1/convai/agents/${agentId}`, {
    headers: { 'xi-api-key': apiKey },
    timeout: 10000,
  });
  return data;
}

async function setWebhook(name, agentId) {
  console.log(`\n── ${name} (${agentId}) ──`);

  // Fetch current config to inspect existing webhook settings
  const agent = await getAgent(agentId);
  const ps = agent.platform_settings || {};
  const existing = ps.post_call_webhook || ps.webhook || null;
  console.log('  Current webhook :', existing ? JSON.stringify(existing) : 'not configured');

  if (DRY_RUN) {
    console.log(`  [dry-run] Would set webhook URL to: ${WEBHOOK_URL}`);
    return;
  }

  // PATCH the agent — preserve all existing platform_settings, only overwrite webhook
  const patch = {
    platform_settings: {
      ...ps,
      // ElevenLabs uses 'post_call_webhook' in newer API versions
      // and 'webhook' in some older agent configs. We set both to be safe.
      post_call_webhook: {
        url: WEBHOOK_URL,
        ...(WEBHOOK_SECRET ? { secret: WEBHOOK_SECRET } : {}),
      },
    },
  };

  const result = await axios.patch(`${EL_BASE}/v1/convai/agents/${agentId}`, patch, {
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });

  const updated = result.data?.platform_settings;
  const newWebhook = updated?.post_call_webhook || updated?.webhook || null;
  console.log(`  HTTP ${result.status}`);
  console.log('  New webhook     :', newWebhook ? JSON.stringify(newWebhook) : 'check ElevenLabs console');
  console.log('  ✓ Done');
}

async function main() {
  console.log('ElevenLabs Post-Call Webhook Setup');
  console.log('───────────────────────────────────────');
  console.log(`Webhook URL : ${WEBHOOK_URL}`);
  console.log(`Secret set  : ${WEBHOOK_SECRET ? 'yes' : 'no'}`);
  console.log(`Dry run     : ${DRY_RUN}`);
  console.log('───────────────────────────────────────');

  const agents = [
    { name: 'Will', id: process.env.ELEVENLABS_AGENT_ID },
    { name: 'Kate', id: process.env.ELEVENLABS_KATE_AGENT_ID },
  ].filter((a) => a.id);

  if (!agents.length) {
    console.error('No agent IDs found — set ELEVENLABS_AGENT_ID and/or ELEVENLABS_KATE_AGENT_ID in .env');
    process.exit(1);
  }

  for (const { name, id } of agents) {
    try {
      await setWebhook(name, id);
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`  ✗ ${name} failed: ${detail}`);
    }
  }

  console.log('\n───────────────────────────────────────');
  console.log('Done. Verify in ElevenLabs console → Agents → [agent] → Webhooks.');
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
