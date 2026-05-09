#!/usr/bin/env bash
# Phase 2 smoke test — Server Tool Endpoints
# Note: HMAC signature not sent — only valid if ELEVENLABS_WEBHOOK_SECRET is unset (dev mode)
# Usage: bash tests/phase2.sh [host]

HOST="${1:-http://localhost:3000}"

echo "=== Phase 2: Server Tool Endpoints ==="
echo "Host: $HOST"
echo "Note: Run with ELEVENLABS_WEBHOOK_SECRET unset for these tests to pass auth"
echo ""

PASS=0
FAIL=0

run() {
  local label="$1"
  local endpoint="$2"
  local payload="$3"
  local expect="$4"   # string that must appear in response body

  local out
  out=$(curl -s -w "\n__STATUS__%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "$HOST$endpoint")
  local body
  body=$(echo "$out" | sed '$d')
  local status
  status=$(echo "$out" | tail -1 | sed 's/__STATUS__//')

  if echo "$body" | grep -q "$expect"; then
    echo "  PASS [$label] HTTP $status"
    ((PASS++))
  else
    echo "  FAIL [$label] HTTP $status — expected '$expect' in: $body"
    ((FAIL++))
  fi
}

# lookup_contact — no identifier provided, should return found:false or found:true
run "lookup_contact (no id)" \
  "/webhooks/tools/lookup_contact" \
  '{"phone_number": "+61999999999"}' \
  '"found"'

# book_meeting — missing required email → validation error
run "book_meeting (missing email)" \
  "/webhooks/tools/book_meeting" \
  '{"prospect_name": "Test User"}' \
  '"error"'

# book_meeting — with email but no slot (fetches cal.com) → success or failure message
run "book_meeting (valid payload)" \
  "/webhooks/tools/book_meeting" \
  '{"prospect_name": "Test User", "email": "test@example.com"}' \
  '"success"'

# update_deal_stage — missing deal_id → validation error
run "update_deal_stage (missing deal_id)" \
  "/webhooks/tools/update_deal_stage" \
  '{"new_stage": "qualified"}' \
  '"error"'

# flag_hot_lead — missing deal_id → validation error
run "flag_hot_lead (missing deal_id)" \
  "/webhooks/tools/flag_hot_lead" \
  '{}' \
  '"error"'

# end_call — valid payload
run "end_call (valid)" \
  "/webhooks/tools/end_call" \
  '{"disposition": "not_interested", "notes": "Prospect not interested in current solution"}' \
  '"success"'

# end_call — invalid disposition → validation error
run "end_call (bad disposition)" \
  "/webhooks/tools/end_call" \
  '{"disposition": "INVALID", "notes": "test"}' \
  '"error"'

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
