# Polymarket NO-Carry Lab v0.2

Read-only, **paper-trading** simulator that scans Polymarket CLOB markets for “NO near 1.00” opportunities, simulates fills conservatively, enforces correlated-risk caps, persists state to SQLite, and generates daily + on-demand reports.

**This project does not place real orders. It is designed to disprove the strategy (anti-hype) with boring, honest numbers.**

---

## Safety guarantees (no live trading)

- **No private keys, no wallets, no signing, no order placement.** No code path can send real orders or sign anything.
- Only REST/WebSocket **read-only** data and local simulation.
- On startup, `src/safety/ban_live_trading.ts` scans environment and config for forbidden keys (e.g. `PRIVATE_KEY`, `WALLET`, `SIGN`) and **exits immediately** if found.
- All execution is paper-only: proposed trades are simulated with configurable slippage and depth; positions and PnL are stored locally.

---

## Setup

1. **Clone and install**
   ```bash
   npm install
   ```
   **Note:** `better-sqlite3` is a native addon. If install fails, ensure you have build tools (e.g. Xcode Command Line Tools on macOS: `xcode-select --install`). The project uses SQLite for persistence; the DB file is created at `./data/polymarket_lab.db` (or the path in `config.db.path`).

2. **Config**
   - Copy the example config to a local `config.json`:
     ```bash
     cp src/config/config.example.json src/config/config.json
     ```
   - Or put `config.json` in the project root.
   - Edit `config.json` to tune thresholds (see below). The loader validates with zod and falls back to `config.example.json` if `config.json` is missing.

3. **Run**
   ```bash
   npm run dev
   ```
   The process stays running: it polls markets on the configured interval, evaluates candidates, proposes paper trades, enforces the risk engine, and writes reports.

   - **Build and run production build:**
     ```bash
     npm run build && npm start
     ```

---

## Config (high level)

- **`api`** — CLOB REST/WS and Gamma base URLs.
- **`scanner`** — `pollIntervalMs`, `maxOrderbookSubscriptions`.
- **`selection`** — `min_no_price`, `max_spread`, `min_liquidity_usd`, `max_time_to_resolution_hours`.
- **`fees`** — `fee_bps`, `p_tail`, `tail_loss_fraction`, `ambiguous_resolution_p_tail_multiplier`.
- **`simulation`** — `default_order_size_usd`, `slippage_bps`, `max_fill_depth_levels`.
- **`risk`** — Per-trade/market/total/category/assumption/resolution-window caps, `kill_switch_enabled`, `resolution_windows`.
- **`reporting`** — `report_dir`, `daily_report_hour_local` (Europe/Oslo), `report_interval_minutes`, `print_top_n`.
- **`db`** — `path` (default `./data/polymarket_lab.db`). The `data/` directory is created if missing.

---

## What reports mean

Reports are written to `report_dir` (default `./reports/`) as timestamped `.txt` and `.json` files, and printed to the console.

- **Scan summary** — Candidates scanned, passed filters, trades proposed, blocked by risk.
- **Top block reasons** — Why proposed trades were blocked (e.g. category cap, assumption cap).
- **Open positions** — Count and total exposure (USD).
- **Exposure by category / assumption group / resolution window** — Correlated risk breakdown.
- **Expected PnL (paper)** — Sum of (1 − entry) × size for open NO positions. Labeled as expected, not realized; tail/loss is in the EV model.
- **Worst-case if one assumption fails** — For each assumption group, total exposure that could be lost if that assumption fails (NO loses).
- **Top N best candidates by net EV** — Best opportunities by conservative net expected value.
- **Top N worst** — Negative EV, ambiguous resolution, or no fill.

---

## Control API

The app exposes a small HTTP API (port in `config.control_api.port`, default 3344) for status, last-scan plans, and execution mode (disarm/arm/panic). See **[docs/API.md](docs/API.md)** for GET /plans query params, response shape, and error format.

**Post-deploy smoke test** (run with app already up):

```bash
bash scripts/smoke-plans.sh
```

Or make it executable once: `chmod +x scripts/smoke-plans.sh` then `./scripts/smoke-plans.sh`. Override base URL with `BASE_URL=http://your-host:3344`.

Quick check: `curl -s http://localhost:3344/plans | jq '.count_total, .count_returned, .limit, .offset'`.

---

## Project structure

```
src/
  config/         config.example.json, load_config.ts
  safety/         ban_live_trading.ts
  markets/        fetch_markets.ts, orderbook_ws.ts
  strategy/       filters.ts, ev.ts, paper_executor.ts
  risk/           risk_engine.ts
  state/          positions.ts, ledger.ts, db.ts
  report/         daily_report.ts
  index.ts        main runner
docs/
  API.md          Control API (GET /plans, etc.)
scripts/
  smoke-plans.sh  Post-deploy smoke test for /plans
```

---

## Notes

- If Polymarket endpoints or response shapes change, the code may log TODOs or missing data and stay runnable with stubs.
- “Boring, honest numbers”: when data is missing, we log it and behave conservatively (e.g. no fill, block trade).
