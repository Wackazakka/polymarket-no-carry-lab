/**
 * Smoke tests for control API: GET /plans debug headers and malformed query handling.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { request } from "node:http";
import { createControlApi, type ControlApiOptions } from "../ops/control_api";
import { setPlans, getPlans } from "../control/plan_store";
import { setBookForTest } from "../markets/orderbook_ws";

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

function startServer(plans?: unknown[], apiOptions?: ControlApiOptions): Promise<{ server: ReturnType<typeof createControlApi>; port: number }> {
  const defaultPlans = [
    { plan_id: "test-1", created_at: new Date().toISOString(), market_id: "m1", category: "Politics", assumption_key: "ak1", ev_breakdown: { net_ev: 10 }, status: "proposed" as const },
    { plan_id: "test-2", created_at: new Date().toISOString(), market_id: "m2", category: "uncategorized", assumption_key: "ak2", ev_breakdown: { net_ev: 5 }, status: "proposed" as const },
  ];
  setPlans(plans ?? defaultPlans, new Date().toISOString(), {});
  const server = createControlApi(0, { confirmHandler: async () => null }, apiOptions);
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

describe("control API GET /status", () => {
  it("GET /status returns 200 with meta key (plan_store meta, may be null)", async () => {
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/status`);
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      assert("meta" in body, "response must include meta key");
    } finally {
      await closeServer(server);
    }
  });
});

describe("control API GET /plans", () => {
  it("default GET /plans returns ev_breakdown stripped to net_ev, tail_risk_cost, tailByp, tail_bypass_reason only", async () => {
    const planWithExtra = {
      plan_id: "strip-test-id",
      created_at: new Date().toISOString(),
      market_id: "m1",
      condition_id: "c1",
      no_token_id: "111",
      outcome: "YES" as const,
      sizeUsd: 100,
      limit_price: 0.94,
      category: "Politics",
      assumption_key: "ak1",
      window_key: "W_carry_0_30D",
      ev_breakdown: {
        mode: "carry" as const,
        net_ev: 6.38,
        carry_roi_pct: 6.38,
        tail_risk_cost: 0,
        tailByp: "N",
        tail_bypass_reason: undefined,
      },
      status: "proposed" as const,
    };
    const { server, port } = await startServer([planWithExtra]);
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/plans`);
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body) as { plans: Array<{ ev_breakdown?: Record<string, unknown> }> };
      assert.ok(body.plans.length >= 1);
      const keys = Object.keys(body.plans[0].ev_breakdown ?? {});
      const allowed = ["net_ev", "tail_risk_cost", "tailByp", "tail_bypass_reason"];
      for (const k of keys) {
        assert.ok(allowed.includes(k), `default response ev_breakdown must only have allowed keys, got: ${k}`);
      }
    } finally {
      await closeServer(server);
    }
  });

  it("GET /plans?debug=1 returns full ev_breakdown including mode and carry_roi_pct when store has carry plan", async () => {
    const carryPlan = {
      plan_id: "carry-plan-test-id",
      created_at: new Date().toISOString(),
      market_id: "m-carry",
      condition_id: "c-carry",
      no_token_id: "12345",
      outcome: "YES" as const,
      sizeUsd: 100,
      limit_price: 0.94,
      category: "Politics",
      assumption_key: "ak-carry",
      window_key: "W_carry_0_30D",
      ev_breakdown: {
        mode: "carry" as const,
        net_ev: 6.38,
        carry_roi_pct: 6.38,
        hold_to_resolution: true,
        time_to_resolution_days: 14,
        yes_bid: 0.93,
        yes_ask: 0.94,
        spread: 0.01,
        edge_abs: 0.06,
        spread_edge_ratio: 0.167,
        price_source: "ws" as const,
      },
      status: "proposed" as const,
    };
    const { server, port } = await startServer([carryPlan]);
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/plans?debug=1`);
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body) as { plans: Array<{ ev_breakdown?: { mode?: string; carry_roi_pct?: number } }> };
      const carryPlans = body.plans.filter((p) => p.ev_breakdown?.mode === "carry");
      assert.ok(carryPlans.length >= 1, "at least one plan with ev_breakdown.mode=carry");
      const one = carryPlans[0];
      assert.ok(typeof one.ev_breakdown?.carry_roi_pct === "number", "carry plan has ev_breakdown.carry_roi_pct");
    } finally {
      await closeServer(server);
    }
  });

  it("GET /plans?debug=1&gate=0 and gate=1 both return NO:capture + YES:carry when seeded", async () => {
    const noCapturePlan = {
      plan_id: "no-capture-id",
      created_at: new Date().toISOString(),
      market_id: "m-no",
      condition_id: "c-no",
      no_token_id: "111",
      outcome: "NO" as const,
      sizeUsd: 100,
      limit_price: 0.5,
      category: "Politics",
      assumption_key: "ak-no",
      window_key: "W_capture",
      ev_breakdown: { mode: "capture" as const, net_ev: 2 },
      status: "proposed" as const,
    };
    const yesCarryPlan = {
      plan_id: "yes-carry-id",
      created_at: new Date().toISOString(),
      market_id: "m-yes",
      condition_id: "c-yes",
      no_token_id: "222",
      outcome: "YES" as const,
      sizeUsd: 100,
      limit_price: 0.94,
      category: "Politics",
      assumption_key: "ak-yes",
      window_key: "W_carry_0_30D",
      ev_breakdown: { mode: "carry" as const, net_ev: 6.38, carry_roi_pct: 6.38 },
      status: "proposed" as const,
    };
    const seeded = [noCapturePlan, yesCarryPlan];
    const { server, port } = await startServer(seeded);
    try {
      const res0 = await httpGet(`http://127.0.0.1:${port}/plans?debug=1&gate=0`);
      assert.strictEqual(res0.statusCode, 200);
      const body0 = JSON.parse(res0.body) as { count_total: number; plans: Array<{ outcome?: string; ev_breakdown?: { mode?: string } }> };
      assert.strictEqual(body0.count_total, 2, "gate=0 returns both plans");
      assert.strictEqual(body0.plans.length, 2);
      const modes0 = body0.plans.map((p) => p.ev_breakdown?.mode).sort();
      assert.deepStrictEqual(modes0, ["capture", "carry"]);

      const res1 = await httpGet(`http://127.0.0.1:${port}/plans?debug=1&gate=1`);
      assert.strictEqual(res1.statusCode, 200);
      const body1 = JSON.parse(res1.body) as { count_total: number; plans: Array<{ outcome?: string; ev_breakdown?: { mode?: string } }> };
      assert.strictEqual(body1.count_total, 2, "gate=1 allowlist still returns NO:capture and YES:carry");
      assert.strictEqual(body1.plans.length, 2);
      const modes1 = body1.plans.map((p) => p.ev_breakdown?.mode).sort();
      assert.deepStrictEqual(modes1, ["capture", "carry"]);
    } finally {
      await closeServer(server);
    }
  });

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

  it("GET /plans returns updated_at per plan; setPlans twice keeps created_at stable, updated_at changes", async () => {
    const planId = "stable-ts-1";
    const onePlan = {
      plan_id: planId,
      market_id: "m1",
      no_token_id: "123",
      outcome: "NO" as const,
      category: "C",
      assumption_key: "ak1",
      window_key: "w1",
      ev_breakdown: { net_ev: 10 },
      status: "proposed" as const,
    };
    const { server, port } = await startServer([onePlan]);
    try {
      const res1 = await httpGet(`http://127.0.0.1:${port}/plans?limit=1`);
      assert.strictEqual(res1.statusCode, 200);
      const body1 = JSON.parse(res1.body) as { plans: Array<{ plan_id: string; created_at?: string; updated_at?: string }> };
      assert.strictEqual(body1.plans.length, 1);
      assert.ok(body1.plans[0].created_at, "created_at present");
      assert.ok(body1.plans[0].updated_at, "updated_at present");
      const createdFirst = body1.plans[0].created_at;
      const updatedFirst = body1.plans[0].updated_at;

      setPlans([onePlan], new Date().toISOString(), {});
      const res2 = await httpGet(`http://127.0.0.1:${port}/plans?limit=1`);
      assert.strictEqual(res2.statusCode, 200);
      const body2 = JSON.parse(res2.body) as { plans: Array<{ plan_id: string; created_at?: string; updated_at?: string }> };
      assert.strictEqual(body2.plans.length, 1);
      assert.strictEqual(body2.plans[0].created_at, createdFirst, "created_at unchanged across setPlans");
      assert.ok(body2.plans[0].updated_at, "updated_at exists");
      assert.notStrictEqual(body2.plans[0].updated_at, updatedFirst, "updated_at differs after second setPlans");
      assert.ok(
        Object.keys(body2.plans[0]).includes("updated_at"),
        "response plan includes updated_at key"
      );
    } finally {
      await closeServer(server);
    }
  });
});

describe("control API GET /book", () => {
  it("GET /book without no_token_id returns 400", async () => {
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/book`);
      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body) as { error: string };
      assert.strictEqual(body.error, "no_token_id required");
    } finally {
      await closeServer(server);
    }
  });

  it("GET /book?unknown=1 returns 400 invalid_query", async () => {
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/book?unknown=1`);
      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body) as { error: string; details?: string[] };
      assert.strictEqual(body.error, "invalid_query");
      assert.ok(Array.isArray(body.details) && body.details.some((d) => d.includes("unknown")));
    } finally {
      await closeServer(server);
    }
  });

  it("GET /book?no_token_id=abc returns 404 or 200; if 404 assert error shape", async () => {
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/book?no_token_id=abc`);
      assert.ok(res.statusCode === 404 || res.statusCode === 200, "404 (no book) or 200 (book exists)");
      const body = JSON.parse(res.body) as { error?: string; no_token_id?: string; noBid?: number; noAsk?: number; spread?: number; depthSummary?: unknown };
      if (res.statusCode === 404) {
        assert.strictEqual(body.error, "book_not_found");
      } else {
        assert.ok(typeof body.no_token_id === "string");
        assert.ok("noBid" in body && "noAsk" in body && "spread" in body && "depthSummary" in body);
      }
    } finally {
      await closeServer(server);
    }
  });

  it("GET /book returns price_source http when WS missing and stub HTTP returns bid/ask", async () => {
    const fetchStub: ControlApiOptions["fetchTopOfBookHttp"] = async (tokenId) =>
      tokenId === "999" ? { noBid: 0.93, noAsk: 0.94, spread: 0.01 } : null;
    const { server, port } = await startServer(undefined, { fetchTopOfBookHttp: fetchStub });
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/book?no_token_id=999`);
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body) as {
        no_token_id: string;
        noBid: number | null;
        noAsk: number | null;
        spread: number | null;
        price_source: string;
        http_fallback_used: boolean;
      };
      assert.strictEqual(body.price_source, "http");
      assert.strictEqual(body.http_fallback_used, true);
      assert.strictEqual(body.no_token_id, "999");
      assert.ok(Math.abs((body.noBid ?? 0) - 0.93) < 1e-9);
      assert.ok(Math.abs((body.noAsk ?? 0) - 0.94) < 1e-9);
    } finally {
      await closeServer(server);
    }
  });
});

describe("control API GET /has-book", () => {
  it("GET /has-book without token_id returns 400", async () => {
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/has-book`);
      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body) as { error: string };
      assert.strictEqual(body.error, "token_id required");
    } finally {
      await closeServer(server);
    }
  });

  it("GET /has-book?token_id=123 returns 200 with token_id, normalized_key, has_book, note", async () => {
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/has-book?token_id=123`);
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body) as {
        token_id: string;
        normalized_key: string;
        has_book: boolean;
        note: string;
      };
      assert.strictEqual(body.token_id, "123");
      assert.strictEqual(typeof body.normalized_key, "string");
      assert.strictEqual(typeof body.has_book, "boolean");
      assert.strictEqual(typeof body.note, "string");
    } finally {
      await closeServer(server);
    }
  });
});

describe("control API GET /fill", () => {
  it("GET /fill without no_token_id returns 400", async () => {
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/fill?side=buy&size_usd=100`);
      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body) as { error: string };
      assert.strictEqual(body.error, "no_token_id required");
    } finally {
      await closeServer(server);
    }
  });

  it("GET /fill with unknown param returns 400 invalid_query", async () => {
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/fill?no_token_id=x&side=buy&size_usd=100&unknown=1`);
      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body) as { error: string; details?: string[] };
      assert.strictEqual(body.error, "invalid_query");
      assert.ok(Array.isArray(body.details) && body.details.some((d) => d.includes("unknown")));
    } finally {
      await closeServer(server);
    }
  });

  it("GET /fill with invalid side returns 400", async () => {
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/fill?no_token_id=x&side=mid&size_usd=100`);
      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body) as { error: string };
      assert.strictEqual(body.error, "side must be buy or sell");
    } finally {
      await closeServer(server);
    }
  });

  it("GET /fill with invalid size_usd returns 400", async () => {
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/fill?no_token_id=x&side=buy&size_usd=0`);
      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body) as { error: string };
      assert.strictEqual(body.error, "size_usd must be a positive number");
    } finally {
      await closeServer(server);
    }
  });

  it("GET /fill with fake book (buy): avg_price and levels_used", async () => {
    const tokenId = "fill-buy-987654321";
    setBookForTest(
      tokenId,
      [{ price: 0.49, size: 1000 }],
      [
        { price: 0.5, size: 500 },
        { price: 0.51, size: 500 },
      ]
    );
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/fill?no_token_id=${tokenId}&side=buy&size_usd=100`);
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body) as {
        no_token_id: string;
        side: string;
        size_usd: number;
        top: { noBid: number; noAsk: number; spread: number };
        filled_usd: number;
        filled_shares: number;
        avg_price: number;
        levels_used: number;
        slippage_pct: number;
      };
      assert.strictEqual(body.side, "buy");
      assert.strictEqual(body.size_usd, 100);
      assert.strictEqual(body.levels_used, 1, "fill at first ask level only for 100 USD at 0.50");
      assert.ok(body.filled_shares > 0);
      assert.ok(Math.abs(body.avg_price - 0.5) < 0.001);
      assert.ok(body.filled_usd > 0 && body.filled_usd <= 100);
    } finally {
      await closeServer(server);
    }
  });

  it("GET /fill with fake book (sell): avg_price and levels_used", async () => {
    const tokenId = "fill-sell-987654322";
    setBookForTest(
      tokenId,
      [
        { price: 0.49, size: 500 },
        { price: 0.48, size: 500 },
      ],
      [{ price: 0.5, size: 1000 }]
    );
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/fill?no_token_id=${tokenId}&side=sell&size_usd=100`);
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body) as {
        no_token_id: string;
        side: string;
        size_usd: number;
        top: { noBid: number; noAsk: number; spread: number };
        filled_usd: number;
        filled_shares: number;
        avg_price: number;
        levels_used: number;
        slippage_pct: number;
      };
      assert.strictEqual(body.side, "sell");
      assert.strictEqual(body.size_usd, 100);
      assert.strictEqual(body.levels_used, 1, "sell fills at best bid 0.49 for target_shares = 100/0.49");
      assert.ok(body.filled_shares > 0);
      assert.ok(Math.abs(body.avg_price - 0.49) < 0.001);
      assert.ok(body.filled_usd > 0);
    } finally {
      await closeServer(server);
    }
  });

  it("GET /fill works with HTTP fallback when WS missing and stub returns bid/ask", async () => {
    const fetchStub: ControlApiOptions["fetchTopOfBookHttp"] = async (tokenId) =>
      tokenId === "888" ? { noBid: 0.92, noAsk: 0.94, spread: 0.02 } : null;
    const { server, port } = await startServer(undefined, { fetchTopOfBookHttp: fetchStub });
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/fill?no_token_id=888&side=buy&size_usd=100`);
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body) as {
        no_token_id: string;
        side: string;
        avg_price: number;
        levels_used: number;
        slippage_pct: number;
        price_source: string;
        http_fallback_used: boolean;
      };
      assert.strictEqual(body.price_source, "http");
      assert.strictEqual(body.http_fallback_used, true);
      assert.strictEqual(body.levels_used, 1);
      assert.strictEqual(body.slippage_pct, 0);
      assert.ok(Math.abs(body.avg_price - 0.94) < 1e-9);
    } finally {
      await closeServer(server);
    }
  });
});

describe("control API GET /books-debug", () => {
  it("GET /books-debug returns 200 with size and sampleKeys", async () => {
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/books-debug`);
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body) as { size?: number; sampleKeys?: string[]; note?: string };
      assert.strictEqual(typeof body.size, "number");
      assert.ok(Array.isArray(body.sampleKeys));
    } finally {
      await closeServer(server);
    }
  });

  it("GET /books-debug with unknown query param returns 400", async () => {
    const { server, port } = await startServer();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/books-debug?foo=1`);
      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body) as { error: string; details?: string[] };
      assert.strictEqual(body.error, "invalid_query");
      assert.ok(Array.isArray(body.details) && body.details.some((d) => d.includes("foo")));
    } finally {
      await closeServer(server);
    }
  });
});
