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

export interface AllowTradeResult {
  allow: boolean;
  blocks: string[];
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
 * Decide if a trade is allowed. Enforces all caps including correlated.
 */
export function allowTrade(
  proposal: TradeProposalForRisk,
  currentState: RiskState,
  config: Config
): AllowTradeResult {
  const blocks: string[] = [];
  const risk = config.risk;

  if (risk.kill_switch_enabled) {
    blocks.push("kill_switch_enabled");
    return { allow: false, blocks };
  }

  const openCount = currentState.positions.filter((p) => !p.closedAt).length;
  if (openCount >= risk.max_positions_open) {
    blocks.push(`max_positions_open (${openCount} >= ${risk.max_positions_open})`);
  }

  const newTotal = currentState.totalExposureUsd + proposal.sizeUsd;
  if (newTotal > risk.max_total_exposure_usd) {
    blocks.push(`max_total_exposure_usd (${newTotal} > ${risk.max_total_exposure_usd})`);
  }

  const marketExp = (currentState.exposureByMarket[proposal.marketId] ?? 0) + proposal.sizeUsd;
  if (marketExp > risk.max_exposure_per_market_usd) {
    blocks.push(`max_exposure_per_market_usd (${marketExp} > ${risk.max_exposure_per_market_usd})`);
  }

  const cat = proposal.category ?? "uncategorized";
  const catExp = (currentState.exposuresByCategory[cat] ?? 0) + proposal.sizeUsd;
  if (catExp > risk.max_exposure_per_category_usd) {
    blocks.push(`max_exposure_per_category_usd [${cat}] (${catExp} > ${risk.max_exposure_per_category_usd})`);
  }

  const ag = proposal.assumptionGroup ?? "other";
  const agExp = (currentState.exposuresByAssumption[ag] ?? 0) + proposal.sizeUsd;
  if (agExp > risk.max_exposure_per_assumption_usd) {
    blocks.push(`max_exposure_per_assumption_usd [${ag}] (${agExp} > ${risk.max_exposure_per_assumption_usd})`);
  }

  const rw = proposal.resolutionWindowBucket ?? "unknown";
  const rwExp = (currentState.exposuresByResolutionWindow[rw] ?? 0) + proposal.sizeUsd;
  if (rwExp > risk.max_exposure_per_resolution_window_usd) {
    blocks.push(`max_exposure_per_resolution_window_usd [${rw}] (${rwExp} > ${risk.max_exposure_per_resolution_window_usd})`);
  }

  return {
    allow: blocks.length === 0,
    blocks,
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
