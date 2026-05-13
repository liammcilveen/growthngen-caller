# HubSpot-Triggered Calling Guide

> Any HubSpot user can queue a contact for an AI SDR call. No Mac, no dashboard access needed.

---

## How to trigger a call from HubSpot

### Option A — Manual (single contact)

1. Open the contact record in HubSpot
2. Click the **Lead Status** property
3. Set it to **`MAKE_CALL`**
4. Save

Will picks up the contact at the next scheduled session window (10:05am or 1:05pm AEST, Mon–Fri) and calls them automatically.

### Option B — Via HubSpot Workflow (bulk / automated)

1. In HubSpot, go to **Automation → Workflows**
2. Create or edit a workflow triggered by any enrolment criteria (e.g. form submission, list membership, deal stage change)
3. Add action: **Set property value** → Contact property → **Lead Status** → `MAKE_CALL`

All enrolled contacts will be queued for the next session.

### Option C — Immediate trigger (curl / API)

To bypass the cron schedule and call right now:

```bash
curl -X POST https://{VPS_HOST}/calls/trigger \
  -H "Authorization: Bearer {TRIGGER_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"hubspot_contact_id": "12345", "agent": "will"}'
```

Replace `{VPS_HOST}` and `{TRIGGER_API_KEY}` with your VPS values from `.env`.

You can also trigger by phone number if the contact isn't in HubSpot yet:

```bash
  -d '{"phone": "+61412345678", "agent": "will"}'
```

Response includes `call_sid` and `status` confirming Twilio accepted the call.

---

## Session schedule

| Session | Time (AEST) | UTC | Days |
|---------|-------------|-----|------|
| Morning | 10:05 am | 00:05 | Mon–Fri |
| Afternoon | 1:05 pm | 03:05 | Mon–Fri |

Contacts with `MAKE_CALL` lead status are picked up at each session and immediately cleared to `ATTEMPTED_TO_CONTACT` so they aren't re-triggered.

---

## What happens after a call

Every completed call automatically creates the following on the HubSpot contact timeline:

| Activity | Where to see it |
|----------|-----------------|
| **Call log** | Contact → Activity → filter by "Calls" |
| **Qualification note** | Contact → Activity → filter by "Notes" |
| **Follow-up task** (callback/human-requested) | Contact → Activity → filter by "Tasks" |
| **Deal** (if qualified_booked or qualified_send_link) | Contact → Deals section |

### Lead Status after call

| Disposition | HubSpot Lead Status |
|-------------|---------------------|
| `qualified_booked` | `MEETING_BOOKED` |
| `qualified_send_link` | `QUALIFIED` |
| `qualified_callback` | `QUALIFIED` |
| `interested_not_qualified` | `UNQUALIFIED` |
| `not_interested` | `NOT_INTERESTED` |
| `no_answer` | `ATTEMPTED_TO_CONTACT` |
| `voicemail_left` | `ATTEMPTED_TO_CONTACT` |
| `gatekeeper_blocked` | `ATTEMPTED_TO_CONTACT` |
| `wrong_number` | `ATTEMPTED_TO_CONTACT` |
| `do_not_call` | `DO_NOT_CONTACT` |
| `human_requested` | `IN_PROGRESS` |
| `declined_ai` | `IN_PROGRESS` |

### Call outcome labels in HubSpot

| Disposition | HubSpot Outcome Label |
|-------------|----------------------|
| All "connected" calls | Connected |
| `no_answer` | No answer |
| `voicemail_left` | Left voicemail |
| `gatekeeper_blocked` | Left live message |
| `wrong_number` | Wrong number |

---

## VPS deploy / reload

After pushing changes to the repo, SSH into the droplet and reload:

```bash
cd ~/growthngen-caller
git pull
pm2 reload pm2.config.js --update-env
pm2 list   # confirm growthngen-caller + will-session-1005 + will-session-1305 all show
```

To run a manual batch session immediately (dry run first):

```bash
node src/scripts/triggerBatch.js --dry-run
node src/scripts/triggerBatch.js --max 5
```

---

## Troubleshooting

**No contacts being called at session time**
- Check `pm2 logs will-session-1005` — should show "X found" at 10:05am UTC
- Confirm at least one contact has `hs_lead_status = MAKE_CALL` with a phone number

**Call triggered but ElevenLabs isn't connecting**
- Check `pm2 logs growthngen-caller` for webhook errors
- Confirm ElevenLabs agent webhook URLs point to `https://{VPS_HOST}/webhooks/...`

**ProspectOS dashboard "Call" button returns an error**
- Confirm `VPS_CALLER_HOST` and `TRIGGER_API_KEY` are set in AIOS `.env`
- Check VPS is reachable: `curl https://{VPS_HOST}/health`
