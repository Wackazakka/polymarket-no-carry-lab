/**
 * Unit tests: capture-mode tail bypass vs baseline.
 * - capture: tailRiskCost === 0, tailByp === "Y", tail_bypass_reason === "capture_mode"
 * - baseline: tail_risk_cost non-zero (model unchanged)
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { computeEV } from "../strategy/ev";
import type { NormalizedMarket, FilterResult } from "../types";

function mockMarket(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    marketId: "m1",
    conditionId: "c1",
    question: "Q?",
    title: "T",
    outcomes: ["Yes", "No"],
    resolutionTime: new Date(Date.now() + 86400 * 7 * 1000),
    endDateIso: null,
    category: "Politics",
    description: null,
    rulesText: null,
    noTokenId: "tok",
    yesTokenId: "tok2",
    liquidityNum: null,
    closed: false,
    ...overrides,
  };
}

function mockFilterResult(flags: string[] = []): FilterResult {
  return { pass: true, reasons: [], flags };
}

describe("computeEV tail bypass", () => {
  it("capture mode: tail_risk_cost 0, tailByp Y, tail_bypass_reason capture_mode", () => {
    const market = mockMarket();
    const config = {
      fee_bps: 0,
      p_tail: 0.02,
      tail_loss_fraction: 0.5,
      ambiguous_resolution_p_tail_multiplier: 1.5,
      ev_mode: "capture" as const,
    };
    const result = computeEV(market, 0.98, 100, config, mockFilterResult());
    assert.strictEqual(result.tail_risk_cost, 0);
    assert.strictEqual(result.tailByp, "Y");
    assert.strictEqual(result.tail_bypass_reason, "capture_mode");
    assert.strictEqual(result.assumptions.tailByp, "Y");
    assert.strictEqual(result.assumptions.tail_bypass_reason, "capture_mode");
    assert.ok(result.explanation.some((e) => e.includes("Tail bypass") && e.includes("capture")));
  });

  it("baseline: tail_risk_cost non-zero", () => {
    const market = mockMarket();
    const config = {
      fee_bps: 0,
      p_tail: 0.02,
      tail_loss_fraction: 0.5,
      ambiguous_resolution_p_tail_multiplier: 1.5,
      ev_mode: "baseline" as const,
    };
    const result = computeEV(market, 0.98, 100, config, mockFilterResult());
    assert.ok(result.tail_risk_cost > 0);
    assert.strictEqual(result.tailByp, undefined);
    assert.strictEqual(result.tail_bypass_reason, undefined);
    assert.ok(result.assumptions.tail_risk_cost === result.tail_risk_cost);
  });

  it("baseline (default when ev_mode omitted): tail_risk_cost non-zero", () => {
    const market = mockMarket();
    const config = {
      fee_bps: 0,
      p_tail: 0.02,
      tail_loss_fraction: 0.5,
      ambiguous_resolution_p_tail_multiplier: 1.5,
    };
    const result = computeEV(market, 0.98, 100, config, mockFilterResult());
    assert.ok(result.tail_risk_cost > 0);
    assert.strictEqual(result.tailByp, undefined);
    assert.strictEqual(result.tail_bypass_reason, undefined);
  });
});
