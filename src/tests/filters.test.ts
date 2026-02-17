/**
 * Unit tests for mode-aware NO-ask filter (capture band vs baseline min_no_price).
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { evaluateMarketCandidate } from "../strategy/filters";
import type { NormalizedMarket, TopOfBook } from "../types";

function market(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    marketId: "m1",
    conditionId: "c1",
    question: "Test?",
    title: "Test",
    outcomes: ["Yes", "No"],
    resolutionTime: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    endDateIso: null,
    category: null,
    description: null,
    rulesText: null,
    noTokenId: "tid1",
    yesTokenId: "tid0",
    liquidityNum: 1000,
    closed: false,
    ...overrides,
  };
}

function book(noAsk: number, spread: number = 0.01): TopOfBook {
  return {
    noBid: noAsk - spread,
    noAsk,
    spread,
    depthSummary: { bidLiquidityUsd: 5000, askLiquidityUsd: 5000, levels: 5 },
  };
}

const baseConfig = {
  min_no_price: 0.8,
  max_spread: 0.03,
  min_liquidity_usd: 500,
  max_time_to_resolution_hours: 720,
};

describe("NO-ask filter by ev_mode", () => {
  it("capture: noAsk 0.51 passes within band [0.45, 0.60]", () => {
    const result = evaluateMarketCandidate(
      market(),
      book(0.51),
      new Date(),
      {
        ...baseConfig,
        ev_mode: "capture",
        capture_min_no_ask: 0.45,
        capture_max_no_ask: 0.6,
      }
    );
    assert.strictEqual(result.pass, true);
    assert.strictEqual(result.reasons.length, 0);
  });

  it("capture: noAsk 0.70 fails (above band)", () => {
    const result = evaluateMarketCandidate(
      market(),
      book(0.7),
      new Date(),
      {
        ...baseConfig,
        ev_mode: "capture",
        capture_min_no_ask: 0.45,
        capture_max_no_ask: 0.6,
      }
    );
    assert.strictEqual(result.pass, false);
    assert.ok(result.reasons.some((r) => r.includes("outside capture band") && r.includes("0.7")));
  });

  it("baseline: behavior unchanged (min_no_price)", () => {
    const resultLow = evaluateMarketCandidate(market(), book(0.51), new Date(), baseConfig);
    assert.strictEqual(resultLow.pass, false);
    assert.ok(resultLow.reasons.some((r) => r.includes("min_no_price")));

    const resultHigh = evaluateMarketCandidate(market(), book(0.97), new Date(), baseConfig);
    assert.strictEqual(resultHigh.pass, true);
  });
});
