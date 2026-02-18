/**
 * Unit tests for Resolution Carry (YES) strategy: timeToResolutionDays, isProceduralCandidate,
 * carryRoiPct, selectCarryCandidates (ROI band and maxDays).
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  timeToResolutionDays,
  isProceduralCandidate,
  carryRoiPct,
  selectCarryCandidates,
  type CarryConfig,
} from "../strategy/carry_yes";
import type { NormalizedMarket, TopOfBook } from "../types";

function market(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    marketId: "m1",
    conditionId: "c1",
    question: "",
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

function topOfBook(noAsk: number, spread: number = 0.01, askLiquidityUsd: number = 1000): TopOfBook {
  return {
    noBid: noAsk - spread,
    noAsk,
    spread,
    depthSummary: { bidLiquidityUsd: 1000, askLiquidityUsd, levels: 5 },
  };
}

describe("carry_yes timeToResolutionDays", () => {
  it("returns days until resolution from endDateIso", () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const m = market({ endDateIso: "2025-03-02T12:00:00Z", resolutionTime: null });
    const days = timeToResolutionDays(m, now);
    assert.ok(days != null);
    assert.ok(days! >= 12 && days! <= 14);
  });

  it("returns null when no end date", () => {
    const m = market({ endDateIso: null, resolutionTime: null });
    assert.strictEqual(timeToResolutionDays(m, new Date()), null);
  });

  it("returns null when resolution is in the past", () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const m = market({ endDateIso: "2025-02-10T12:00:00Z" });
    assert.strictEqual(timeToResolutionDays(m, now), null);
  });
});

describe("carry_yes isProceduralCandidate", () => {
  it("matches when question contains allowKeyword", () => {
    const m = market({ question: "Will the Fed raise rates in March?" });
    assert.ok(isProceduralCandidate(m, [], ["fed"]));
  });

  it("matches when category in allowCategories", () => {
    const m = market({ category: "Politics" });
    assert.ok(isProceduralCandidate(m, ["Politics"], []));
  });

  it("uses default keywords when allowKeywords empty but allowCategories non-empty", () => {
    const m = market({ question: "Fed rate decision next week", category: "Other" });
    assert.ok(isProceduralCandidate(m, ["Other"], []));
  });

  it("rejects when no keyword or category match", () => {
    const m = market({ question: "Random sports outcome?", category: "Sports" });
    assert.ok(!isProceduralCandidate(m, ["Politics"], ["election"]));
  });

  it("returns true when both allowKeywords and allowCategories are empty (no procedural filter)", () => {
    const m = market({ question: "Anything at all", category: "Sports" });
    assert.strictEqual(isProceduralCandidate(m, [], []), true);
  });
});

describe("carry_yes carryRoiPct", () => {
  it("computes (1-ask)/ask * 100 for ask 0.94", () => {
    const roi = carryRoiPct(0.94);
    assert.ok(Math.abs(roi - (1 - 0.94) / 0.94 * 100) < 0.01);
    assert.ok(roi >= 6.3 && roi <= 6.4);
  });

  it("returns 0 for invalid ask", () => {
    assert.strictEqual(carryRoiPct(0), 0);
    assert.strictEqual(carryRoiPct(1), 0);
  });
});

describe("carry_yes selectCarryCandidates", () => {
  const baseConfig: CarryConfig = {
    enabled: true,
    maxDays: 30,
    roiMinPct: 6,
    roiMaxPct: 7,
    maxSpread: 0.02,
    minAskLiqUsd: 500,
    allowCategories: ["Politics"],
    allowKeywords: ["election"],
  };

  it("returns empty when carry disabled", () => {
    const m = market({ yesTokenId: "y1", question: "Election result?", endDateIso: "2025-03-20T00:00:00Z" });
    const getBook = () => topOfBook(0.94, 0.01, 1000);
    const { candidates } = selectCarryCandidates([m], getBook, { ...baseConfig, enabled: false }, new Date("2025-02-17"));
    assert.strictEqual(candidates.length, 0);
  });

  it("selects market with YES ask in ROI band and within maxDays", () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const m = market({
      yesTokenId: "yes789",
      question: "Election winner?",
      category: "Politics",
      endDateIso: "2025-03-15T12:00:00Z",
    });
    const getBook = (tid: string | null) => (tid === "yes789" ? topOfBook(0.94, 0.01, 1000) : null);
    const { candidates, carryDebug } = selectCarryCandidates([m], getBook, baseConfig, now);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].yesTokenId, "yes789");
    assert.strictEqual(candidates[0].yesAsk, 0.94);
    assert.ok(candidates[0].carry_roi_pct >= 6 && candidates[0].carry_roi_pct <= 7);
    assert.ok(candidates[0].time_to_resolution_days <= 30);
    assert.strictEqual(carryDebug.passed, 1);
  });

  it("rejects market outside ROI band", () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const m = market({
      yesTokenId: "yes999",
      question: "Election?",
      endDateIso: "2025-03-15T12:00:00Z",
    });
    const getBook = () => topOfBook(0.99, 0.005, 2000);
    const { candidates, carryDebug } = selectCarryCandidates([m], getBook, baseConfig, now);
    assert.strictEqual(candidates.length, 0);
    assert.strictEqual(carryDebug.roi_out_of_band, 1);
  });

  it("rejects market with time_to_resolution > maxDays", () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const m = market({
      yesTokenId: "yes999",
      question: "Election?",
      endDateIso: "2025-06-01T12:00:00Z",
    });
    const getBook = () => topOfBook(0.94, 0.01, 1000);
    const { candidates, carryDebug } = selectCarryCandidates([m], getBook, baseConfig, now);
    assert.strictEqual(candidates.length, 0);
    assert.strictEqual(carryDebug.beyond_max_days, 1);
  });

  it("rejects market without yesTokenId", () => {
    const m = market({ yesTokenId: null });
    const { candidates, carryDebug } = selectCarryCandidates([m], () => topOfBook(0.94), baseConfig, new Date());
    assert.strictEqual(candidates.length, 0);
    assert.strictEqual(carryDebug.missing_yes_token_id, 1);
  });
});
