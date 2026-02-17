/**
 * Smoke tests for control API: GET /plans debug headers and malformed query handling.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { request } from "node:http";
import { createControlApi } from "../ops/control_api";
import { setPlans, getPlans } from "../control/plan_store";

function httpRequest(url: string, method: "GET" | "HEAD" = "GET"): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      { host: u.hostname, port: u.port || "80", path: u.pathname + u.search, method },
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
function httpGet(url: string): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return httpRequest(url, "GET");
}

function startServer(plans?: unknown[]): Promise<{ server: ReturnType<typeof createControlApi>; port: number }> {
  const defaultPlans = [
    { plan_id: "test-1", created_at: new Date().toISOString(), market_id: "m1", category: "Politics", assumption_key: "ak1", ev_breakdown: { net_ev: 10 }, status: "proposed" as const },
    { plan_id: "test-2", created_at: new Date().toISOString(), market_id: "m2", category: "uncategorized", assumption_key: "ak2", ev_breakdown: { net_ev: 5 }, status: "proposed" as const },
  ];
  setPlans(plans ?? defaultPlans, new Date().toISOString(), {});
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
  it("GET /plans returns 200 with response contract and debug headers", async () => {
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/plans`);
      assert.strictEqual(res.statusCode, 200);
      assert(res.headers["x-plans-total"] != null, "X-Plans-Total present");
      assert(res.headers["x-plans-filtered"] != null, "X-Plans-Filtered present");
      assert(res.headers["x-build-id"] != null, "X-Build-Id present");
      const body = JSON.parse(res.body) as {
        count_total: number;
        count_returned: number;
        limit: number;
        offset: number;
        plans: unknown[];
      };
      assert.strictEqual(typeof body.count_total, "number");
      assert.strictEqual(typeof body.count_returned, "number");
      assert.strictEqual(body.limit, 50, "default limit 50");
      assert.strictEqual(body.offset, 0, "default offset 0");
      assert(Array.isArray(body.plans));
      assert.strictEqual(body.plans.length, body.count_returned);
    } finally {
      await closeServer(server);
    }
  });

  it("GET /plans?limit= uses default limit (empty after trim)", async () => {
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/plans?limit=`);
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body) as { limit: number; offset: number; plans: unknown[] };
      assert.strictEqual(body.limit, 50);
      assert.strictEqual(body.offset, 0);
      assert(Array.isArray(body.plans));
    } finally {
      await closeServer(server);
    }
  });

  it("GET /plans?category=%20 treats as absent (200)", async () => {
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/plans?category=%20`);
      assert.strictEqual(res.statusCode, 200, "category=%20 trimmed to empty, not invalid");
      const body = JSON.parse(res.body) as { count_total: number; plans: unknown[] };
      assert.strictEqual(typeof body.count_total, "number");
      assert(Array.isArray(body.plans));
    } finally {
      await closeServer(server);
    }
  });

  it("HEAD /plans returns 200 with same X-Plans-* headers as GET", async () => {
    const { server, port } = await startServer();
    try {
      const getRes = await httpGet(`http://127.0.0.1:${port}/plans?limit=2`);
      const headRes = await httpRequest(`http://127.0.0.1:${port}/plans?limit=2`, "HEAD");
      assert.strictEqual(headRes.statusCode, 200);
      assert.strictEqual(headRes.headers["x-plans-total"], getRes.headers["x-plans-total"]);
      assert.strictEqual(headRes.headers["x-plans-filtered"], getRes.headers["x-plans-filtered"]);
      assert.strictEqual(headRes.headers["x-build-id"], getRes.headers["x-build-id"]);
      assert.strictEqual(headRes.body, "", "HEAD has no body");
    } finally {
      await closeServer(server);
    }
  });

  it("GET /plans?unknown=1 returns 400 with invalid_query and details", async () => {
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/plans?unknown=1`);
      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body) as { error: string; details: string[] };
      assert.strictEqual(body.error, "invalid_query");
      assert(Array.isArray(body.details));
      assert(body.details.some((d: string) => d.includes("unknown")), "details mention unknown param");
    } finally {
      await closeServer(server);
    }
  });

  it("GET /plans?offset=-1 returns 400", async () => {
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/plans?offset=-1`);
      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body) as { error: string; details: string[] };
      assert.strictEqual(body.error, "invalid_query");
      assert(body.details.some((d: string) => d.toLowerCase().includes("offset")));
    } finally {
      await closeServer(server);
    }
  });

  it("response count_total and count_returned match; limit clamped to 200", async () => {
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/plans?limit=999`);
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body) as { count_total: number; count_returned: number; limit: number; plans: unknown[] };
      assert.strictEqual(body.limit, 200, "limit clamped to 200");
      assert.strictEqual(body.plans.length, body.count_returned);
      assert(body.count_returned <= body.count_total);
    } finally {
      await closeServer(server);
    }
  });

  it("X-Plans-Total and X-Plans-Filtered headers match store and count_total", async () => {
    const { server, port } = await startServer();
    try {
      const storeBefore = getPlans();
      const res = await httpGet(`http://127.0.0.1:${port}/plans`);
      assert.strictEqual(res.headers["x-plans-total"], String(storeBefore.plans.length));
      const body = JSON.parse(res.body) as { count_total: number };
      assert.strictEqual(res.headers["x-plans-filtered"], String(body.count_total));
    } finally {
      await closeServer(server);
    }
  });

  it("e2e: header/body count consistency and pagination determinism", async () => {
    const ts = new Date().toISOString();
    const seededPlans = [
      { plan_id: "e2e-a", created_at: ts, market_id: "m1", category: "C", assumption_key: "ak", ev_breakdown: { net_ev: 30 }, status: "proposed" as const },
      { plan_id: "e2e-b", created_at: ts, market_id: "m2", category: "C", assumption_key: "ak", ev_breakdown: { net_ev: 20 }, status: "proposed" as const },
      { plan_id: "e2e-c", created_at: ts, market_id: "m3", category: "C", assumption_key: "ak", ev_breakdown: { net_ev: 20 }, status: "proposed" as const },
      { plan_id: "e2e-d", created_at: ts, market_id: "m4", category: "C", assumption_key: "ak", ev_breakdown: { net_ev: 10 }, status: "proposed" as const },
      { plan_id: "e2e-e", created_at: ts, market_id: "m5", category: "C", assumption_key: "ak", ev_breakdown: { net_ev: 10 }, status: "proposed" as const },
    ];
    const { server, port } = await startServer(seededPlans);
    try {
      const store = getPlans();
      assert.strictEqual(store.plans.length, 5);

      const res1 = await httpGet(`http://127.0.0.1:${port}/plans?limit=2&offset=0`);
      assert.strictEqual(res1.statusCode, 200);
      const body1 = JSON.parse(res1.body) as { count_total: number; count_returned: number; limit: number; offset: number; plans: { plan_id: string }[] };
      assert.strictEqual(res1.headers["x-plans-total"], "5");
      assert.strictEqual(res1.headers["x-plans-filtered"], String(body1.count_total));
      assert.strictEqual(body1.count_total, 5);
      assert.strictEqual(body1.count_returned, 2);
      const page1Ids = body1.plans.map((p) => p.plan_id);

      const res2 = await httpGet(`http://127.0.0.1:${port}/plans?limit=2&offset=0`);
      const body2 = JSON.parse(res2.body) as { plans: { plan_id: string }[] };
      assert.deepStrictEqual(body2.plans.map((p) => p.plan_id), page1Ids, "same params yield same order (determinism)");

      const resFull = await httpGet(`http://127.0.0.1:${port}/plans?limit=10`);
      const fullBody = JSON.parse(resFull.body) as { plans: { plan_id: string }[] };
      const fullIds = fullBody.plans.map((p) => p.plan_id);

      const resPage2 = await httpGet(`http://127.0.0.1:${port}/plans?limit=2&offset=2`);
      const page2Body = JSON.parse(resPage2.body) as { plans: { plan_id: string }[] };
      const resPage3 = await httpGet(`http://127.0.0.1:${port}/plans?limit=1&offset=4`);
      const page3Body = JSON.parse(resPage3.body) as { plans: { plan_id: string }[] };
      const paginatedIds = [...page1Ids, ...page2Body.plans.map((p) => p.plan_id), ...page3Body.plans.map((p) => p.plan_id)];
      assert.deepStrictEqual(paginatedIds, fullIds, "paginated concatenation matches full list order");
    } finally {
      await closeServer(server);
    }
  });
});
