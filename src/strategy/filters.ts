import type { NormalizedMarket, TopOfBook, FilterResult } from "../types";

const AMBIGUITY_KEYWORDS = [
  "at discretion",
  "according to",
  "official source",
  "TBD",
  "to be determined",
  "subject to",
  "resolved at the discretion",
  "final determination",
  "as determined by",
  "may be resolved",
  "could be resolved",
];

export interface FilterConfig {
  min_no_price: number;
  max_spread: number;
  min_liquidity_usd: number;
  max_time_to_resolution_hours: number;
}

function hoursBetween(now: Date, end: Date | null): number | null {
  if (!end) return null;
  const ms = end.getTime() - now.getTime();
  return ms / (1000 * 60 * 60);
}

function detectAmbiguity(rulesText: string | null): boolean {
  if (!rulesText) return false;
  const lower = rulesText.toLowerCase();
  return AMBIGUITY_KEYWORDS.some((k) => lower.includes(k));
}

/**
 * Evaluate a market candidate. Pass only if all thresholds met.
 * Never silently exclude for ambiguity; set RESOLUTION_AMBIGUOUS flag instead.
 */
export function evaluateMarketCandidate(
  market: NormalizedMarket,
  book: TopOfBook | null,
  now: Date,
  config: FilterConfig
): FilterResult {
  const reasons: string[] = [];
  const flags: string[] = [];

  if (market.closed) {
    reasons.push("market closed");
    return { pass: false, reasons, flags };
  }
  if (!market.noTokenId) {
    reasons.push("no NO token ID");
    return { pass: false, reasons, flags };
  }

  const entryPrice = book?.noAsk ?? null;
  if (entryPrice === null) {
    reasons.push("no NO ask (missing orderbook)");
    return { pass: false, reasons, flags };
  }
  if (entryPrice < config.min_no_price) {
    reasons.push(`NO ask ${entryPrice} < min_no_price ${config.min_no_price}`);
    return { pass: false, reasons, flags };
  }

  if (!book) {
    reasons.push("no orderbook");
    return { pass: false, reasons, flags };
  }
  const spread = book.spread ?? null;
  if (spread !== null && spread > config.max_spread) {
    reasons.push(`spread ${spread} > max_spread ${config.max_spread}`);
    return { pass: false, reasons, flags };
  }

  const liquidityUsd = Math.min(book.depthSummary.bidLiquidityUsd, book.depthSummary.askLiquidityUsd);
  if (liquidityUsd < config.min_liquidity_usd) {
    reasons.push(`liquidity ~${liquidityUsd.toFixed(0)} USD < min_liquidity_usd ${config.min_liquidity_usd}`);
    return { pass: false, reasons, flags };
  }

  const timeToResolution = hoursBetween(now, market.resolutionTime);
  if (timeToResolution !== null && timeToResolution > config.max_time_to_resolution_hours) {
    reasons.push(
      `time_to_resolution ${timeToResolution.toFixed(0)}h > max ${config.max_time_to_resolution_hours}h`
    );
    return { pass: false, reasons, flags };
  }
  if (timeToResolution !== null && timeToResolution < 0) {
    reasons.push("resolution time in the past");
    return { pass: false, reasons, flags };
  }

  if (detectAmbiguity(market.rulesText)) {
    flags.push("RESOLUTION_AMBIGUOUS");
  }

  return { pass: true, reasons: [], flags };
}
