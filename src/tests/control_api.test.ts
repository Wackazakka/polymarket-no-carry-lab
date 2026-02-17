/**
 * Smoke tests for control API: GET /plans debug headers and malformed query handling.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { request } from "node:http";
import { createControlApi } from "../ops/control_api";
import { setPlans, getPlans } from "../control/plan_store";

function httpGet(url: string): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      { host: u.hostname, port: u.port || "80", path: u.pathname + u.search, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers[k.toLowerCase()] = v;
            else if (Array.isArray(v) && v[0]) headers[k.toLowerCase()] = v[0];
          }
          resolve({ statusCode: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf-8") });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function startServer(): Promise<{ server: ReturnType<typeof createControlApi>; port: number }> {
  setPlans(
    [
      {
        plan_id: "test-1",
        created_at: new Date().toISOString(),
        market_id: "m1",
        category: "Politics",
        assumption_key: "ak1",
        ev_breakdown: { net_ev: 10 },
        status: "proposed",
      },
      {
        plan_id: "test-2",
        created_at: new Date().toISOString(),
        market_id: "m2",
        category: "uncategorized",
        assumption_key: "ak2",
        ev_breakdown: { net_ev: 5 },
        status: "proposed",
      },
    ],
    new Date().toISOString(),
    {}
  );
  const server = createControlApi(0, { confirmHandler: async () => null });
  return new Promise((resolve) => {
    if (server.listening) {
      const addr = server.address() as { port: number };
      return resolve({ server, port: addr.port });
    }
    server.once("listening", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

function closeServer(server: ReturnType<typeof createControlApi>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("control API GET /plans", () => {
  it("returns 200 with X-Plans-Total and X-Plans-Filtered headers (numeric)", async () => {
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/plans?limit=abc&min_ev=abc&category=%20`);
      assert.strictEqual(res.statusCode, 200, "status 200");
      const total = res.headers["x-plans-total"];
      const filtered = res.headers["x-plans-filtered"];
      assert(total != null, "X-Plans-Total header present");
      assert(filtered != null, "X-Plans-Filtered header present");
      assert.strictEqual(Number.isNaN(Number(total)), false, "X-Plans-Total is numeric");
      assert.strictEqual(Number.isNaN(Number(filtered)), false, "X-Plans-Filtered is numeric");
      const body = JSON.parse(res.body) as { count: number; plans: unknown[] };
      assert.strictEqual(typeof body.count, "number");
      assert(Array.isArray(body.plans));
    } finally {
      await closeServer(server);
    }
  });

  it("X-Plans-Total equals raw store count, X-Plans-Filtered equals after filters", async () => {
    const { server, port } = await startServer();
    try {
      const storeBefore = getPlans();
      const res = await httpGet(`http://127.0.0.1:${port}/plans`);
      const total = res.headers["x-plans-total"];
      const filtered = res.headers["x-plans-filtered"];
      assert.strictEqual(total, String(storeBefore.plans.length), "X-Plans-Total matches store");
      const body = JSON.parse(res.body) as { count: number };
      assert.strictEqual(filtered, String(body.count), "X-Plans-Filtered matches response count");
    } finally {
      await closeServer(server);
    }
  });
});
