# Control API

HTTP API for status, plans, and execution mode. Base URL is configurable (default port 3344).

---

## GET /plans and HEAD /plans

**GET** returns the last-scan proposed plans with optional filtering and pagination. **HEAD** accepts the same query params and returns 200 with the same headers (X-Plans-Total, X-Plans-Filtered, X-Build-Id) and no body (e.g. `curl -I .../plans?limit=2`). Order is deterministic: by `ev_breakdown.net_ev` descending, then `created_at` descending, then `plan_id` ascending (tiebreaker).

### Query parameters

| Param          | Type   | Default | Description |
|----------------|--------|---------|-------------|
| `limit`       | number | 50      | Page size (1–200, clamped). |
| `offset`      | number | 0       | Skip first N plans (must be ≥ 0). |
| `min_ev`      | number | —       | Only plans with `ev_breakdown.net_ev >= min_ev`. |
| `category`    | string | —       | Exact match on `category`. Empty/whitespace = not applied. |
| `assumption_key` | string | —    | Exact match on `assumption_key`. Empty/whitespace = not applied. |

- All string params are trimmed; missing or empty-after-trim is treated as “not provided”.
- Unknown query params cause **400** with `invalid_query` and a `details` array.

### Response (200)

```json
{
  "count_total": 42,
  "count_returned": 10,
  "limit": 50,
  "offset": 0,
  "plans": [ ... ]
}
```

- **count_total** — Number of plans after filters (before pagination). Equals `X-Plans-Filtered` header.
- **count_returned** — Length of `plans` in this response.
- **limit**, **offset** — Applied pagination (defaults or clamped).

### Response headers

| Header             | Meaning |
|--------------------|---------|
| `X-Plans-Total`    | Unfiltered plan store count (last scan). |
| `X-Plans-Filtered` | Same as `count_total` (filtered count before pagination). |
| `X-Build-Id`       | Build/deploy id (e.g. `GIT_SHA` or package version). |

### Error response (400)

Invalid query (e.g. unknown param or `offset < 0`):

```json
{
  "error": "invalid_query",
  "details": [ "unknown query param: foo", "offset must be >= 0" ]
}
```

---

## GET /book and HEAD /book

**GET** returns top-of-book for a given outcome token id. **HEAD** accepts the same query and returns 200 with the same headers and no body. Works for both YES and NO outcome tokens (parameter name `no_token_id` is kept for backward compatibility).

### Query parameters

| Param          | Type   | Description |
|----------------|--------|-------------|
| `no_token_id`  | string | **Required.** Outcome token id (YES or NO; Polymarket CLOB asset id). Trimmed; missing or blank → 400. |

- Only `no_token_id` is allowed. Any other query param → **400** with `invalid_query` and `details`.

### Response (200)

```json
{
  "no_token_id": "12345",
  "noBid": 0.49,
  "noAsk": 0.50,
  "spread": 0.01,
  "depthSummary": {
    "bidLiquidityUsd": 1000,
    "askLiquidityUsd": 800,
    "levels": 5
  }
}
```

- **no_token_id** — Normalized token id used for the book.
- **noBid**, **noAsk**, **spread** — Top-of-book levels (numbers or null).
- **depthSummary** — `bidLiquidityUsd`, `askLiquidityUsd`, `levels`.

### Response headers

| Header       | Meaning |
|--------------|---------|
| `X-Build-Id` | Build/deploy id. |

### Error responses

- **400** — Missing or invalid query:
  - `no_token_id` missing or blank: `{ "error": "no_token_id required" }`
  - Unknown param(s): `{ "error": "invalid_query", "details": [ "unknown query param: ..." ] }`
- **404** — No book for that token: `{ "error": "book_not_found" }`

Example: `curl -s "http://localhost:3344/book?no_token_id=12345"`

---

## GET /fill

Simulated fill against the in-memory orderbook for a given outcome token (YES or NO): buy (hit asks) or sell (hit bids) for a target `size_usd`. Returns fill summary with avg price, levels used, and slippage. Parameter name `no_token_id` accepts any outcome token id.

