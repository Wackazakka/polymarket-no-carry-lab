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

const MAX_PLANS_LIMIT = 500;

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

      if (method === "GET" && path === "/plans") {
        const p = getLastScanPlans();
        const params = url.includes("?") ? new URLSearchParams(url.split("?")[1]) : new URLSearchParams();

        const limitParam = params.get("limit");
        const limitNum = limitParam != null ? Number(limitParam) : NaN;
        const effectiveLimit =
          Number.isFinite(limitNum) && limitNum > 0 ? Math.min(Math.floor(limitNum), MAX_PLANS_LIMIT) : null;

        const minEvParam = params.get("min_ev");
        const minEvRaw = minEvParam != null ? Number(minEvParam) : NaN;
        const hasMinEv = Number.isFinite(minEvRaw);
        const minEv = hasMinEv ? minEvRaw : 0;

        const categoryParam = params.get("category");
        const category = categoryParam != null ? String(categoryParam).trim() : "";
        const hasCategory = category !== "";

        const assumptionKeyParam = params.get("assumption_key");
        const assumptionKey = assumptionKeyParam != null ? String(assumptionKeyParam).trim() : "";
        const hasAssumptionKey = assumptionKey !== "";

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
        const sorted = [...filtered].sort((a, b) => {
          const evA = netEv(a);
          const evB = netEv(b);
          if (evB !== evA) return evB - evA;
          return createdAt(b).localeCompare(createdAt(a));
        });

        const total = p.plans.length;
        const filteredCount = sorted.length;
        const out = effectiveLimit != null ? sorted.slice(0, effectiveLimit) : sorted;
        const payload = { lastScanTs: p.lastScanTs, count: filteredCount, plans: out, meta: p.meta };
        res.setHeader("X-Plans-Total", String(total));
        res.setHeader("X-Plans-Filtered", String(filteredCount));
        res.setHeader("X-Build-Id", getBuildId());
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
