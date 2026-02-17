import type { Config } from "../config/load_config";
import type { PaperPosition } from "../types";

export interface RiskState {
  positions: PaperPosition[];
  totalExposureUsd: number;
  dailyStartEquity: number;
  dailyLowEquity: number;
  exposuresByCategory: Record<string, number>;
  exposuresByAssumption: Record<string, number>;
  exposuresByResolutionWindow: Record<string, number>;
  exposureByMarket: Record<string, number>;
}

export interface TradeProposalForRisk {
  marketId: string;
  conditionId: string;
  sizeUsd: number;
  category: string | null;
  assumptionGroup: string | null;
  resolutionWindowBucket: string | null;
}

export type RiskDecision = "ALLOW" | "BLOCK" | "ALLOW_REDUCED_SIZE";

export interface AllowTradeResult {
  /** @deprecated use decision instead */
  allow: boolean;
  /** @deprecated use reasons instead */
  blocks: string[];
  decision: RiskDecision;
  reasons: string[];
  /** When decision === ALLOW_REDUCED_SIZE, max size that fits under all caps. */
  suggested_size?: number;
}

function getResolutionWindowBucket(
  resolutionTime: Date | null,
  windows: Config["risk"]["resolution_windows"]
): string {
  if (!resolutionTime) return "unknown";
  const now = Date.now();
  const hoursLeft = (resolutionTime.getTime() - now) / (1000 * 60 * 60);
  for (const w of windows) {
    if (hoursLeft <= w.max_hours) return w.id;
  }
  return "beyond";
}

/**
 * Heuristic category from market (use config-based regex mapping later). For now use category or "uncategorized".
 */
export function inferCategory(market: { category?: string | null; question?: string }): string {
  const c = market.category?.trim();
  if (c) return c;
  return "uncategorized";
}

