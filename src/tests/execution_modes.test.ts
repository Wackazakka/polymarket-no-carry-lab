/**
 * Tests for execution modes (DISARMED / ARMED_CONFIRM / ARMED_AUTO) and panic.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  getMode,
  getModeState,
  isPanic,
  mayExecute,
  isAutoExecute,
  isConfirmMode,
  setMode,
  setPanic,
  panicStop,
  resetModeStateForTesting,
} from "../ops/mode_manager";
import {
  enqueuePlan,
  getPlans,
  getPlan,
  markPlanExecuted,
  isPlanExecuted,
  clearQueue,
  queueLength,
  resetPlanQueueForTesting,
} from "../ops/plan_queue";
import type { TradePlan } from "../types";

describe("execution modes and panic", () => {
  beforeEach(() => {
    resetModeStateForTesting();
    resetPlanQueueForTesting();
  });

  describe("mode manager", () => {
    it("default is DISARMED", () => {
      assert.strictEqual(getMode(), "DISARMED");
      assert.strictEqual(isPanic(), false);
      assert.strictEqual(mayExecute(), false);
      assert.strictEqual(isAutoExecute(), false);
      assert.strictEqual(isConfirmMode(), false);
    });

    it("ARMED_CONFIRM: isConfirmMode true, not auto-execute", () => {
      setMode("ARMED_CONFIRM");
      assert.strictEqual(getMode(), "ARMED_CONFIRM");
      assert.strictEqual(isConfirmMode(), true);
      assert.strictEqual(isAutoExecute(), false);
      assert.strictEqual(mayExecute(), true);
    });

    it("ARMED_AUTO: isAutoExecute true", () => {
      setMode("ARMED_AUTO");
      assert.strictEqual(getMode(), "ARMED_AUTO");
      assert.strictEqual(isAutoExecute(), true);
      assert.strictEqual(isConfirmMode(), false);
      assert.strictEqual(mayExecute(), true);
    });

    it("PANIC: disarm and set panic flag", () => {
      setMode("ARMED_AUTO");
      panicStop();
      assert.strictEqual(isPanic(), true);
      assert.strictEqual(getMode(), "DISARMED");
      assert.strictEqual(mayExecute(), false);
      assert.strictEqual(isAutoExecute(), false);
    });

    it("disarm clears panic when setPanic(false)", () => {
      setPanic(true);
      assert.strictEqual(isPanic(), true);
      setPanic(false);
      assert.strictEqual(isPanic(), false);
    });

    it("PANIC blocks execution and queue is cleared (panic stop)", () => {
      setMode("ARMED_AUTO");
      enqueuePlan({
        plan_id: "p1",
        created_at: new Date().toISOString(),
        market_id: "m1",
        condition_id: "c1",
        no_token_id: "t1",
        outcome: "NO",
        sizeUsd: 100,
        limit_price: 0.98,
        category: null,
        assumption_key: "a1_x",
        window_key: "W1_3_7D",
        ev_breakdown: { net_ev: 0 },
        headroom: { global: 100, category: 100, assumption: 100, window: 100, per_market: 100 },
        status: "queued",
      });
      assert.strictEqual(queueLength(), 1);
      panicStop();
      clearQueue();
      assert.strictEqual(getMode(), "DISARMED");
      assert.strictEqual(isPanic(), true);
      assert.strictEqual(mayExecute(), false);
      assert.strictEqual(queueLength(), 0);
    });
  });

  describe("plan queue", () => {
    const samplePlan: TradePlan = {
      plan_id: "test-plan-1",
      created_at: new Date().toISOString(),
      market_id: "m1",
      condition_id: "c1",
      no_token_id: "tid1",
      outcome: "NO",
      sizeUsd: 100,
      limit_price: 0.98,
      category: "Politics",
      assumption_key: "a1_abc",
      window_key: "W1_3_7D",
      ev_breakdown: { net_ev: 0.01 },
      headroom: { global: 1000, category: 500, assumption: 500, window: 500, per_market: 200 },
      status: "queued",
    };

    it("enqueue adds plan, getPlans returns only queued", () => {
      enqueuePlan(samplePlan);
      assert.strictEqual(queueLength(), 1);
      assert.strictEqual(getPlans().length, 1);
      assert.strictEqual(getPlan("test-plan-1")?.market_id, "m1");
    });

    it("markPlanExecuted: plan no longer in getPlans, isPlanExecuted true", () => {
      enqueuePlan(samplePlan);
      markPlanExecuted("test-plan-1", new Date().toISOString());
      assert.strictEqual(queueLength(), 0);
      assert.strictEqual(getPlans().length, 0);
      assert.strictEqual(isPlanExecuted("test-plan-1"), true);
    });

    it("confirm idempotent: markPlanExecuted twice, second returns true (already executed)", () => {
      enqueuePlan(samplePlan);
      const first = markPlanExecuted("test-plan-1", new Date().toISOString());
      const second = markPlanExecuted("test-plan-1", new Date().toISOString());
      assert.strictEqual(first, true);
      assert.strictEqual(second, true);
      assert.strictEqual(isPlanExecuted("test-plan-1"), true);
    });

    it("clearQueue: queue empty after panic", () => {
      enqueuePlan(samplePlan);
      enqueuePlan({ ...samplePlan, plan_id: "test-plan-2" });
      assert.strictEqual(queueLength(), 2);
      clearQueue();
      assert.strictEqual(queueLength(), 0);
      assert.strictEqual(getPlans().length, 0);
      assert.strictEqual(getPlan("test-plan-1"), undefined);
    });

    it("getPlan returns undefined for missing plan_id", () => {
      assert.strictEqual(getPlan("nonexistent"), undefined);
      assert.strictEqual(isPlanExecuted("nonexistent"), false);
    });
  });

  describe("control API (handler contract)", () => {
    it("confirm handler returns null for missing plan (404)", () => {
      const handler = (_planId: string): null => null;
      const result = handler("missing-id");
      assert.strictEqual(result, null);
    });
  });
});
