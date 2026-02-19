/**
 * Unit tests for micro_capture_v1 preset: decision logic only.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  evaluateMicroCaptureV1,
  DEFAULT_MICRO_CAPTURE_V1,
  PRESET_NAME,
} from "../strategy/micro_capture_v1";
import type { NormalizedMarket, TopOfBook } from "../types";

function market(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    marketId: "m1",
    conditionId: "c1",
    question: "Q?",
    title: "",
    outcomes: ["Yes", "No"],
    resolutionTime: null,
    endDateIso: null,
    category: null,
    description: null,
    rulesText: null,
    noTokenId: "no123",
    yesTokenId: "yes456",
    liquidityNum: null,
    closed: false,
    ...overrides,
  };
}

describe("micro_capture_v1", () => {
  it("preset name is micro_capture_v1", () => {
    assert.strictEqual(PRESET_NAME, "micro_capture_v1");
  });

  it("passes when spread >= minSpread and edge >= minDriftPct", () => {
    const m = market({ noTokenId: "n1" });
    const book: TopOfBook = {
      noBid: 0.46,
      noAsk: 0.50,
      spread: 0.04,
      depthSummary: { bidLiquidityUsd: 1000, askLiquidityUsd: 1000, levels: 5 },
    };
    const result = evaluateMicroCaptureV1(m, book, DEFAULT_MICRO_CAPTURE_V1);
    assert.strictEqual(result.pass, true);
    assert.strictEqual(result.entry, 0.5);
    assert.ok(result.takeProfitPrice != null);
    assert.ok(result.stopLossPrice != null);
    assert.strictEqual(result.maxHoldMinutes, 180);
    assert.ok(result.rationale.length > 0);
    assert.strictEqual(result.takeProfitPrice, 0.5 * (1 - 3 / 100));
    assert.strictEqual(result.stopLossPrice, 0.5 * (1 + 2 / 100));
  });

  it("fails when spread < minSpread", () => {
    const m = market({ noTokenId: "n1" });
    const book: TopOfBook = {
      noBid: 0.49,
      noAsk: 0.50,
      spread: 0.02,
      depthSummary: { bidLiquidityUsd: 1000, askLiquidityUsd: 1000, levels: 5 },
    };
    const result = evaluateMicroCaptureV1(m, book, DEFAULT_MICRO_CAPTURE_V1);
    assert.strictEqual(result.pass, false);
    assert.ok(result.rationale.some((r) => r.includes("minSpread")));
  });

  it("fails when edge < minDriftPct", () => {
    const m = market({ noTokenId: "n1" });
    const book: TopOfBook = {
      noBid: 0.985,
      noAsk: 0.99,
      spread: 0.05,
      depthSummary: { bidLiquidityUsd: 1000, askLiquidityUsd: 1000, levels: 5 },
    };
    const result = evaluateMicroCaptureV1(m, book, DEFAULT_MICRO_CAPTURE_V1);
    assert.strictEqual(result.pass, false);
    assert.ok(result.rationale.some((r) => r.includes("minDriftPct") || r.includes("edge")));
  });

  it("fails when no book or no ask", () => {
    const m = market({ noTokenId: "n1" });
    const resultNull = evaluateMicroCaptureV1(m, null, DEFAULT_MICRO_CAPTURE_V1);
    assert.strictEqual(resultNull.pass, false);
    const bookNoAsk: TopOfBook = {
      noBid: 0.48,
      noAsk: null,
      spread: 0.04,
      depthSummary: { bidLiquidityUsd: 1000, askLiquidityUsd: 1000, levels: 5 },
    };
    const resultNoAsk = evaluateMicroCaptureV1(m, bookNoAsk, DEFAULT_MICRO_CAPTURE_V1);
    assert.strictEqual(resultNoAsk.pass, false);
  });
});
