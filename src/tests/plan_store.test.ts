/**
 * Tests for plan_store: upsert by plan_id, preserve created_at, set updated_at.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { setPlans, getPlans } from "../control/plan_store";

function plan(planId: string, overrides?: Record<string, unknown>) {
  return {
    plan_id: planId,
    market_id: "m1",
    no_token_id: "123",
    outcome: "NO" as const,
    category: "C",
    assumption_key: "ak1",
    window_key: "w1",
    ev_breakdown: { net_ev: 10 },
    status: "proposed" as const,
    ...overrides,
  };
}

describe("plan_store upsert", () => {
  it("setPlans twice with same plan_id: plan_id identical, created_at unchanged, updated_at changes", () => {
    const planId = "stable-plan-1";
    setPlans([plan(planId)], "2020-01-01T00:00:00.000Z", {});
    const first = getPlans();
    assert.strictEqual(first.plans.length, 1);
    const p1 = first.plans[0] as Record<string, unknown>;
    assert.strictEqual(p1.plan_id, planId);
    const createdAt1 = p1.created_at as string;
    const updatedAt1 = p1.updated_at as string;
    assert.ok(createdAt1, "created_at set on first insert");
    assert.ok(updatedAt1, "updated_at set on first insert");

    setPlans([plan(planId)], "2020-01-02T00:00:00.000Z", {});
    const second = getPlans();
    assert.strictEqual(second.plans.length, 1);
    const p2 = second.plans[0] as Record<string, unknown>;
    assert.strictEqual(p2.plan_id, planId, "plan_id identical");
    assert.strictEqual(p2.created_at, createdAt1, "created_at unchanged");
    assert.notStrictEqual(p2.updated_at, updatedAt1, "updated_at changed");
    assert.ok(p2.updated_at, "updated_at set on second upsert");
  });
});
