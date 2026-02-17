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

const DEFAULT_PLANS_LIMIT = 50;
const MAX_PLANS_LIMIT = 200;
const ALLOWED_PLANS_PARAMS = ["limit", "offset", "min_ev", "category", "assumption_key"] as const;

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

  if (details.length > 0) return { ok: false, details };

  return {
    ok: true,
    query: {
      limit,
      offset,
      minEv,
      category,
      assumptionKey,
    },
  };
}

interface PlansQuery {
  limit: number;
  offset: number;
  minEv: number | null;
  category: string | undefined;
  assumptionKey: string | undefined;
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

export function createControlApi(port: number, handlers: ControlApiHandlers) {
  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0];
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && path === "/status") {
        const state = getModeState();
        const p = getLastScanPlans();
        res.setHeader("X-Build-Id", getBuildId());
        sendJson(res, 200, {
          mode: state.mode,
          panic: state.panic,
          queue_length: queueLength(),
          lastScanTs: p.lastScanTs,
          proposedCountLastScan: p.count,
        });
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
        let filtered: PlanRow[] = p.plans;
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
        const out = sorted.slice(q.offset, q.offset + q.limit);
        const count_returned = out.length;
        // X-Plans-Total = unfiltered store count; X-Plans-Filtered = count_total (same as response count_total)
        res.setHeader("X-Plans-Total", String(p.plans.length));
        res.setHeader("X-Plans-Filtered", String(count_total));
        res.setHeader("X-Build-Id", getBuildId());
        if (method === "HEAD") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end();
          return;
        }
        const payload = { count_total, count_returned, limit: q.limit, offset: q.offset, plans: out };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
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