### Query parameters

| Param          | Type   | Description |
|----------------|--------|-------------|
| `no_token_id`  | string | **Required.** Outcome token id (YES or NO). Trimmed; missing or blank → 400. |
| `side`         | string | **Required.** `buy` or `sell`. |
| `size_usd`     | number | **Required.** Target size in USD. Must be > 0; clamped to max 10,000. |

- Only `no_token_id`, `side`, and `size_usd` are allowed. Any other query param → **400** with `invalid_query` and `details`.

### Response (200)

```json
{
  "no_token_id": "12345",
  "side": "buy",
  "size_usd": 100,
  "top": { "noBid": 0.49, "noAsk": 0.50, "spread": 0.01 },
  "filled_usd": 100,
  "filled_shares": 200.0,
  "avg_price": 0.50,
  "levels_used": 3,
  "slippage_pct": 0.12
}
```

- **top** — Top-of-book at request time (noBid, noAsk, spread).
- **filled_usd** — USD spent (buy) or proceeds (sell).
- **filled_shares** — Shares filled (may be less than full size if book is thin).
- **avg_price** — filled_usd / filled_shares.
- **slippage_pct** — Buy: (avg_price - topAsk) / topAsk × 100; sell: (topBid - avg_price) / topBid × 100.

Partial fills still return 200 with filled_usd &lt; size_usd as applicable.

### Error responses

- **400** — Missing or invalid query: `no_token_id required`, `side must be buy or sell`, `size_usd must be a positive number`, or `invalid_query` with `details`.
- **404** — No book for that token: `{ "error": "book_not_found" }`.

Example: `curl -s "http://localhost:3344/fill?no_token_id=12345&side=buy&size_usd=100"`

---

## GET /books-debug and HEAD /books-debug

**GET** returns a debug snapshot of the in-memory orderbook store (size and sample keys). **HEAD** returns 200 with the same headers and no body. Useful to verify that books are loaded for carry/NO strategies (e.g. why `carry_debug.no_book_or_ask` is high).

- No query params allowed. Any query param → **400** with `invalid_query` and `details`.

### Response (200)

```json
{
  "size": 42,
  "sampleKeys": ["12345678901", "98765432101"],
  "note": "sampleKeys are internal normalized book keys (digits-only) used by /book and /fill"
}
```

Example: `curl -s "http://localhost:3344/books-debug"`

---

### Examples (GET /plans)

```bash
# Default pagination (limit=50, offset=0)
curl -s "http://localhost:3344/plans"

# Second page, 10 per page
curl -s "http://localhost:3344/plans?limit=10&offset=10"

# Only plans with net EV >= 20
curl -s "http://localhost:3344/plans?min_ev=20"

# Filter by category
curl -s "http://localhost:3344/plans?category=Politics"

# With headers (for debugging)
curl -i -s "http://localhost:3344/plans?limit=5"
```

### Post-deploy smoke test

Run with the app already running (e.g. after `npm start`). Expect 200, consistent counts, and valid JSON.

```bash
BASE="${BASE_URL:-http://localhost:3344}"
echo "=== GET /plans ==="
r=$(curl -s -w "\n%{http_code}" "$BASE/plans")
code=$(echo "$r" | tail -n1)
body=$(echo "$r" | sed '$d')
echo "HTTP $code"
echo "$body" | jq -e '.count_total >= 0 and .count_returned >= 0 and .limit > 0 and .offset >= 0 and (.plans | type) == "array"' || exit 1
echo "=== GET /plans with limit (headers) ==="
curl -s -i "$BASE/plans?limit=2" | head -20
echo "=== Expect 400 for unknown param ==="
curl -s -w "\n%{http_code}" "$BASE/plans?unknown=1" | tail -1 | grep -q 400 || exit 1
echo "Smoke OK"
```

Set `BASE_URL` if your API is not on localhost:3344.
