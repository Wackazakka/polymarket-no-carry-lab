#!/usr/bin/env bash
# Post-deploy smoke test for GET /plans. Run with the app already running (e.g. npm start).
# Usage: bash scripts/smoke-plans.sh   OR   BASE_URL=http://localhost:3344 ./scripts/smoke-plans.sh
set -euo pipefail
# Default only when BASE_URL is unset; if set to empty, we error below
BASE="${BASE_URL-http://localhost:3344}"
if [[ -z "$BASE" ]]; then
  echo "Error: BASE_URL must be set and non-empty (e.g. http://localhost:3344)" >&2
  exit 1
fi
echo "=== GET /plans ==="
r=$(curl -s --max-time 3 -w "\n%{http_code}" "$BASE/plans")
code=$(echo "$r" | tail -n1)
body=$(echo "$r" | sed '$d')
echo "HTTP $code"
echo "$body" | jq -e '.count_total >= 0 and .count_returned >= 0 and .limit > 0 and .offset >= 0 and (.plans | type) == "array"' || exit 1
echo "=== GET /plans with limit (headers) ==="
curl -s --max-time 3 -i "$BASE/plans?limit=2" | head -20
echo "=== HEAD /plans (same X-Plans-* headers) ==="
curl -s --max-time 3 -I "$BASE/plans?limit=2" | head -15
echo "=== Expect 400 for unknown param ==="
code400=$(curl -s --max-time 3 -w "%{http_code}" -o /dev/null "$BASE/plans?unknown=1")
[[ "$code400" == "400" ]] || { echo "Expected HTTP 400, got $code400" >&2; exit 1; }
echo "Smoke OK"
