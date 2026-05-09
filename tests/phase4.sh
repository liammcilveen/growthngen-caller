#!/usr/bin/env bash
# Phase 4 smoke test — Outbound Call Trigger + TwiML endpoint
# WARNING: Providing a real phone number WILL trigger a live Twilio call.
#          Use a test number or --dry-run equivalent (omit phone + contact_id).
# Usage: bash tests/phase4.sh [host] [api_key]

HOST="${1:-http://localhost:3000}"
API_KEY="${2:-$TRIGGER_API_KEY}"

echo "=== Phase 4: Outbound Call Trigger ==="
echo "Host: $HOST"
echo ""

PASS=0
FAIL=0

# Auth header
AUTH=""
[ -n "$API_KEY" ] && AUTH="-H \"Authorization: Bearer $API_KEY\""

run() {
  local label="$1"
  local payload="$2"
  local expect_status="$3"
  local expect_body="$4"

  local out
  out=$(curl -s -w "\n__STATUS__%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    ${API_KEY:+-H "Authorization: Bearer $API_KEY"} \
    -d "$payload" \
    "$HOST/calls/trigger")
  local body
  body=$(echo "$out" | sed '$d')
  local status
  status=$(echo "$out" | tail -1 | sed 's/__STATUS__//')

  local ok=1
  [ "$status" != "$expect_status" ] && ok=0
  [ -n "$expect_body" ] && ! echo "$body" | grep -q "$expect_body" && ok=0

  if [ "$ok" = "1" ]; then
    echo "  PASS [$label] HTTP $status"
    ((PASS++))
  else
    echo "  FAIL [$label] HTTP $status (expected $expect_status) — $body"
    ((FAIL++))
  fi
}

# 4a. Missing both phone and contact_id → 400
run "missing identifiers" \
  '{"agent": "will"}' \
  "400" \
  '"error"'

# 4b. Bad agent value → 400
run "invalid agent" \
  '{"phone": "+61412000000", "agent": "invalid"}' \
  "400" \
  '"error"'

# 4c. No auth header when TRIGGER_API_KEY is set
if [ -n "$API_KEY" ]; then
  out=$(curl -s -w "\n__STATUS__%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -d '{"phone": "+61412000000"}' \
    "$HOST/calls/trigger")
  status=$(echo "$out" | tail -1 | sed 's/__STATUS__//')
  if [ "$status" = "401" ]; then
    echo "  PASS [no auth → 401] HTTP $status"
    ((PASS++))
  else
    echo "  FAIL [no auth → 401] HTTP $status (expected 401)"
    ((FAIL++))
  fi
fi

# 4d. TwiML endpoint (POST /twiml/connect)
twiml_out=$(curl -s -X POST \
  -d "CallSid=CA12345&agent_id=agent_test" \
  "$HOST/twiml/connect?agent_id=agent_test")
if echo "$twiml_out" | grep -q '<Connect>'; then
  echo "  PASS [twiml/connect] returns TwiML with <Connect>"
  ((PASS++))
else
  echo "  FAIL [twiml/connect] — $twiml_out"
  ((FAIL++))
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
echo ""
echo "NOTE: A real call trigger (valid phone + Twilio configured) was NOT tested here."
echo "      Use the ProspectOS dashboard or a manual curl with a real number to test live calling."
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
