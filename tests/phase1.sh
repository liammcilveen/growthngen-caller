#!/usr/bin/env bash
# Phase 1 smoke test — Personalisation webhook
# Usage: bash tests/phase1.sh [host]
# Default host: http://localhost:3000

HOST="${1:-http://localhost:3000}"

echo "=== Phase 1: Personalisation Webhook ==="
echo "Host: $HOST"
echo ""

PASS=0
FAIL=0

run() {
  local label="$1"
  local args=("${@:2}")
  local out
  out=$(curl -s -w "\n__STATUS__%{http_code}" "${args[@]}")
  local body
  body=$(echo "$out" | sed '$d')
  local status
  status=$(echo "$out" | tail -1 | sed 's/__STATUS__//')

  if echo "$body" | grep -q '"dynamic_variables"'; then
    echo "  PASS [$label] HTTP $status — dynamic_variables present"
    ((PASS++))
  else
    echo "  FAIL [$label] HTTP $status — $body"
    ((FAIL++))
  fi
}

# 1a. With known phone (should return contact data or safe defaults)
run "phone param" \
  "$HOST/webhooks/personalisation?caller_id=%2B61412000000"

# 1b. With unknown phone (should return defaults, not 500)
run "unknown phone" \
  "$HOST/webhooks/personalisation?caller_id=%2B61999999999"

# 1c. No params (should return defaults gracefully)
run "no params" \
  "$HOST/webhooks/personalisation"

# 1d. Health check
health=$(curl -s -o /dev/null -w "%{http_code}" "$HOST/health")
if [ "$health" = "200" ]; then
  echo "  PASS [health check] HTTP 200"
  ((PASS++))
else
  echo "  FAIL [health check] HTTP $health"
  ((FAIL++))
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
