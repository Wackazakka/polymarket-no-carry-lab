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

/** One failed threshold check (for diagnostic near-miss reporting). */
export interface FailedCheck {
  check: string;
  value: number;
  threshold: number;
  message: string;
}

export interface FilterResultWithDetails extends FilterResult {
  failedChecks: FailedCheck[];
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

/**
 * Like evaluateMarketCandidate but runs all checks and returns failedChecks for diagnostic use.
 * Use for "near miss" reporting when diagnostic_loose_filters is true.
 */
export function evaluateMarketCandidateWithDetails(
  market: NormalizedMarket,
  book: TopOfBook | null,
  now: Date,
  config: FilterConfig
): FilterResultWithDetails {
  const reasons: string[] = [];
  const flags: string[] = [];
  const failedChecks: FailedCheck[] = [];

  if (market.closed) {
    reasons.push("market closed");
    failedChecks.push({ check: "closed", value: 0, threshold: 0, message: "market closed" });
    return { pass: false, reasons, flags, failedChecks };
  }
  if (!market.noTokenId) {
    reasons.push("no NO token ID");
    failedChecks.push({ check: "no_token_id", value: 0, threshold: 0, message: "no NO token ID" });
    return { pass: false, reasons, flags, failedChecks };
  }

  const entryPrice = book?.noAsk ?? null;
  if (entryPrice === null) {
    reasons.push("no NO ask (missing orderbook)");
    failedChecks.push({ check: "no_ask", value: 0, threshold: 0, message: "no NO ask (missing orderbook)" });
    return { pass: false, reasons, flags, failedChecks };
  }
  if (entryPrice < config.min_no_price) {
    const msg = `NO ask ${entryPrice} < min_no_price ${config.min_no_price}`;
    reasons.push(msg);
    failedChecks.push({ check: "min_no_price", value: entryPrice, threshold: config.min_no_price, message: msg });
    return { pass: false, reasons, flags, failedChecks };
  }

  if (!book) {
    reasons.push("no orderbook");
    failedChecks.push({ check: "no_orderbook", value: 0, threshold: 0, message: "no orderbook" });
    return { pass: false, reasons, flags, failedChecks };
  }
  const spread = book.spread ?? null;
  if (spread !== null && spread > config.max_spread) {
    const msg = `spread ${spread} > max_spread ${config.max_spread}`;
    reasons.push(msg);
    failedChecks.push({ check: "max_spread", value: spread, threshold: config.max_spread, message: msg });
    return { pass: false, reasons, flags, failedChecks };
  }

  const liquidityUsd = Math.min(book.depthSummary.bidLiquidityUsd, book.depthSummary.askLiquidityUsd);
  if (liquidityUsd < config.min_liquidity_usd) {
    const msg = `liquidity ~${liquidityUsd.toFixed(0)} USD < min_liquidity_usd ${config.min_liquidity_usd}`;
    reasons.push(msg);
    failedChecks.push({ check: "min_liquidity_usd", value: liquidityUsd, threshold: config.min_liquidity_usd, message: msg });
    return { pass: false, reasons, flags, failedChecks };
  }

  const timeToResolution = hoursBetween(now, market.resolutionTime);
  if (timeToResolution !== null && timeToResolution > config.max_time_to_resolution_hours) {
    const msg = `time_to_resolution ${timeToResolution.toFixed(0)}h > max ${config.max_time_to_resolution_hours}h`;
    reasons.push(msg);
    failedChecks.push({ check: "max_time_to_resolution_hours", value: timeToResolution, threshold: config.max_time_to_resolution_hours, message: msg });
    return { pass: false, reasons, flags, failedChecks };
  }
  if (timeToResolution !== null && timeToResolution < 0) {
    reasons.push("resolution time in the past");
    failedChecks.push({ check: "resolution_past", value: timeToResolution, threshold: 0, message: "resolution time in the past" });
    return { pass: false, reasons, flags, failedChecks };
  }

  if (detectAmbiguity(market.rulesText)) {
    flags.push("RESOLUTION_AMBIGUOUS");
  }

  return { pass: true, reasons: [], flags, failedChecks: [] };
}
