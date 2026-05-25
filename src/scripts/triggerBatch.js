'use strict';

/**
 * Batch Call Trigger
 *
 * Fetches eligible HubSpot contacts by Lead Status, filters out
 * contacts called in the last 7 days, and triggers calls via
 * POST /calls/trigger with configurable concurrency.
 *
 * Usage:
 *   node src/scripts/triggerBatch.js [options]
 *
 * Options:
 *   --lead-status   HubSpot hs_lead_status to target (default: "New")
 *   --max           Maximum calls to trigger (default: 20)
 *   --concurrency   Parallel calls in-flight (default: 3)
 *   --agent         "will" or "kate" (default: "will")
 *   --dry-run       Preview queue without triggering calls
 *   --host          Override VPS_HOST env var
 *   --api-key       Override TRIGGER_API_KEY env var
 */

require('dotenv').config();

const https = require('https');
const http = require('http');

// ── CLI arg parsing ───────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    leadStatus: 'MAKE_CALL',
    max: 20,
    concurrency: 3,
    agent: 'will',
    dryRun: false,
    host: process.env.VPS_HOST || 'localhost:3000',
    apiKey: process.env.TRIGGER_API_KEY || '',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--lead-status': opts.leadStatus = args[++i]; break;
      case '--max': opts.max = parseInt(args[++i], 10); break;
      case '--concurrency': opts.concurrency = parseInt(args[++i], 10); break;
      case '--agent': opts.agent = args[++i]; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--host': opts.host = args[++i]; break;
      case '--api-key': opts.apiKey = args[++i]; break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }
  return opts;
}

// ── HubSpot contact search ────────────────────────────────────────────────────

async function fetchEligibleContacts(leadStatus, max) {
  const hubspotKey = process.env.HUBSPOT_API_KEY;
  if (!hubspotKey) throw new Error('HUBSPOT_API_KEY not set');

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffTs = cutoff.getTime();

  const body = JSON.stringify({
    filterGroups: [
      {
        filters: [
          { propertyName: 'hs_lead_status', operator: 'EQ', value: leadStatus },
          { propertyName: 'phone', operator: 'HAS_PROPERTY' },
        ],
      },
    ],
    properties: ['firstname', 'lastname', 'phone', 'company', 'hs_lead_status', 'sdr_last_call_date', 'sdr_assigned_agent'],
    limit: Math.min(max * 3, 100), // fetch extra to account for filtered-out contacts
    sorts: [{ propertyName: 'sdr_last_call_date', direction: 'ASCENDING' }],
  });

  const data = await hubspotPost('/crm/v3/objects/contacts/search', body, hubspotKey);
  const contacts = data.results || [];

  // Filter: skip contacts called in the last 7 days
  return contacts.filter((c) => {
    const lastCall = c.properties?.sdr_last_call_date;
    if (!lastCall) return true; // never called — eligible
    return parseInt(lastCall, 10) < cutoffTs;
  });
}

