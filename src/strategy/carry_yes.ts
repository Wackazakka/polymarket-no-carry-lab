/**
 * Resolution Carry (YES): buy YES near certainty and hold to resolution.
 * Candidate markets: procedural/deadline (keywords or category allowlist), time_to_resolution_days <= maxDays.
 * Pricing: YES ask, carry_roi_pct = (1 - ask) / ask * 100 in [roiMinPct, roiMaxPct].
 */

import { createHash } from "crypto";
import type { NormalizedMarket, TopOfBook } from "../types";

export interface CarryConfig {
  enabled: boolean;
  maxDays: number;
  roiMinPct: number;
  roiMaxPct: number;
  maxSpread: number;
  minAskLiqUsd: number;
  sizeUsd?: number;
  bankroll_fraction?: number;
  allowCategories: string[];
  allowKeywords: string[];
  allowSyntheticAsk: boolean;
  syntheticTick: number;
  syntheticMaxAsk: number;
}

const DEFAULT_CARRY_KEYWORDS = [
  "fed",
  "cpi",
  "temperature",
  "rainfall",
  "snow",
  "election",
  "court",
  "rate decision",
  "deadline",
  "resolution",
];

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Time to resolution in days from now. Uses resolutionTime or endDateIso. */
export function timeToResolutionDays(market: NormalizedMarket, now: Date): number | null {
  const endTs =
    market.resolutionTime && !Number.isNaN(market.resolutionTime.getTime())
      ? market.resolutionTime.getTime()
      : market.endDateIso
        ? new Date(market.endDateIso).getTime()
        : NaN;
  if (Number.isNaN(endTs)) return null;
  const days = (endTs - now.getTime()) / (1000 * 60 * 60 * 24);
  return days < 0 ? null : days;
}

/** Procedural/deadline heuristic: question or title contains any allowKeyword, or category in allowCategories. If both allowlists are empty, returns true (no procedural filter). */
export function isProceduralCandidate(
  market: NormalizedMarket,
  allowCategories: string[],
  allowKeywords: string[]
): boolean {
  const noCategoryList = allowCategories.length === 0;
  const noKeywordList = allowKeywords.length === 0;
  if (noCategoryList && noKeywordList) return true;

  const text = normalize((market.question ?? "") + " " + (market.title ?? ""));
  const keywords = allowKeywords.length > 0 ? allowKeywords : DEFAULT_CARRY_KEYWORDS;
  for (const kw of keywords) {
    if (text.includes(normalize(kw))) return true;
  }
  const cat = (market.category ?? "").trim().toLowerCase();
  if (cat && allowCategories.length > 0) {
    for (const c of allowCategories) {
      if (cat === c.trim().toLowerCase()) return true;
    }
  }
  return false;
}

/** Carry ROI from YES ask: (1 - ask) / ask * 100. */
export function carryRoiPct(yesAsk: number): number {
  if (yesAsk <= 0 || yesAsk >= 1) return 0;
  return ((1 - yesAsk) / yesAsk) * 100;
}

/** Stable assumption key for carry (event-family hash). */
export function carryAssumptionKey(market: NormalizedMarket): string {
  const payload = [
    market.category ?? "unknown",
    market.endDateIso ?? "",
    "carry",
  ]
    .map((x) => normalize(String(x)))
    .join("|");
  return "a1_" + createHash("sha1").update(payload, "utf8").digest("hex").slice(0, 12);
}

/** Window key for carry (e.g. W_carry_0_30D). */
export function carryWindowKey(days: number): string {
  if (days <= 7) return "W_carry_0_7D";
  if (days <= 30) return "W_carry_0_30D";
  return "W_carry_30D_PLUS";
}

export interface CarryCandidate {
  market: NormalizedMarket;
  yesTokenId: string;
  yesAsk: number;
  carry_roi_pct: number;
  spread: number;
  askLiquidityUsd: number;
  time_to_resolution_days: number;
  assumption_key: string;
  window_key: string;
  /** True when ask was synthetic (noAsk null, noBid + tick). PAPER ONLY. */
  synthetic_ask?: boolean;
  synthetic_ask_price?: number;
  synthetic_reason?: string;
  top_noBid?: number | null;
  top_noAsk?: number | null;
  /** True when resolution time was synthetic (no end date). PAPER ONLY. */
  synthetic_time?: boolean;
  synthetic_time_reason?: string;
  synthetic_time_to_resolution_days?: number;
}

export type GetTopOfBook = (tokenId: string | null) => TopOfBook | null;

export interface CarryDebugCounters {
  missing_yes_token_id: number;
  missing_end_time: number;
  beyond_max_days: number;
  procedural_rejected: number;
  no_book_or_ask: number;
  roi_out_of_band: number;
  spread_too_high: number;
  ask_liq_too_low: number;
  passed: number;
  synthetic_used: number;
  synthetic_rejected_no_bid: number;
  synthetic_time_used: number;
  synthetic_time_rejected: number;
}