const ASSUMPTION_KEYWORDS: { pattern: RegExp; group: string }[] = [
  { pattern: /no\s+death|fatality|die|killed/i, group: "no_death" },
  { pattern: /no\s+war|no\s+conflict|ceasefire|invasion/i, group: "no_conflict" },
  { pattern: /no\s+recession|recession\s+no/i, group: "no_recession" },
  { pattern: /no\s+rate\s+cut|fed\s+cut/i, group: "no_fed_cut" },
  { pattern: /won't\s+happen|will\s+not\s+happen/i, group: "no_event" },
  { pattern: /no\s+default|default\s+no/i, group: "no_default" },
];

/**
 * Heuristic assumption group from question/title/description.
 */
export function inferAssumptionGroup(market: { question?: string; title?: string; rulesText?: string | null }): string {
  const text = [market.question, market.title, market.rulesText].filter(Boolean).join(" ").toLowerCase();
  for (const { pattern, group } of ASSUMPTION_KEYWORDS) {
    if (pattern.test(text)) return group;
  }
  return "other";
}

export function computeResolutionWindowBucket(
  resolutionTime: Date | null,
  config: Config
): string {
  return getResolutionWindowBucket(resolutionTime, config.risk.resolution_windows);
}

function buildRiskState(positions: PaperPosition[]): RiskState {
  const exposuresByCategory: Record<string, number> = {};
  const exposuresByAssumption: Record<string, number> = {};
  const exposuresByResolutionWindow: Record<string, number> = {};
  const exposureByMarket: Record<string, number> = {};
  let totalExposureUsd = 0;

  for (const p of positions) {
    if (p.closedAt) continue;
    totalExposureUsd += p.sizeUsd;
    const cat = p.category ?? "uncategorized";
    exposuresByCategory[cat] = (exposuresByCategory[cat] ?? 0) + p.sizeUsd;
    const ag = p.assumptionGroup ?? "other";
    exposuresByAssumption[ag] = (exposuresByAssumption[ag] ?? 0) + p.sizeUsd;
    const rw = p.resolutionWindowBucket ?? "unknown";
    exposuresByResolutionWindow[rw] = (exposuresByResolutionWindow[rw] ?? 0) + p.sizeUsd;
    exposureByMarket[p.marketId] = (exposureByMarket[p.marketId] ?? 0) + p.sizeUsd;
  }

  return {
    positions,
    totalExposureUsd,
    dailyStartEquity: 0,
    dailyLowEquity: 0,
    exposuresByCategory,
    exposuresByAssumption,
    exposuresByResolutionWindow,
    exposureByMarket,
  };
}

/**
 * Decide if a trade is allowed. Risk is NOT treated as independent per trade:
 * exposure is aggregated and enforced across per_trade (market), category_cap,
 * assumption_cap, time_window_cap, and global_cap.
 * Returns ALLOW | BLOCK | ALLOW_REDUCED_SIZE with reasons[] and suggested_size when reduced.
 */
export function allowTrade(
  proposal: TradeProposalForRisk,
  currentState: RiskState,
  config: Config
): AllowTradeResult {
  const reasons: string[] = [];
  const risk = config.risk;

  if (risk.kill_switch_enabled) {
    reasons.push("kill_switch_enabled");
    return {
      allow: false,
      blocks: reasons,
      decision: "BLOCK",
      reasons,
    };
  }

  const openCount = currentState.positions.filter((p) => !p.closedAt).length;
  if (openCount >= risk.max_positions_open) {
    reasons.push(`max_positions_open (${openCount} >= ${risk.max_positions_open})`);
    return {
      allow: false,
      blocks: reasons,
      decision: "BLOCK",
      reasons,
    };
  }

  const cat = proposal.category ?? "uncategorized";
  const ag = proposal.assumptionGroup ?? "other";
  const rw = proposal.resolutionWindowBucket ?? "unknown";
  const currentMarket = currentState.exposureByMarket[proposal.marketId] ?? 0;
  const currentCat = currentState.exposuresByCategory[cat] ?? 0;
  const currentAg = currentState.exposuresByAssumption[ag] ?? 0;
  const currentRw = currentState.exposuresByResolutionWindow[rw] ?? 0;

  // Headroom per dimension (max additional size that fits under each cap)
  const headroomGlobal = Math.max(0, risk.max_total_exposure_usd - currentState.totalExposureUsd);
  const headroomMarket = Math.max(0, risk.max_exposure_per_market_usd - currentMarket);
  const headroomCategory = Math.max(0, risk.max_exposure_per_category_usd - currentCat);
  const headroomAssumption = Math.max(0, risk.max_exposure_per_assumption_usd - currentAg);
  const headroomWindow = Math.max(0, risk.max_exposure_per_resolution_window_usd - currentRw);

  const requested = proposal.sizeUsd;
  const suggested_size = Math.min(
    headroomGlobal,
    headroomMarket,
    headroomCategory,
    headroomAssumption,
    headroomWindow,
    requested
  );

  if (requested > headroomGlobal) {
    reasons.push(`global_cap (${currentState.totalExposureUsd + requested} > ${risk.max_total_exposure_usd})`);
  }
  if (requested > headroomMarket) {
    reasons.push(`per_trade_cap [market] (${currentMarket + requested} > ${risk.max_exposure_per_market_usd})`);
  }
  if (requested > headroomCategory) {
    reasons.push(`category_cap [${cat}] (${currentCat + requested} > ${risk.max_exposure_per_category_usd})`);
  }
  if (requested > headroomAssumption) {
    reasons.push(`assumption_cap [${ag}] (${currentAg + requested} > ${risk.max_exposure_per_assumption_usd})`);
  }
  if (requested > headroomWindow) {
    reasons.push(`time_window_cap [${rw}] (${currentRw + requested} > ${risk.max_exposure_per_resolution_window_usd})`);
  }

  if (reasons.length === 0) {
    return {
      allow: true,
      blocks: [],
      decision: "ALLOW",
      reasons: [],
    };
  }
  if (suggested_size > 0) {
    return {
      allow: true,
      blocks: reasons,
      decision: "ALLOW_REDUCED_SIZE",
      reasons,
      suggested_size,
    };
  }
  return {
    allow: false,
    blocks: reasons,
    decision: "BLOCK",
    reasons,
  };
}

/**
 * Worst-case loss if all positions in this assumption group resolve against us (NO loses = full loss of position).
 */
export function worstCaseIfAssumptionFails(
  assumptionGroup: string,
  currentState: RiskState
): number {
  let total = 0;
  for (const p of currentState.positions) {
    if (p.closedAt) continue;
    if ((p.assumptionGroup ?? "other") === assumptionGroup) {
      total += p.sizeUsd;
    }
  }
  return total;
}

export function buildRiskStateFromPositions(positions: PaperPosition[]): RiskState {
  return buildRiskState(positions);
}
