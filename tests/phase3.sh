#!/usr/bin/env bash
# Phase 3 smoke test — Post-Call Webhook
# Note: HMAC not sent — only valid if ELEVENLABS_WEBHOOK_SECRET is unset (dev mode)
# In production ELEVENLABS_WEBHOOK_SECRET must be set and requests must be signed.
# Usage: bash tests/phase3.sh [host]

HOST="${1:-http://localhost:3000}"

echo "=== Phase 3: Post-Call Webhook ==="
echo "Host: $HOST"
echo ""

PASS=0
FAIL=0

run() {
  local label="$1"
  local payload="$2"
  local expect="$3"

  local out
  out=$(curl -s -w "\n__STATUS__%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "$HOST/webhooks/post-call")
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

MINIMAL_TRANSCRIPT='[{"role":"agent","message":"Hi this is Will from GrowthNGen"},{"role":"user","message":"Not interested thanks"}]'

# 3a. Valid payload with transcript — should respond immediately with received:true
run "valid payload" \
  "{\"conversation_id\": \"test_conv_001\", \"transcript\": $MINIMAL_TRANSCRIPT, \"metadata\": {\"call_duration_secs\": 45}}" \
  '"received"'

# 3b. Empty transcript — should still respond 200 (processing is async)
run "empty transcript" \
  '{"conversation_id": "test_conv_002", "transcript": [], "metadata": {}}' \
  '"received"'

# 3c. Missing conversation_id — webhook is lenient (no required fields enforced at HTTP layer)
run "minimal payload" \
  '{}' \
  '"received"'

echo ""
echo "Results: $PASS passed, $FAIL failed"
echo ""
echo "NOTE: Async processing runs in the background after response."
echo "      Check logs/app.log for disposition + HubSpot write results."
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
