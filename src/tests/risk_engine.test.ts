/**
 * Unit tests: correlated caps (category, assumption, time_window, global).
 * Proves: a trade that passes per_trade_cap can be BLOCKED by category/assumption/time/global;
 * multiple trades accumulate and eventually hit caps.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import type { Config } from "../config/load_config";
import type { PaperPosition } from "../types";
import {
  allowTrade,
  buildRiskStateFromPositions,
  type TradeProposalForRisk,
  type RiskState,
} from "../risk/risk_engine";

function mockConfig(overrides: Partial<Config["risk"]> = {}): Config {
  const risk = {
    max_total_exposure_usd: 10_000,
    max_exposure_per_market_usd: 2_000,
    max_positions_open: 20,
    max_daily_drawdown_usd: 2_000,
    kill_switch_enabled: false,
    max_exposure_per_category_usd: 3_000,
    max_exposure_per_assumption_usd: 2_500,
    max_exposure_per_resolution_window_usd: 4_000,
    resolution_windows: [
      { id: "same_day", label: "Same day", max_hours: 24 },
      { id: "48h", label: "48h", max_hours: 48 },
      { id: "1w", label: "1 week", max_hours: 168 },
      { id: "beyond", label: "Beyond 1w", max_hours: 999999 },
    ],
    ...overrides,
  };
  return { risk } as Config;
}

function emptyState(): RiskState {
  return buildRiskStateFromPositions([]);
}

function stateWithPositions(positions: Array<{ marketId: string; category: string; assumptionGroup: string; resolutionWindowBucket: string; sizeUsd: number }>): RiskState {
  const pos: PaperPosition[] = positions.map((p) => ({
    id: `id-${p.marketId}`,
    marketId: p.marketId,
    conditionId: "cond",
    side: "NO",
    entryPrice: 0.98,
    sizeUsd: p.sizeUsd,
    sizeShares: p.sizeUsd / 0.98,
    category: p.category,
    assumptionGroup: p.assumptionGroup,
    resolutionWindowBucket: p.resolutionWindowBucket,
    assumptionKey: p.assumptionGroup,
    windowKey: p.resolutionWindowBucket,
    openedAt: new Date().toISOString(),
    closedAt: null,
    expectedPnl: null,
  }));
  return buildRiskStateFromPositions(pos);
}

function proposal(marketId: string, sizeUsd: number, category: string, assumptionGroup: string, resolutionWindowBucket: string): TradeProposalForRisk {
  return {
    marketId,
    conditionId: "cond",
    sizeUsd,
    category,
    assumptionGroup,
    resolutionWindowBucket,
    assumptionKey: assumptionGroup,
    windowKey: resolutionWindowBucket,
  };
}

describe("allowTrade correlated caps", () => {
  it("ALLOW when within all caps", () => {
    const config = mockConfig();
    const result = allowTrade(
      proposal("m1", 500, "Politics", "other", "1w"),
      emptyState(),
      config
    );
    assert.strictEqual(result.decision, "ALLOW");
    assert.strictEqual(result.allow, true);
    assert.strictEqual(result.reasons.length, 0);
    assert.strictEqual(result.suggested_size, undefined);
  });

  it("BLOCK by global_cap when no headroom (total would exceed)", () => {
    const config = mockConfig({ max_total_exposure_usd: 1_000 });
    const state = stateWithPositions([
      { marketId: "m0", category: "A", assumptionGroup: "other", resolutionWindowBucket: "1w", sizeUsd: 1_000 },
    ]);
    const result = allowTrade(
      proposal("m1", 500, "B", "other", "1w"),
      state,
      config
    );
    assert.strictEqual(result.decision, "BLOCK");
    assert.strictEqual(result.allow, false);
    assert.ok(result.reasons.some((r) => r.includes("global")));
    assert.strictEqual(result.suggested_size, undefined);
  });

  it("BLOCK by category_cap when category already at cap", () => {
    const config = mockConfig({ max_exposure_per_category_usd: 1_000 });
    const state = stateWithPositions([
      { marketId: "m0", category: "Politics", assumptionGroup: "other", resolutionWindowBucket: "1w", sizeUsd: 1_000 },
    ]);
    const result = allowTrade(
      proposal("m1", 500, "Politics", "other", "1w"),
      state,
      config
    );
    assert.strictEqual(result.decision, "BLOCK");
    assert.ok(result.reasons.some((r) => r.includes("category") && r.includes("Politics")));
  });

  it("BLOCK by assumption_cap when assumption already at cap", () => {
    const config = mockConfig({ max_exposure_per_assumption_usd: 1_000 });
    const state = stateWithPositions([
      { marketId: "m0", category: "A", assumptionGroup: "no_recession", resolutionWindowBucket: "1w", sizeUsd: 1_000 },
    ]);
    const result = allowTrade(
      proposal("m1", 500, "B", "no_recession", "1w"),
      state,
      config
    );
    assert.strictEqual(result.decision, "BLOCK");
    assert.ok(result.reasons.some((r) => r.includes("assumption") && r.includes("no_recession")));
  });

  it("BLOCK by time_window_cap when window already at cap", () => {
    const config = mockConfig({ max_exposure_per_resolution_window_usd: 1_000 });
    const state = stateWithPositions([
      { marketId: "m0", category: "A", assumptionGroup: "other", resolutionWindowBucket: "48h", sizeUsd: 1_000 },
    ]);
    const result = allowTrade(
      proposal("m1", 500, "B", "other", "48h"),
      state,
      config
    );
    assert.strictEqual(result.decision, "BLOCK");
    assert.ok(result.reasons.some((r) => r.includes("time_window_cap") && r.includes("48h")));
  });

  it("ALLOW_REDUCED_SIZE with suggested_size when one cap limits", () => {
    const config = mockConfig({ max_exposure_per_category_usd: 1_000 });
    const state = stateWithPositions([
      { marketId: "m0", category: "Politics", assumptionGroup: "other", resolutionWindowBucket: "1w", sizeUsd: 800 },
    ]);
    const result = allowTrade(
      proposal("m1", 500, "Politics", "other", "1w"),
      state,
      config
    );
    assert.strictEqual(result.decision, "ALLOW_REDUCED_SIZE");
    assert.strictEqual(result.allow, true);
    assert.strictEqual(result.suggested_size, 200);
    assert.ok(result.reasons.some((r) => r.includes("category")));
  });

  it("headroom is included and suggested_size equals limiting headroom for ALLOW_REDUCED_SIZE", () => {
    const config = mockConfig({ max_exposure_per_category_usd: 1_000 });
    const state = stateWithPositions([
      { marketId: "m0", category: "Politics", assumptionGroup: "other", resolutionWindowBucket: "1w", sizeUsd: 800 },
    ]);
    const result = allowTrade(
      proposal("m1", 500, "Politics", "other", "1w"),
      state,
      config
    );
    assert.strictEqual(result.decision, "ALLOW_REDUCED_SIZE");
    assert.ok(result.headroom != null, "headroom must be present");
    const hr = result.headroom!;
    const limiting = Math.min(
      hr.global,
      hr.category,
      hr.assumption,
      hr.window,
      hr.per_market,
      500
    );
    assert.strictEqual(result.suggested_size, limiting, "suggested_size must equal limiting headroom (capped by requested)");
    assert.strictEqual(hr.category, 200, "category headroom is 1000 - 800");
    assert.strictEqual(result.suggested_size, 200);
  });

  it("multiple trades accumulate and hit category cap", () => {
    const config = mockConfig({ max_exposure_per_category_usd: 1_500 });
    let state = emptyState();
    const p1 = proposal("m1", 600, "Politics", "other", "1w");
    const r1 = allowTrade(p1, state, config);
    assert.strictEqual(r1.decision, "ALLOW");
    state = stateWithPositions([
      { marketId: "m1", category: "Politics", assumptionGroup: "other", resolutionWindowBucket: "1w", sizeUsd: 600 },
    ]);
    const r2 = allowTrade(proposal("m2", 600, "Politics", "other", "1w"), state, config);
    assert.strictEqual(r2.decision, "ALLOW");
    state = stateWithPositions([
      { marketId: "m1", category: "Politics", assumptionGroup: "other", resolutionWindowBucket: "1w", sizeUsd: 600 },
      { marketId: "m2", category: "Politics", assumptionGroup: "other", resolutionWindowBucket: "1w", sizeUsd: 600 },
    ]);
    const r3 = allowTrade(proposal("m3", 400, "Politics", "other", "1w"), state, config);
    assert.strictEqual(r3.decision, "ALLOW_REDUCED_SIZE");
    assert.strictEqual(r3.suggested_size, 300);
    state = stateWithPositions([
      { marketId: "m1", category: "Politics", assumptionGroup: "other", resolutionWindowBucket: "1w", sizeUsd: 600 },
      { marketId: "m2", category: "Politics", assumptionGroup: "other", resolutionWindowBucket: "1w", sizeUsd: 600 },
      { marketId: "m3", category: "Politics", assumptionGroup: "other", resolutionWindowBucket: "1w", sizeUsd: 300 },
    ]);
    const r4 = allowTrade(proposal("m4", 100, "Politics", "other", "1w"), state, config);
    assert.strictEqual(r4.decision, "BLOCK");
    assert.strictEqual(r4.suggested_size, undefined);
  });

  it("BLOCK when kill_switch_enabled", () => {
    const config = mockConfig({ kill_switch_enabled: true });
    const result = allowTrade(
      proposal("m1", 100, "A", "other", "1w"),
      emptyState(),
      config
    );
    assert.strictEqual(result.decision, "BLOCK");
    assert.ok(result.reasons.includes("kill_switch_enabled"));
  });

  it("caps use exposure_amount (notional USD), not shares or price", () => {
    const config = mockConfig({ max_exposure_per_category_usd: 150 });
    // Position 1: 100 USD notional at 0.98 (≈102 shares). Position 2 proposal: 100 USD notional at 0.50 (200 shares).
    // If we mistakenly used shares or price, cap would be wrong. We use sizeUsd everywhere.
    const state = stateWithPositions([
      { marketId: "m1", category: "SameCat", assumptionGroup: "other", resolutionWindowBucket: "1w", sizeUsd: 100 },
    ]);
    const result = allowTrade(
      proposal("m2", 100, "SameCat", "other", "1w"),
      state,
      config
    );
    assert.strictEqual(result.decision, "ALLOW_REDUCED_SIZE");
    assert.strictEqual(result.suggested_size, 50);
    assert.ok(result.reasons.some((r) => r.includes("category")));
  });
});
