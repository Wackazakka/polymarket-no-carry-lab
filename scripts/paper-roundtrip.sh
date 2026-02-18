#!/usr/bin/env bash
# Paper roundtrip: fetch top N plans, simulate buy+sell at size_usd=100, sort by lowest roundtrip cost.
# Output TSV: plan_id  no_token_id  buy_avg  sell_avg  roundtrip_cost_pct  levels_buy  levels_sell
# Usage: ./scripts/paper-roundtrip.sh   OR   BASE_URL=... LIMIT=10 ./scripts/paper-roundtrip.sh
# Requires: curl, jq. App must be running (e.g. npm start).
set -euo pipefail
BASE="${BASE_URL:-http://localhost:3344}"
LIMIT="${LIMIT:-20}"
SIZE_USD="${SIZE_USD:-100}"

plans_json=$(curl -s --max-time 10 "$BASE/plans?limit=$LIMIT")
count=$(echo "$plans_json" | jq -r '.count_returned // 0')
if [[ "$count" -eq 0 ]]; then
  echo "No plans returned from $BASE/plans?limit=$LIMIT"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo -e "plan_id\tno_token_id\tbuy_avg\tsell_avg\troundtrip_cost_pct\tlevels_buy\tlevels_sell"
for i in $(seq 0 $((count - 1))); do
  plan_id=$(echo "$plans_json" | jq -r ".plans[$i].plan_id // empty")
  no_token_id=$(echo "$plans_json" | jq -r ".plans[$i].no_token_id // empty")
  if [[ -z "$plan_id" || -z "$no_token_id" ]]; then
    continue
  fi
  buy_res=$(curl -s --max-time 5 "$BASE/fill?no_token_id=${no_token_id}&side=buy&size_usd=$SIZE_USD" || echo '{"error":"request_failed"}')
  sell_res=$(curl -s --max-time 5 "$BASE/fill?no_token_id=${no_token_id}&side=sell&size_usd=$SIZE_USD" || echo '{"error":"request_failed"}')

  buy_avg=$(echo "$buy_res" | jq -r 'if .avg_price then .avg_price else empty end')
  sell_avg=$(echo "$sell_res" | jq -r 'if .avg_price then .avg_price else empty end')
  levels_buy=$(echo "$buy_res" | jq -r 'if .levels_used then .levels_used else 0 end')
  levels_sell=$(echo "$sell_res" | jq -r 'if .levels_used then .levels_used else 0 end')

  if [[ -z "$buy_avg" || "$buy_avg" == "null" || "${buy_avg:-0}" == "0" ]]; then
    roundtrip_cost_pct="999"
  else
    if [[ -n "$sell_avg" && "$sell_avg" != "null" ]]; then
      roundtrip_cost_pct=$(awk "BEGIN { printf \"%.4f\", ($buy_avg - $sell_avg) / $buy_avg * 100 }" 2>/dev/null || echo "999")
    else
      roundtrip_cost_pct="999"
    fi
  fi
  echo -e "${plan_id}\t${no_token_id}\t${buy_avg:-}\t${sell_avg:-}\t${roundtrip_cost_pct}\t${levels_buy:-0}\t${levels_sell:-0}"
done | sort -t$'\t' -k5 -n
