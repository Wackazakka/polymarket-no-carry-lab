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
  carryRoiAprPct,
  firstTokenId,
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

describe("carry_yes firstTokenId", () => {
  it("unwraps JSON-array string to digits-only", () => {
    assert.strictEqual(firstTokenId('["123"]'), "123");
    assert.strictEqual(firstTokenId('["31227501234"]'), "31227501234");
  });

  it("returns digits-only for plain string", () => {
    assert.strictEqual(firstTokenId("123"), "123");
    assert.strictEqual(firstTokenId("yes456"), "456");
  });

  it("returns null for empty or invalid", () => {
    assert.strictEqual(firstTokenId(""), null);
    assert.strictEqual(firstTokenId(null), null);
    assert.strictEqual(firstTokenId('[""]'), null);
  });

  it("parses array and strips non-digits from first element", () => {
    assert.strictEqual(firstTokenId('["a1b2"]'), "12");
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

describe("carry_yes carryRoiAprPct", () => {
  it("annualizes raw ROI: yesAsk=0.99, t_days=30 → raw ≈ 1.01%, APR ≈ 12.3%", () => {
    const raw = carryRoiPct(0.99);
    assert.ok(Math.abs(raw - 1.0101) < 0.01, `raw ≈ 1.01% got ${raw}`);
    const apr = carryRoiAprPct(raw, 30);
    assert.ok(apr >= 12.2 && apr <= 12.4, `APR ≈ 12.3% got ${apr}`);
  });

  it("yesAsk=0.995, t_days=30 → raw ≈ 0.50%, APR ≈ 6.11% (passes 6–7% band)", () => {
    const raw = carryRoiPct(0.995);
    assert.ok(Math.abs(raw - 0.5025) < 0.01, `raw ≈ 0.5025% got ${raw}`);
    const apr = carryRoiAprPct(raw, 30);
    assert.ok(apr >= 6.0 && apr <= 6.2, `APR ≈ 6.11% got ${apr}`);
  });
});

function topOfBookPartial(overrides: { noBid?: number | null; noAsk?: number | null; spread?: number; askLiquidityUsd?: number }): TopOfBook {
  const defaultAsk = 0.5;
  const noAskVal = overrides.noAsk !== undefined ? overrides.noAsk : defaultAsk;
  const noBidVal = overrides.noBid ?? (typeof noAskVal === "number" ? noAskVal - (overrides.spread ?? 0.01) : 0.49);
  return {
    noBid: overrides.noBid !== undefined ? overrides.noBid : noBidVal,
    noAsk: noAskVal,
    spread: overrides.spread ?? 0.01,
    depthSummary: { bidLiquidityUsd: 1000, askLiquidityUsd: overrides.askLiquidityUsd ?? 1000, levels: 5 },
  };
}

describe("carry_yes selectCarryCandidates", () => {
  const baseConfig: CarryConfig = {
    enabled: true,
    maxDays: 30,
    minDaysToResolution: 2,
    roiMinPct: 6,
    roiMaxPct: 7,
    maxSpread: 0.02,
    minAskLiqUsd: 500,
    allowCategories: ["Politics"],
    allowKeywords: ["election"],
    allowSyntheticAsk: false,
    syntheticTick: 0.01,
    syntheticMaxAsk: 0.995,
    allowHttpFallback: false,
    spreadEdgeMaxRatio: 2.0,
    spreadEdgeMinAbs: 0.0,
  };

  it("returns empty when carry disabled", async () => {
    const m = market({ yesTokenId: "y1", question: "Election result?", endDateIso: "2025-03-20T00:00:00Z" });
    const getBook = () => topOfBook(0.94, 0.01, 1000);
    const { candidates } = await selectCarryCandidates([m], getBook, { ...baseConfig, enabled: false }, new Date("2025-02-17"));
    assert.strictEqual(candidates.length, 0);
  });

  it("selects market with YES ask in ROI band (APR 6–7%) and within maxDays (normalized token id)", async () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const m = market({
      yesTokenId: "yes789",
      question: "Election winner?",
      category: "Politics",
      endDateIso: endDate.toISOString(),
      resolutionTime: endDate,
    });
    const getBook = (tid: string | null) => (tid === "789" ? topOfBook(0.995, 0.01, 1000) : null);
    const { candidates, carryDebug } = await selectCarryCandidates([m], getBook, baseConfig, now);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].yesTokenId, "789");
    assert.strictEqual(candidates[0].yesAsk, 0.995);
    assert.strictEqual(candidates[0].price_source, "ws");
    assert.ok(candidates[0].yesBid != null && Math.abs(candidates[0].yesBid! - 0.985) < 1e-9);
    assert.ok(candidates[0].spreadObservable != null && Math.abs(candidates[0].spreadObservable! - 0.01) < 1e-9);
    assert.ok(candidates[0].carry_roi_pct >= 6 && candidates[0].carry_roi_pct <= 7, `APR in band got ${candidates[0].carry_roi_pct}`);
    assert.ok(Math.abs((candidates[0].carry_roi_raw_pct ?? 0) - 0.5025) < 0.1, `raw ≈ 0.5% got ${candidates[0].carry_roi_raw_pct}`);
    assert.ok(candidates[0].time_to_resolution_days >= 29 && candidates[0].time_to_resolution_days <= 31);
    assert.strictEqual(carryDebug.passed, 1);
  });

  it("selects market when yesTokenId is JSON-array string and book exists for normalized id", async () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const m = market({
      yesTokenId: '["123"]',
      question: "Election winner?",
      category: "Politics",
      endDateIso: endDate.toISOString(),
      resolutionTime: endDate,
    });
    const getBook = (tid: string | null) => (tid === "123" ? topOfBook(0.995, 0.01, 1000) : null);
    const { candidates, carryDebug } = await selectCarryCandidates([m], getBook, baseConfig, now);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].yesTokenId, "123");
    assert.strictEqual(candidates[0].yesAsk, 0.995);
    assert.strictEqual(candidates[0].price_source, "ws");
    assert.ok(candidates[0].spreadObservable != null);
    assert.ok(candidates[0].carry_roi_pct >= 6 && candidates[0].carry_roi_pct <= 7);
    assert.strictEqual(carryDebug.passed, 1);
  });

  it("when WS has no book but allowHttpFallback and mock HTTP returns ask, candidate passes and http_used increments", async () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const m = market({
      yesTokenId: "456",
      question: "Election winner?",
      category: "Politics",
      endDateIso: endDate.toISOString(),
      resolutionTime: endDate,
    });
    const getBook = () => null;
    const fetchHttp = async (tokenId: string) =>
      tokenId === "456"
        ? { noBid: 0.985, noAsk: 0.995, spread: 0.01 }
        : null;
    const config = { ...baseConfig, allowHttpFallback: true };
    const { candidates, carryDebug } = await selectCarryCandidates([m], getBook, config, now, fetchHttp);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].yesTokenId, "456");
    assert.strictEqual(candidates[0].yesAsk, 0.995);
    assert.strictEqual(candidates[0].price_source, "http");
    assert.strictEqual(candidates[0].http_fallback_used, true);
    assert.ok(candidates[0].yesBid != null && Math.abs(candidates[0].yesBid! - 0.985) < 1e-9);
    assert.ok(candidates[0].spreadObservable != null && Math.abs(candidates[0].spreadObservable! - 0.01) < 1e-9);
    assert.strictEqual(carryDebug.passed, 1);
    assert.strictEqual(carryDebug.http_used, 1);
  });

  it("rejects market outside ROI band", async () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const m = market({
      yesTokenId: "yes999",
      question: "Election?",
      endDateIso: "2025-03-15T12:00:00Z",
    });
    const getBook = () => topOfBook(0.99, 0.005, 2000);
    const { candidates, carryDebug } = await selectCarryCandidates([m], getBook, baseConfig, now);
    assert.strictEqual(candidates.length, 0);
    assert.strictEqual(carryDebug.roi_out_of_band, 1);
  });

  it("rejects market with time_to_resolution > maxDays", async () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const m = market({
      yesTokenId: "yes999",
      question: "Election?",
      endDateIso: "2025-06-01T12:00:00Z",
    });
    const getBook = () => topOfBook(0.94, 0.01, 1000);
    const { candidates, carryDebug } = await selectCarryCandidates([m], getBook, baseConfig, now);
    assert.strictEqual(candidates.length, 0);
    assert.strictEqual(carryDebug.beyond_max_days, 1);
  });

  it("rejects market without yesTokenId", async () => {
    const m = market({ yesTokenId: null });
    const { candidates, carryDebug } = await selectCarryCandidates([m], () => topOfBook(0.94), baseConfig, new Date());
    assert.strictEqual(candidates.length, 0);
    assert.strictEqual(carryDebug.missing_yes_token_id, 1);
  });

  it("when allowSyntheticAsk=false, no ask counts as no_book_or_ask", async () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const m = market({
      yesTokenId: "syn99",
      question: "Election?",
      endDateIso: "2025-03-15T12:00:00Z",
    });
    const getBook = (tid: string | null) => (tid === "99" ? topOfBookPartial({ noBid: 0.99, noAsk: null }) : null);
    const { candidates, carryDebug } = await selectCarryCandidates([m], getBook, baseConfig, now);
    assert.strictEqual(candidates.length, 0);
    assert.strictEqual(carryDebug.no_book_or_ask, 1);
  });

  it("when allowSyntheticAsk=true and noBid=0.93, noAsk=null -> candidate with synthetic_ask=true and price noBid+tick", async () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const m = market({
      yesTokenId: "syn93",
      question: "Election?",
      endDateIso: "2025-03-15T12:00:00Z",
    });
    const getBook = (tid: string | null) => (tid === "93" ? topOfBookPartial({ noBid: 0.93, noAsk: null }) : null);
    const config = { ...baseConfig, allowSyntheticAsk: true, syntheticTick: 0.01, syntheticMaxAsk: 0.995, roiMinPct: 0.1, roiMaxPct: 100 };
    const { candidates, carryDebug } = await selectCarryCandidates([m], getBook, config, now);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].synthetic_ask, true);
    assert.strictEqual(candidates[0].price_source, "synthetic_ask");
    assert.ok(candidates[0].yesBid != null && Math.abs(candidates[0].yesBid! - 0.93) < 1e-9);
    assert.ok(candidates[0].spreadObservable != null && Math.abs(candidates[0].spreadObservable! - 0.01) < 1e-9);
    assert.ok(Math.abs((candidates[0].yesAsk ?? 0) - 0.94) < 1e-9);
    assert.ok(Math.abs((candidates[0].synthetic_ask_price ?? 0) - 0.94) < 1e-9);
    assert.strictEqual(candidates[0].synthetic_reason, "no_ask_using_noBid_plus_tick");
    assert.strictEqual(carryDebug.synthetic_used, 1);
  });

  it("when allowSyntheticAsk=true and noBid=0.99, noAsk=null -> yesAsk capped to syntheticMaxAsk 0.995", async () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const m = market({
      yesTokenId: "syn99",
      question: "Election?",
      endDateIso: "2025-03-15T12:00:00Z",
    });
    const getBook = (tid: string | null) => (tid === "99" ? topOfBookPartial({ noBid: 0.99, noAsk: null }) : null);
    const config = { ...baseConfig, allowSyntheticAsk: true, syntheticTick: 0.01, syntheticMaxAsk: 0.995, roiMinPct: 0.1, roiMaxPct: 100 };
    const { candidates } = await selectCarryCandidates([m], getBook, config, now);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].synthetic_ask, true);
    assert.ok(Math.abs((candidates[0].yesAsk ?? 0) - 0.995) < 1e-9);
    assert.ok(Math.abs((candidates[0].synthetic_ask_price ?? 0) - 0.995) < 1e-9);
  });

  it("when allowSyntheticAsk=true but noBid=null -> synthetic_rejected_no_bid, no candidate", async () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const m = market({
      yesTokenId: "syn0",
      question: "Election?",
      endDateIso: "2025-03-15T12:00:00Z",
    });
    const getBook = (tid: string | null) => (tid === "0" ? topOfBookPartial({ noBid: null, noAsk: null }) : null);
    const config = { ...baseConfig, allowSyntheticAsk: true };
    const { candidates, carryDebug } = await selectCarryCandidates([m], getBook, config, now);
    assert.strictEqual(candidates.length, 0);
    assert.strictEqual(carryDebug.synthetic_rejected_no_bid, 1);
  });

  it("when end time missing -> missing_end_time, no candidate (synthetic end time no longer allowed)", async () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const m = market({
      yesTokenId: "noEnd1",
      question: "Election?",
      endDateIso: null,
      resolutionTime: null,
    });
    const getBook = (tid: string | null) => (tid === "1" ? topOfBook(0.94, 0.01, 1000) : null);
    const config = { ...baseConfig, allowSyntheticAsk: true };
    const { candidates, carryDebug } = await selectCarryCandidates([m], getBook, config, now);
    assert.strictEqual(candidates.length, 0);
    assert.strictEqual(carryDebug.missing_end_time, 1);
  });

  it("market with endTime = now + 5 days -> tDays ~5 and passes when ROI/spread ok", async () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const endDate = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);
    const m = market({
      yesTokenId: "five5",
      question: "Election?",
      category: "Politics",
      endDateIso: endDate.toISOString(),
      resolutionTime: endDate,
    });
    const getBook = (tid: string | null) => (tid === "5" ? topOfBook(0.99, 0.01, 1000) : null);
    const config = { ...baseConfig, roiMinPct: 0.1, roiMaxPct: 100 };
    const { candidates, carryDebug } = await selectCarryCandidates([m], getBook, config, now);
    assert.strictEqual(candidates.length, 1);
    assert.ok(candidates[0].time_to_resolution_days >= 4.9 && candidates[0].time_to_resolution_days <= 5.1);
    assert.ok(candidates[0].end_time_iso != null);
    assert.strictEqual(carryDebug.passed, 1);
  });

  it("market with endTime = now + 0.1 days -> too_soon_to_resolve, rejected", async () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const endDate = new Date(now.getTime() + 0.1 * 24 * 60 * 60 * 1000);
    const m = market({
      yesTokenId: "soon1",
      question: "Election?",
      category: "Politics",
      endDateIso: endDate.toISOString(),
      resolutionTime: endDate,
    });
    const getBook = (tid: string | null) => (tid === "1" ? topOfBook(0.94, 0.01, 1000) : null);
    const { candidates, carryDebug } = await selectCarryCandidates([m], getBook, baseConfig, now);
    assert.strictEqual(candidates.length, 0);
    assert.strictEqual(carryDebug.too_soon_to_resolve, 1);
  });

  it("edge-vs-spread: yesAsk=0.95, yesBid=0.88, spread=0.07 passes when spreadEdgeMaxRatio=2.0 (max allowed spread 0.10)", async () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const m = market({
      yesTokenId: "edge1",
      question: "Election?",
      category: "Politics",
      endDateIso: "2025-03-15T12:00:00Z",
    });
    const getBook = (tid: string | null) => (tid === "1" ? topOfBook(0.95, 0.07, 1000) : null);
    const config = { ...baseConfig, roiMinPct: 0.1, roiMaxPct: 100, maxSpread: 0.15, spreadEdgeMaxRatio: 2.0 };
    const { candidates, carryDebug } = await selectCarryCandidates([m], getBook, config, now);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].yesAsk, 0.95);
    assert.ok(Math.abs((candidates[0].edge_abs ?? 0) - 0.05) < 1e-9);
    assert.ok(candidates[0].spread_edge_ratio != null && Math.abs(candidates[0].spread_edge_ratio - 0.07 / 0.05) < 1e-9);
    assert.strictEqual(carryDebug.passed, 1);
  });

  it("edge-vs-spread: yesAsk=0.98, yesBid=0.93, spread=0.05 rejected (spread/edge=2.5 > 2.0), spread_edge_too_high", async () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const m = market({
      yesTokenId: "edge2",
      question: "Election?",
      category: "Politics",
      endDateIso: "2025-03-15T12:00:00Z",
    });
    const getBook = (tid: string | null) => (tid === "2" ? topOfBook(0.98, 0.05, 1000) : null);
    const config = { ...baseConfig, roiMinPct: 0.1, roiMaxPct: 100, maxSpread: 0.15, spreadEdgeMaxRatio: 2.0 };
    const { candidates, carryDebug } = await selectCarryCandidates([m], getBook, config, now);
    assert.strictEqual(candidates.length, 0);
    assert.strictEqual(carryDebug.spread_edge_too_high, 1);
  });

  it("edge-vs-spread: spreadEdgeMinAbs=0.03, yesAsk=0.98 (edge=0.02) rejected, edge_too_small", async () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const m = market({
      yesTokenId: "edge3",
      question: "Election?",
      category: "Politics",
      endDateIso: "2025-03-15T12:00:00Z",
    });
    const getBook = (tid: string | null) => (tid === "3" ? topOfBook(0.98, 0.01, 1000) : null);
    const config = { ...baseConfig, roiMinPct: 0.1, roiMaxPct: 100, spreadEdgeMinAbs: 0.03 };
    const { candidates, carryDebug } = await selectCarryCandidates([m], getBook, config, now);
    assert.strictEqual(candidates.length, 0);
    assert.strictEqual(carryDebug.edge_too_small, 1);
  });

  it("carry ROI is computed from YES-token ask not NO-token (APR in band, both tokens present)", async () => {
    const now = new Date("2025-02-17T12:00:00Z");
    const endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const m = market({
      yesTokenId: "yes123",
      noTokenId: "no456",
      question: "Election?",
      category: "Politics",
      endDateIso: endDate.toISOString(),
      resolutionTime: endDate,
    });
    // YES token "123": ask 0.995 => raw ≈ 0.5025%, APR ≈ 6.11% (in 6–7% band). NO token "456" must not be used.
    const getBook = (tid: string | null) => {
      if (tid === "123") return topOfBook(0.995, 0.01, 1000);
      if (tid === "456") return topOfBook(0.51, 0.02, 1000);
      return null;
    };
    const config: CarryConfig = {
      ...baseConfig,
      roiMinPct: 6,
      roiMaxPct: 7,
      maxSpread: 0.05,
      allowHttpFallback: false,
      spreadEdgeMaxRatio: 2.0,
      spreadEdgeMinAbs: 0,
    };
    const { candidates, carryDebug } = await selectCarryCandidates([m], getBook, config, now);
    assert.strictEqual(candidates.length, 1, "one carry candidate from YES book");
    assert.strictEqual(candidates[0].yesTokenId, "123", "candidate uses normalized YES token id");
    assert.strictEqual(candidates[0].yesAsk, 0.995, "yesAsk must come from YES-token book");
    const expectedRaw = (1 - 0.995) / 0.995 * 100;
    assert.ok(Math.abs((candidates[0].carry_roi_raw_pct ?? 0) - expectedRaw) < 0.01, `carry_roi_raw_pct ≈ ${expectedRaw}`);
    assert.ok(candidates[0].carry_roi_pct >= 6 && candidates[0].carry_roi_pct <= 7, `APR in band got ${candidates[0].carry_roi_pct}`);
    assert.strictEqual(candidates[0].price_source, "ws");
    assert.strictEqual(carryDebug.passed, 1);
  });
});