function hubspotPost(path, body, apiKey) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.hubapi.com',
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (res.statusCode >= 400) {
            reject(new Error(`HubSpot ${res.statusCode}: ${parsed.message || raw}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`HubSpot response not JSON: ${raw.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── HubSpot trigger status clear ──────────────────────────────────────────────
// After triggering a call, immediately move the contact off MAKE_CALL so it
// isn't re-queued on the next cron run.

function clearTriggerStatus(contactId, apiKey) {
  const body = JSON.stringify({ properties: { hs_lead_status: 'ATTEMPTED_TO_CONTACT' } });
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.hubapi.com',
        path: `/crm/v3/objects/contacts/${contactId}`,
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume(); // drain and discard
        resolve(res.statusCode);
      }
    );
    req.on('error', (err) => {
      console.warn(`  [warn] Could not clear trigger status for ${contactId}: ${err.message}`);
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

// ── Call trigger ──────────────────────────────────────────────────────────────

function triggerCall(contact, opts) {
  return new Promise((resolve, reject) => {
    // Per-contact agent assignment takes priority over the batch-level --agent flag.
    // Set sdr_assigned_agent = "will" or "kate" on the HubSpot contact to pre-assign.
    const agentForContact = contact.properties?.sdr_assigned_agent || opts.agent;

    const payload = JSON.stringify({
      hubspot_contact_id: contact.id,
      phone: contact.properties?.phone || undefined,
      agent: agentForContact,
    });

    const isHttps = opts.host.startsWith('https://') || (!opts.host.startsWith('http://') && !opts.host.includes('localhost'));
    const urlStr = opts.host.startsWith('http') ? `${opts.host}/calls/trigger` : `https://${opts.host}/calls/trigger`;
    const url = new URL(urlStr);

    const reqOpts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(opts.apiKey ? { 'Authorization': `Bearer ${opts.apiKey}` } : {}),
      },
    };

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(reqOpts, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          resolve({ status: res.statusCode, body: parsed });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error('Request timeout'));
    });
    req.write(payload);
    req.end();
  });
}

// ── Concurrency limiter ───────────────────────────────────────────────────────

async function runWithConcurrency(tasks, concurrency) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log('GrowthNGen Batch Call Trigger');
  console.log('─────────────────────────────────────────');
  console.log(`Lead status : ${opts.leadStatus}`);
  console.log(`Max calls   : ${opts.max}`);
  console.log(`Concurrency : ${opts.concurrency}`);
  console.log(`Agent       : ${opts.agent}`);
  console.log(`Host        : ${opts.host}`);
  console.log(`Dry run     : ${opts.dryRun}`);
  console.log('─────────────────────────────────────────');

  let contacts;
  try {
    process.stdout.write('Fetching eligible contacts from HubSpot... ');
    contacts = await fetchEligibleContacts(opts.leadStatus, opts.max);
    contacts = contacts.slice(0, opts.max);
    console.log(`${contacts.length} found`);
  } catch (err) {
    console.error(`\nHubSpot fetch failed: ${err.message}`);
    process.exit(1);
  }

  if (!contacts.length) {
    console.log('No eligible contacts — nothing to do.');
    return;
  }

  console.log('\nQueue:');
  contacts.forEach((c, i) => {
    const name = [c.properties?.firstname, c.properties?.lastname].filter(Boolean).join(' ') || 'Unknown';
    const phone = c.properties?.phone || '(no phone)';
    const company = c.properties?.company || '';
    const agentLabel = c.properties?.sdr_assigned_agent || opts.agent;
    console.log(`  [${i + 1}/${contacts.length}] ${name} (${company}) — ${phone} [${agentLabel}]`);
  });

  if (opts.dryRun) {
    console.log('\n-- DRY RUN: no calls triggered --');
    return;
  }

  console.log('\nTriggering calls...');
  let succeeded = 0;
  let failed = 0;

  const tasks = contacts.map((contact, i) => async () => {
    const name = [contact.properties?.firstname, contact.properties?.lastname].filter(Boolean).join(' ') || 'Unknown';
    const phone = contact.properties?.phone || '';
    const prefix = `  [${i + 1}/${contacts.length}] ${name} (${phone})`;

    try {
      const result = await triggerCall(contact, opts);
      if (result.status === 200) {
        const sid = result.body?.call_sid || 'no-sid';
        console.log(`${prefix} → call_sid=${sid}`);
        succeeded++;
        // Clear trigger status so this contact isn't re-queued on the next cron run
        clearTriggerStatus(contact.id, process.env.HUBSPOT_API_KEY || opts.apiKey);
      } else {
        const detail = result.body?.error || result.body?.detail || JSON.stringify(result.body);
        console.log(`${prefix} → HTTP ${result.status}: ${detail}`);
        failed++;
      }
    } catch (err) {
      console.log(`${prefix} → ERROR: ${err.message}`);
      failed++;
    }
  });

  await runWithConcurrency(tasks, opts.concurrency);

  console.log('\n─────────────────────────────────────────');
  console.log(`Done. Succeeded: ${succeeded}  Failed: ${failed}  Total: ${contacts.length}`);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
