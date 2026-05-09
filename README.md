# GrowthNGen Caller

Node.js webhook service that connects Twilio, ElevenLabs Conversational AI, and HubSpot CRM for the GrowthNGen AI SDR system.

## Architecture

```
Twilio ──────────────────────────────────────────────────────────────────────────┐
  │ outbound call                                                                  │
  ▼                                                                                │
VPS (this service)                                                                 │
  ├── GET  /webhooks/personalisation   ← ElevenLabs fetches contact context      │
  ├── POST /webhooks/tools/*           ← ElevenLabs calls tools during call      │
  ├── POST /webhooks/post-call         ← ElevenLabs POSTs transcript after call  │
  ├── POST /twiml/connect              ← Twilio fetches TwiML to bridge audio    │
  └── POST /calls/trigger              ← Trigger a call (from ProspectOS / cron) │
  
ElevenLabs ─── audio ───► Prospect phone
```

## Phases

| Phase | Feature | Endpoints |
|-------|---------|-----------|
| 1 | Personalisation webhook | `GET /webhooks/personalisation` |
| 2 | Server tool endpoints | `POST /webhooks/tools/*` |
| 3 | Post-call processing | `POST /webhooks/post-call` |
| 4 | Outbound call trigger | `POST /calls/trigger` |

## Prerequisites

- Node.js 20+
- PM2 (`npm install -g pm2`)
- Nginx + Certbot (on VPS)
- A DigitalOcean Droplet (Sydney region, Basic $12/month) with public IP

## Setup

### 1. Clone and install

```bash
git clone https://github.com/liammcilveen/growthngen-caller.git
cd growthngen-caller
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
nano .env   # fill in all values
```

### 3. Set up HTTPS with sslip.io

Replace `A-B-C-D` with your Droplet IP (hyphens not dots):

```bash
# Copy nginx config
cp nginx.conf /etc/nginx/sites-available/growthngen-caller
# Edit the file to replace A-B-C-D with your actual IP
nano /etc/nginx/sites-available/growthngen-caller

# Enable site
ln -s /etc/nginx/sites-available/growthngen-caller /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# Issue cert (e.g. for IP 143.198.45.67 → 143-198-45-67.sslip.io)
certbot --nginx -d 143-198-45-67.sslip.io
```

Your VPS_HOST in `.env` should then be `143-198-45-67.sslip.io`.

### 4. Start with PM2

```bash
mkdir -p logs
pm2 start pm2.config.js
pm2 save
pm2 startup   # follow the printed command to enable auto-start
```

### 5. Configure ElevenLabs agent

In the ElevenLabs agent settings for Will (`agent_9601km24ham8fycv2rhk2853pqbt`):

- **Personalisation webhook URL:** `https://A-B-C-D.sslip.io/webhooks/personalisation`
- **Personalisation webhook secret:** value of `ELEVENLABS_WEBHOOK_SECRET` in `.env`
- **Server tools:** Add each tool from the JSON configs at the top of `src/webhooks/tools.js`
- **Post-call webhook URL:** `https://A-B-C-D.sslip.io/webhooks/post-call`
- **Post-call webhook secret:** same `ELEVENLABS_WEBHOOK_SECRET`

## Triggering calls

### Single call (from ProspectOS dashboard)

```bash
curl -X POST https://A-B-C-D.sslip.io/calls/trigger \
  -H "Authorization: Bearer $TRIGGER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"hubspot_contact_id": "12345", "agent": "will"}'
```

### Batch (CLI)

```bash
# Preview — no calls triggered
node src/scripts/triggerBatch.js --lead-status "New" --max 10 --dry-run

# Trigger up to 10 calls, 3 at a time
node src/scripts/triggerBatch.js --lead-status "New" --max 10 --concurrency 3
```

## Smoke tests

```bash
# Run against local dev server (start with: node src/app.js)
bash tests/phase1.sh
bash tests/phase2.sh
bash tests/phase3.sh
bash tests/phase4.sh
```

## Logs

```bash
pm2 logs growthngen-caller          # live log tail
pm2 logs growthngen-caller --lines 100  # last 100 lines
tail -f logs/app.log                # structured JSON logs
```

## Environment variables

See `.env.example` for the full list with descriptions.

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | HTTP port (default 3000) |
| `ELEVENLABS_API_KEY` | Yes | ElevenLabs API key |
| `ELEVENLABS_AGENT_ID` | Yes | Will agent ID |
| `ELEVENLABS_AGENT_ID_KATE` | No | Kate agent ID |
| `ELEVENLABS_WEBHOOK_SECRET` | Yes | HMAC secret for EL webhooks |
| `TWILIO_ACCOUNT_SID` | Yes | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Yes | Outbound caller ID (+61...) |
| `HUBSPOT_API_KEY` | Yes | HubSpot private app token |
| `ANTHROPIC_API_KEY` | Yes | Claude API key (post-call summarisation) |
| `CALCOM_API_KEY` | Yes | Cal.com API key |
| `TRIGGER_API_KEY` | Yes | Bearer token for /calls/trigger |
| `VPS_HOST` | Yes | Public hostname e.g. `143-198-45-67.sslip.io` |
