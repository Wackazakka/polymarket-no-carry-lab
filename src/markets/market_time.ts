/**
 * Market end-time extraction for carry and resolution windows.
 * Tries candidate fields in priority order; normalizes to epoch ms.
 */

import type { NormalizedMarket } from "../types";

type MarketLike = NormalizedMarket | Record<string, unknown>;

const CANDIDATE_KEYS = [
  "resolutionTime",
  "endDateIso",
  "endDate",
  "end_date",
  "endTime",
  "end_time",
  "closeTime",
  "close_time",
  "expirationTime",
  "expiration_time",
  "resolution_time",
] as const;

function toMs(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Assume seconds if small (e.g. < 1e12), else ms
    const ms = value < 1e12 ? value * 1000 : value;
    return ms > 0 ? ms : null;
  }
  if (typeof value === "string") {
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * Extract market end/resolution time in epoch milliseconds.
 * Tries candidate fields in priority order; accepts ISO strings or epoch s/ms.
 * Returns null if no valid end time found.
 */
export function getMarketEndTimeMs(market: MarketLike): number | null {
  for (const key of CANDIDATE_KEYS) {
    const v = (market as Record<string, unknown>)[key];
    const ms = toMs(v);
    if (ms != null) return ms;
  }
  return null;
}

/**
 * Return end time as ISO string for observability, or null.
 */
export function getMarketEndTimeIso(market: MarketLike): string | null {
  const ms = getMarketEndTimeMs(market);
  if (ms == null) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}
