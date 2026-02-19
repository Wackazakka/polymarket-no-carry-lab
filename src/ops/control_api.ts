/**
 * Minimal HTTP control API: status, plans, confirm, arm/disarm, panic.
 * No frontend. Idempotent where specified.
 * POST /panic: sets panic=true, disarms, and clears the plan queue.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync } from "fs";
import { join } from "path";
import { getModeState } from "./mode_manager";
import { getPlans as getQueuedPlans, queueLength, clearQueue } from "./plan_queue";
import { getPlans as getLastScanPlans } from "../control/plan_store";
import { setMode } from "./mode_manager";
import { panicStop } from "./mode_manager";
import { getTopOfBook, getDepth, getBooksDebug, normalizeBookKey } from "../markets/orderbook_ws";
import { fetchTopOfBookHttp, type HttpTopOfBook } from "../markets/clob_http";
import type { OrderLevel } from "../types";

export type FetchTopOfBookHttpFn = (tokenId: string, baseUrl?: string) => Promise<HttpTopOfBook | null>;

export interface ControlApiOptions {
  clobRestBaseUrl?: string;
  fetchTopOfBookHttp?: FetchTopOfBookHttpFn;
}

const DEFAULT_PLANS_LIMIT = 50;
const MAX_PLANS_LIMIT = 200;
const ALLOWED_PLANS_PARAMS = ["limit", "offset", "min_ev", "category", "assumption_key", "debug", "gate"] as const;

const EV_BREAKDOWN_STRIPPED_KEYS = ["net_ev", "tail_risk_cost", "tailByp", "tail_bypass_reason"] as const;

function stripEvBreakdown(ev: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (ev == null || typeof ev !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const k of EV_BREAKDOWN_STRIPPED_KEYS) {
    if (k in ev) out[k] = ev[k];
  }
  return out;
}

const MAX_FILL_SIZE_USD = 10_000;

function simulateFillFromBook(
  side: "buy" | "sell",
  sizeUsd: number,
  topBid: number | null,
  topAsk: number | null,
  askLevels: OrderLevel[],
  bidLevels: OrderLevel[]
): { filled_usd: number; filled_shares: number; avg_price: number; levels_used: number; slippage_pct: number } {
  let filled_usd = 0;
  let filled_shares = 0;
  let levels_used = 0;

  if (side === "buy") {
    let remaining_usd = sizeUsd;
    for (const level of askLevels) {
      if (remaining_usd <= 0) break;
      const take_shares = Math.min(level.size, remaining_usd / level.price);
      if (take_shares <= 0) continue;
      const cost = take_shares * level.price;
      filled_usd += cost;
      filled_shares += take_shares;
      remaining_usd -= cost;
      levels_used += 1;
    }
  } else {
    if (topBid == null || topBid <= 0) {
      return { filled_usd: 0, filled_shares: 0, avg_price: 0, levels_used: 0, slippage_pct: 0 };
    }
    const target_shares = sizeUsd / topBid;
    let remaining_shares = target_shares;
    for (const level of bidLevels) {
      if (remaining_shares <= 0) break;
      const take_shares = Math.min(level.size, remaining_shares);
      if (take_shares <= 0) continue;
      filled_usd += take_shares * level.price;
      filled_shares += take_shares;
      remaining_shares -= take_shares;
      levels_used += 1;
    }
  }

  const avg_price = filled_shares > 0 ? filled_usd / filled_shares : 0;
  let slippage_pct = 0;
  if (side === "buy" && topAsk != null && topAsk > 0) {
    slippage_pct = ((avg_price - topAsk) / topAsk) * 100;
  } else if (side === "sell" && topBid != null && topBid > 0) {
    slippage_pct = ((topBid - avg_price) / topBid) * 100;
  }

  return { filled_usd, filled_shares, avg_price, levels_used, slippage_pct };
}

function normalizeStr(v: string | null | undefined): string | undefined {
  if (v == null) return undefined;
  const t = String(v).trim();
  return t === "" ? undefined : t;
}
function normalizeNum(v: string | null | undefined): number | undefined {
  if (v == null || String(v).trim() === "") return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

function validatePlansQuery(params: URLSearchParams): { ok: true; query: PlansQuery } | { ok: false; details: string[] } {
  const details: string[] = [];
  for (const key of params.keys()) {
    if (!ALLOWED_PLANS_PARAMS.includes(key as (typeof ALLOWED_PLANS_PARAMS)[number])) {
      details.push(`unknown query param: ${key}`);
    }
  }
  if (details.length > 0) return { ok: false, details };

  const limitRaw = normalizeNum(params.get("limit"));
  const limit =
    limitRaw === undefined
      ? DEFAULT_PLANS_LIMIT
      : Math.min(Math.max(1, Math.floor(limitRaw)), MAX_PLANS_LIMIT);
  const offsetRaw = normalizeNum(params.get("offset"));
  let offset = offsetRaw === undefined ? 0 : Math.floor(offsetRaw);
  if (offset < 0) {
    details.push("offset must be >= 0");
  }
  if (details.length > 0) return { ok: false, details };

  const minEvRaw = normalizeNum(params.get("min_ev"));
  let minEv: number | null = null;
  if (minEvRaw !== undefined) minEv = minEvRaw;

  const category = normalizeStr(params.get("category"));
  const assumptionKey = normalizeStr(params.get("assumption_key"));

  const debugRaw = params.get("debug");
  const debug = debugRaw === "1" || debugRaw === "true";

  const gateRaw = params.get("gate");
  const gate = gateRaw === "0" ? 0 : 1;

  if (details.length > 0) return { ok: false, details };

  return {
    ok: true,
    query: {
      limit,
      offset,
      minEv,
      category,
      assumptionKey,
      debug,
      gate,
    },
  };
}

interface PlansQuery {
  limit: number;
  offset: number;
  minEv: number | null;
  category: string | undefined;
  assumptionKey: string | undefined;
  debug: boolean;
  gate: 0 | 1;
}

function getBuildId(): string {
  if (process.env.GIT_SHA && String(process.env.GIT_SHA).trim()) return String(process.env.GIT_SHA).trim();
  if (process.env.BUILD_ID && String(process.env.BUILD_ID).trim()) return String(process.env.BUILD_ID).trim();
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")) as { version?: string };
    return pkg?.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export type ConfirmResult = { executed: boolean; positionId?: string; reason?: string } | null;

export interface ControlApiHandlers {
  confirmHandler: (planId: string) => Promise<ConfirmResult> | ConfirmResult;
}

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function getClobBaseUrl(options?: ControlApiOptions): string | undefined {
  if (process.env.CLOB_HTTP_BASE && String(process.env.CLOB_HTTP_BASE).trim()) {
    return String(process.env.CLOB_HTTP_BASE).trim();
  }
  return options?.clobRestBaseUrl;
}

export function createControlApi(port: number, handlers: ControlApiHandlers, options?: ControlApiOptions) {
  const doFetchHttp = options?.fetchTopOfBookHttp ?? fetchTopOfBookHttp;
  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0];
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && path === "/status") {
        const state = getModeState();
        const p = getLastScanPlans();
        const statusParams = url.includes("?") ? new URLSearchParams(url.split("?")[1]) : new URLSearchParams();
        const debug = statusParams.get("debug") === "1" || statusParams.get("debug") === "true";
        res.setHeader("X-Build-Id", getBuildId());
        const statusPayload: Record<string, unknown> = {
          mode: state.mode,
          panic: state.panic,
          queue_length: queueLength(),
          lastScanTs: p.lastScanTs,
          proposedCountLastScan: p.count,
          meta: p.meta ?? null,
        };
        if (debug && p.meta != null) statusPayload.meta_full = p.meta;
        sendJson(res, 200, statusPayload);
        return;
      }

      if ((method === "GET" || method === "HEAD") && path === "/plans") {
        const p = getLastScanPlans();
        const params = url.includes("?") ? new URLSearchParams(url.split("?")[1]) : new URLSearchParams();
        const validation = validatePlansQuery(params);
        if (!validation.ok) {
          sendJson(res, 400, { error: "invalid_query", details: validation.details });
          return;
        }
        const q = validation.query;
        const hasMinEv = q.minEv !== null;
        const minEv = q.minEv ?? 0;
        const hasCategory = q.category !== undefined;
        const category = q.category ?? "";
        const hasAssumptionKey = q.assumptionKey !== undefined;
        const assumptionKey = q.assumptionKey ?? "";

        type PlanRow = (typeof p.plans)[number];
        function countOutcomesModes(plans: PlanRow[]): string {
          const counts: Record<string, number> = {};
          for (const row of plans) {
            const outcome = (row as { outcome?: string }).outcome ?? "MISSING";
            const mode = (row as { ev_breakdown?: { mode?: string } }).ev_breakdown?.mode ?? "MISSING";
            const key = `${outcome}:${mode}`;
            counts[key] = (counts[key] ?? 0) + 1;
          }
          const parts = Object.entries(counts)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([k, n]) => `${k}=${n}`);
          return parts.join(" ");
        }

        console.log(`[plans] pre-gate total=${p.plans.length} outcomes=... modes=... (${countOutcomesModes(p.plans)})`);

        let filtered: PlanRow[] = p.plans;
        if (q.gate === 1) {
          filtered = p.plans.filter((row) => {
            const outcome = (row as { outcome?: string }).outcome ?? "MISSING";
            const mode = (row as { ev_breakdown?: { mode?: string } }).ev_breakdown?.mode ?? "MISSING";
            const allowed =
              (outcome === "NO" && (mode === "capture" || mode === "baseline" || mode === "micro_capture_v1")) ||
              (outcome === "YES" && mode === "carry") ||
              outcome === "MISSING" ||
              mode === "MISSING";
            return allowed;
          });
        }

        console.log(`[plans] post-gate total=${filtered.length} outcomes=... modes=... (${countOutcomesModes(filtered)})`);

        if (hasMinEv) {
          filtered = filtered.filter((row) => {
            const netEv = (row as { ev_breakdown?: { net_ev?: number } }).ev_breakdown?.net_ev;
            return typeof netEv === "number" && netEv >= minEv;
          });
        }
        if (hasCategory) {
          filtered = filtered.filter((row) => (row as { category?: string | null }).category === category);
        }
        if (hasAssumptionKey) {
          filtered = filtered.filter((row) => (row as { assumption_key?: string }).assumption_key === assumptionKey);
        }

        const netEv = (row: PlanRow): number => {
          const v = (row as { ev_breakdown?: { net_ev?: number } }).ev_breakdown?.net_ev;
          return typeof v === "number" ? v : -Infinity;
        };
        const createdAt = (row: PlanRow): string => (row as { created_at?: string }).created_at ?? "";
        const planId = (row: PlanRow): string => (row as { plan_id?: string }).plan_id ?? "";
        const sorted = [...filtered].sort((a, b) => {
          const evA = netEv(a);
          const evB = netEv(b);
          if (evB !== evA) return evB - evA;
          const ct = createdAt(b).localeCompare(createdAt(a));
          if (ct !== 0) return ct;
          return planId(a).localeCompare(planId(b));
        });

        const count_total = sorted.length;
        const slice = sorted.slice(q.offset, q.offset + q.limit);
        const count_returned = slice.length;
        // When debug=0/missing: strip ev_breakdown to net_ev, tail_risk_cost, tailByp, tail_bypass_reason. When debug=1: full ev_breakdown.
        const out = q.debug
          ? slice
          : slice.map((row) => {
              const r = row as Record<string, unknown>;
              const ev = r.ev_breakdown as Record<string, unknown> | null | undefined;
              return { ...r, ev_breakdown: stripEvBreakdown(ev) ?? r.ev_breakdown };
            });
        // X-Plans-Total = unfiltered store count; X-Plans-Filtered = count_total (same as response count_total)
        res.setHeader("X-Plans-Total", String(p.plans.length));
        res.setHeader("X-Plans-Filtered", String(count_total));
        res.setHeader("X-Build-Id", getBuildId());
        if (method === "HEAD") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end();
          return;
        }
        // Return stored records (ev_breakdown stripped unless debug=1).
        const payload = {
          count_total,
          count_returned,
          limit: q.limit,
          offset: q.offset,
          meta: p.meta ?? null,
          plans: out,
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }

      if (method === "GET" && path === "/fill") {
        const params = url.includes("?") ? new URLSearchParams(url.split("?")[1]) : new URLSearchParams();
        const allowedFillParams = ["no_token_id", "side", "size_usd"] as const;
        for (const key of params.keys()) {
          if (!allowedFillParams.includes(key as (typeof allowedFillParams)[number])) {
            sendJson(res, 400, { error: "invalid_query", details: [`unknown query param: ${key}`] });
            return;
          }
        }
        const noTokenIdRaw = params.get("no_token_id");
        const noTokenId = noTokenIdRaw != null ? String(noTokenIdRaw).trim() : "";
        if (!noTokenId) {
          sendJson(res, 400, { error: "no_token_id required" });
          return;
        }
        const sideRaw = normalizeStr(params.get("side"));
        if (sideRaw !== "buy" && sideRaw !== "sell") {
          sendJson(res, 400, { error: "side must be buy or sell" });
          return;
        }
        const side = sideRaw as "buy" | "sell";
        const sizeUsdRaw = normalizeNum(params.get("size_usd"));
        if (sizeUsdRaw === undefined || sizeUsdRaw <= 0) {
          sendJson(res, 400, { error: "size_usd must be a positive number" });
          return;
        }
        const sizeUsd = Math.min(sizeUsdRaw, MAX_FILL_SIZE_USD);

        const key = normalizeBookKey(noTokenId) || noTokenId;
        let top = getTopOfBook(noTokenId, 5);
        let price_source: "ws" | "http" = "ws";
        let http_fallback_used = false;
        const wsMissing = top == null || (top.noBid == null && top.noAsk == null);
        if (wsMissing) {
          const httpTop = await doFetchHttp(key, getClobBaseUrl(options));
          if (httpTop != null && (httpTop.noBid != null || httpTop.noAsk != null)) {
            top = {
              noBid: httpTop.noBid,
              noAsk: httpTop.noAsk,
              spread: httpTop.spread,
              depthSummary: { bidLiquidityUsd: 0, askLiquidityUsd: 0, levels: 5 },
            };
            price_source = "http";
            http_fallback_used = true;
          } else {
            sendJson(res, 404, { error: "book_not_found" });
            return;
          }
        }

        let sim: { filled_usd: number; filled_shares: number; avg_price: number; levels_used: number; slippage_pct: number };
        if (http_fallback_used) {
          const price = side === "buy" ? top!.noAsk : top!.noBid;
          if (price == null || price <= 0) {
            sendJson(res, 404, { error: "book_not_found" });
            return;
          }
          const filled_shares = sizeUsd / price;
          sim = {
            filled_usd: sizeUsd,
            filled_shares,
            avg_price: price,
            levels_used: 1,
            slippage_pct: 0,
          };
        } else {
          const askLevels = getDepth(noTokenId, "asks");
          const bidLevels = getDepth(noTokenId, "bids");
          sim = simulateFillFromBook(
            side,
            sizeUsd,
            top!.noBid,
            top!.noAsk,
            askLevels,
            bidLevels
          );
        }
        res.setHeader("X-Build-Id", getBuildId());
        const payload = {
          no_token_id: key,
          side,
          size_usd: sizeUsd,
          top: { noBid: top!.noBid, noAsk: top!.noAsk, spread: top!.spread },
          filled_usd: sim.filled_usd,
          filled_shares: sim.filled_shares,
          avg_price: sim.avg_price,
          levels_used: sim.levels_used,
          slippage_pct: sim.slippage_pct,
          price_source,
          http_fallback_used,
        };
        sendJson(res, 200, payload);
        return;
      }

      if (method === "GET" && path === "/has-book") {
        const params = url.includes("?") ? new URLSearchParams(url.split("?")[1]) : new URLSearchParams();
        const allowedHasBookParams = ["token_id"] as const;
        for (const key of params.keys()) {
          if (!allowedHasBookParams.includes(key as (typeof allowedHasBookParams)[number])) {
            sendJson(res, 400, { error: "invalid_query", details: [`unknown query param: ${key}`] });
            return;
          }
        }
        const tokenIdRaw = params.get("token_id");
        const token_id = tokenIdRaw != null ? String(tokenIdRaw).trim() : "";
        if (!token_id) {
          sendJson(res, 400, { error: "token_id required" });
          return;
        }
        const normalized_key = normalizeBookKey(token_id) || "";
        const booksDebug = getBooksDebug();
        const has_book = booksDebug.hasKey(token_id);
        res.setHeader("X-Build-Id", getBuildId());
        sendJson(res, 200, {
          token_id,
          normalized_key,
          has_book,
          note: "normalized_key is used for orderbook lookup (digits-only); has_book = book exists for that key",
        });
        return;
      }

      if ((method === "GET" || method === "HEAD") && path === "/books-debug") {
        const params = url.includes("?") ? new URLSearchParams(url.split("?")[1]) : new URLSearchParams();
        const paramKeys = [...params.keys()];
        if (paramKeys.length > 0) {
          const details = paramKeys.map((k) => `unknown query param: ${k}`);
          sendJson(res, 400, { error: "invalid_query", details });
          return;
        }
        const debug = getBooksDebug();
        res.setHeader("X-Build-Id", getBuildId());
        if (method === "HEAD") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end();
          return;
        }
        sendJson(res, 200, {
          size: debug.size,
          sampleKeys: debug.sampleKeys,
          note: "sampleKeys are internal normalized book keys (digits-only) used by /book and /fill",
        });
        return;
      }

      if ((method === "GET" || method === "HEAD") && path === "/book") {
        const params = url.includes("?") ? new URLSearchParams(url.split("?")[1]) : new URLSearchParams();
        const allowedBookParams = ["no_token_id"] as const;
        for (const key of params.keys()) {
          if (!allowedBookParams.includes(key as (typeof allowedBookParams)[number])) {
            sendJson(res, 400, { error: "invalid_query", details: [`unknown query param: ${key}`] });
            return;
          }
        }
        const noTokenIdRaw = params.get("no_token_id");
        const noTokenId = noTokenIdRaw != null ? String(noTokenIdRaw).trim() : "";
        if (!noTokenId) {
          sendJson(res, 400, { error: "no_token_id required" });
          return;
        }
        const key = normalizeBookKey(noTokenId) || noTokenId;
        let book = getTopOfBook(noTokenId, 5);
        let price_source: "ws" | "http" = "ws";
        let http_fallback_used = false;
        const wsMissing = book == null || (book.noBid == null && book.noAsk == null);
        if (wsMissing) {
          const httpTop = await doFetchHttp(key, getClobBaseUrl(options));
          if (httpTop != null && (httpTop.noBid != null || httpTop.noAsk != null)) {
            book = {
              noBid: httpTop.noBid,
              noAsk: httpTop.noAsk,
              spread: httpTop.spread,
              depthSummary: { bidLiquidityUsd: 0, askLiquidityUsd: 0, levels: 1 },
            };
            price_source = "http";
            http_fallback_used = true;
          } else {
            sendJson(res, 404, { error: "book_not_found" });
            return;
          }
        }
        res.setHeader("X-Build-Id", getBuildId());
        if (method === "HEAD") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end();
          return;
        }
        const payload = {
          no_token_id: key,
          noBid: book!.noBid,
          noAsk: book!.noAsk,
          spread: book!.spread,
          depthSummary: book!.depthSummary,
          price_source,
          http_fallback_used,
        };
        sendJson(res, 200, payload);
        return;
      }

      if (method === "POST" && path === "/confirm") {
        const body = await parseBody(req);
        const planId = typeof body.plan_id === "string" ? body.plan_id : undefined;
        if (!planId) {
          sendJson(res, 400, { error: "plan_id required" });
          return;
        }
        const result = await Promise.resolve(handlers.confirmHandler(planId));
        if (result === null) {
          sendJson(res, 404, { error: "plan not found" });
          return;
        }
        sendJson(res, 200, result);
        return;
      }

      if (method === "POST" && path === "/disarm") {
        setMode("DISARMED");
        sendJson(res, 200, { ok: true, mode: "DISARMED" });
        return;
      }

      if (method === "POST" && path === "/arm_confirm") {
        setMode("ARMED_CONFIRM");
        sendJson(res, 200, { ok: true, mode: "ARMED_CONFIRM" });
        return;
      }

      if (method === "POST" && path === "/arm_auto") {
        setMode("ARMED_AUTO");
        sendJson(res, 200, { ok: true, mode: "ARMED_AUTO" });
        return;
      }

      if (method === "POST" && path === "/panic") {
        panicStop();
        clearQueue();
        sendJson(res, 200, { ok: true, panic: true, message: "Panic stop: disarmed and queue cleared" });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
  });

  server.listen(port, () => {
    console.log(`[control_api] Listening on port ${port}`);
  });

  return server;
}