export interface SelectCarryResult {
  candidates: CarryCandidate[];
  carryDebug: CarryDebugCounters;
}

/**
 * Select carry (YES) candidates from markets with YES orderbook.
 * Skips if config.carry.enabled is false. Returns candidates and debug counters.
 */
export function selectCarryCandidates(
  markets: NormalizedMarket[],
  getTopOfBook: GetTopOfBook,
  config: CarryConfig,
  now: Date
): SelectCarryResult {
  const carryDebug: CarryDebugCounters = {
    missing_yes_token_id: 0,
    missing_end_time: 0,
    beyond_max_days: 0,
    procedural_rejected: 0,
    no_book_or_ask: 0,
    roi_out_of_band: 0,
    spread_too_high: 0,
    ask_liq_too_low: 0,
    passed: 0,
    synthetic_used: 0,
    synthetic_rejected_no_bid: 0,
    synthetic_time_used: 0,
    synthetic_time_rejected: 0,
  };

  if (!config.enabled) return { candidates: [], carryDebug };

  const out: CarryCandidate[] = [];
  const {
    maxDays,
    roiMinPct,
    roiMaxPct,
    maxSpread,
    minAskLiqUsd,
    allowCategories,
    allowKeywords,
    allowSyntheticAsk,
    syntheticTick,
    syntheticMaxAsk,
  } = config;

  for (const market of markets) {
    if (!market.yesTokenId) {
      carryDebug.missing_yes_token_id++;
      continue;
    }

    let days = timeToResolutionDays(market, now);
    let synthetic_time = false;
    let synthetic_time_reason: string | undefined;
    let synthetic_time_to_resolution_days: number | undefined;
    if (days == null) {
      if (!allowSyntheticAsk) {
        carryDebug.missing_end_time++;
        carryDebug.synthetic_time_rejected++;
        continue;
      }
      days = 1;
      synthetic_time = true;
      synthetic_time_reason = "implicit_deadline_paper_only";
      synthetic_time_to_resolution_days = 1;
    }
    if (days > maxDays) {
      carryDebug.beyond_max_days++;
      continue;
    }

    if (!isProceduralCandidate(market, allowCategories, allowKeywords)) {
      carryDebug.procedural_rejected++;
      continue;
    }

    const book = getTopOfBook(market.yesTokenId);
    if (!book) {
      carryDebug.no_book_or_ask++;
      continue;
    }

    let yesAsk: number;
    let spread: number;
    let askLiquidityUsd: number;
    let synthetic_ask = false;
    let synthetic_ask_price: number | undefined;
    let synthetic_reason: string | undefined;
    const top_noBid = book.noBid ?? null;
    const top_noAsk = book.noAsk ?? null;

    if (book.noAsk == null || book.noAsk <= 0) {
      if (!allowSyntheticAsk) {
        carryDebug.no_book_or_ask++;
        continue;
      }
      if (book.noBid == null || book.noBid <= 0) {
        carryDebug.synthetic_rejected_no_bid++;
        continue;
      }
      synthetic_ask_price = Math.min(book.noBid + syntheticTick, syntheticMaxAsk);
      yesAsk = synthetic_ask_price;
      synthetic_ask = true;
      synthetic_reason = "no_ask_using_noBid_plus_tick";
      spread = syntheticTick;
      askLiquidityUsd = 0;
    } else {
      yesAsk = book.noAsk;
      spread = book.spread ?? 0;
      if (spread > maxSpread) {
        carryDebug.spread_too_high++;
        continue;
      }
      askLiquidityUsd = book.depthSummary?.askLiquidityUsd ?? 0;
      if (askLiquidityUsd < minAskLiqUsd) {
        carryDebug.ask_liq_too_low++;
        continue;
      }
    }

    const roi = carryRoiPct(yesAsk);
    if (roi < roiMinPct || roi > roiMaxPct) {
      carryDebug.roi_out_of_band++;
      continue;
    }

    carryDebug.passed++;
    if (synthetic_ask) carryDebug.synthetic_used++;
    if (synthetic_time) carryDebug.synthetic_time_used++;

    out.push({
      market,
      yesTokenId: market.yesTokenId,
      yesAsk,
      carry_roi_pct: roi,
      spread,
      askLiquidityUsd,
      time_to_resolution_days: days,
      assumption_key: carryAssumptionKey(market),
      window_key: carryWindowKey(days),
      ...(synthetic_ask && {
        synthetic_ask: true,
        synthetic_ask_price,
        synthetic_reason,
        top_noBid,
        top_noAsk,
      }),
      ...(synthetic_time && {
        synthetic_time: true,
        synthetic_time_reason,
        synthetic_time_to_resolution_days,
      }),
    });
  }

  return { candidates: out, carryDebug };
}
