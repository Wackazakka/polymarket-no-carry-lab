/**
 * Minimal HTTP control API: status, plans, confirm, arm/disarm, panic.
 * No frontend. Idempotent where specified.
 * POST /panic: sets panic=true, disarms, and clears the plan queue.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "http";
import { getModeState } from "./mode_manager";
import { getPlans as getQueuedPlans, queueLength, clearQueue } from "./plan_queue";
import { getPlans as getLastScanPlans } from "../control/plan_store";
import { setMode } from "./mode_manager";
import { panicStop } from "./mode_manager";

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
        const limitParam = url.includes("?") ? new URLSearchParams(url.split("?")[1]).get("limit") : null;
        const limitNum = limitParam != null ? Number(limitParam) : NaN;
        const out = Number.isFinite(limitNum) && limitNum > 0 ? p.plans.slice(0, limitNum) : p.plans;
        sendJson(res, 200, { lastScanTs: p.lastScanTs, count: p.count, plans: out, meta: p.meta });
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
