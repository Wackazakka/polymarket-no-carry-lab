/**
 * Resolution Carry (YES): buy YES near certainty and hold to resolution.
 * Candidate markets: procedural/deadline (keywords or category allowlist), time_to_resolution_days <= maxDays.
 * Pricing: YES ask, carry_roi_pct = (1 - ask) / ask * 100 in [roiMinPct, roiMaxPct].
 */

import { createHash } from "crypto";
import { getMarketEndTimeIso, getMarketEndTimeMs } from "../markets/market_time";
import { normalizeBookKey } from "../markets/orderbook_ws";
import { fetchTopOfBookHttp, type HttpTopOfBook } from "../markets/clob_http";
import type { NormalizedMarket, TopOfBook } from "../types";

/** Normalize outcome token id: unwrap JSON-array string like '["123"]' to digits-only; null if empty. */
export function firstTokenId(raw: unknown): string | null {
  let s: string;
  if (typeof raw === "string" && raw.trim().startsWith("[")) {
    try {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr) && arr.length > 0) s = String(arr[0]);
      else s = String(raw);
    } catch {
      s = String(raw);
    }
  } else {
    s = String(raw ?? "");
  }
  const key = normalizeBookKey(s);
  return key || null;
}

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
  /** When true, gate on raw hold-to-resolution ROI (roiMinPct/roiMaxPct); when false, gate on APR. */
  useRawRoi?: boolean;
  /** When true (default for paper), fetch top-of-book via CLOB HTTP if WS has no book. */
  allowHttpFallback?: boolean;
  /** Base URL for CLOB HTTP book (e.g. https://clob.polymarket.com). Used when allowHttpFallback is true. */
  clobHttpBaseUrl?: string;
  /** Max spread/edge ratio: reject when spread > (1 - yesAsk) * this. Default 2.0. */
  spreadEdgeMaxRatio?: number;
  /** Min absolute edge (1 - yesAsk) to allow; reject when edge <= this. Default 0. */
  spreadEdgeMinAbs?: number;
  /** Min time to resolution (days); reject when tDays < this. Default 2. */
  minDaysToResolution?: number;
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

/** Raw carry ROI from YES ask: (1 - ask) / ask * 100 (not annualized). */
export function carryRoiPct(yesAsk: number): number {
  if (yesAsk <= 0 || yesAsk >= 1) return 0;
  return ((1 - yesAsk) / yesAsk) * 100;
}

/** Annualized ROI (APR): raw_roi_pct * (365 / t_days). Returns 0 if t_days <= 0. */
export function carryRoiAprPct(rawRoiPct: number, tDays: number): number {
  if (tDays <= 0 || !Number.isFinite(tDays)) return 0;
  return rawRoiPct * (365 / tDays);
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

export type CarryPriceSource = "ws" | "http" | "synthetic_ask";

export interface CarryCandidate {
  market: NormalizedMarket;
  yesTokenId: string;
  yesAsk: number;
  /** Annualized ROI (APR) used for band gate and display. */
  carry_roi_pct: number;
  /** Raw ROI (not annualized) for debugging. */
  carry_roi_raw_pct: number;
  spread: number;
  askLiquidityUsd: number;
  time_to_resolution_days: number;
  assumption_key: string;
  window_key: string;
  /** Observability: bid. ev_breakdown spread = (yesBid != null && yesAsk) ? yesAsk - yesBid : null. */
  yesBid?: number | null;
  /** Observability: ask - bid when both exist, else null. */
  spreadObservable?: number | null;
  /** Edge in dollars per $1 share: 1 - yesAsk. */
  edge_abs: number;
  /** spread / edge_abs when both > 0, else null. */
  spread_edge_ratio: number | null;
  price_source: CarryPriceSource;
  http_fallback_used?: boolean;
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
  /** Observability: market end/resolution time ISO. */
  end_time_iso?: string;
}

export type GetTopOfBook = (tokenId: string | null) => TopOfBook | null;

/** Optional injector for tests (avoid hitting network). */
export type FetchTopOfBookHttp = (tokenId: string, baseUrl?: string) => Promise<HttpTopOfBook | null>;

function httpToTopOfBook(h: HttpTopOfBook, minAskLiqUsd: number): TopOfBook {
  return {
    noBid: h.noBid,
    noAsk: h.noAsk,
    spread: h.spread,
    depthSummary: {
      bidLiquidityUsd: 0,
      askLiquidityUsd: Math.max(minAskLiqUsd, 1000),
      levels: 1,
    },
  };
}

export interface CarryDebugCounters {
  missing_yes_token_id: number;
  missing_end_time: number;
  already_ended_or_resolving: number;
  too_soon_to_resolve: number;
  beyond_max_days: number;
  procedural_rejected: number;
  no_book_or_ask: number;
  roi_out_of_band: number;
  spread_too_high: number;
  spread_edge_too_high: number;
  edge_too_small: number;
  ask_liq_too_low: number;
  passed: number;
  synthetic_used: number;
  synthetic_rejected_no_bid: number;
  synthetic_time_used: number;
  synthetic_time_rejected: number;
  http_used: number;
  http_failed: number;
}

/** Near-miss sample when rejecting for spread or ROI (max 5 per reason). */
export interface CarryNearMissSample {
  market_id: string;
  yes_token_id: string;
  t_days: number;
  end_time_iso: string | null;
  yes_bid: number | null;
  yes_ask: number;
  spread: number;
  carry_roi_pct: number;
  carry_roi_raw_pct?: number;
  price_source: CarryPriceSource;
  spread_edge_ratio: number | null;
}

/** Minimal sample for too_soon_to_resolve (max 3). */
export interface CarryTooSoonSample {
  market_id: string;
  t_days: number;
  end_time_iso: string | null;
}

export interface CarryDebugSamples {
  samples_spread_too_high: CarryNearMissSample[];
  samples_roi_out_of_band: CarryNearMissSample[];
  samples_too_soon_to_resolve: CarryTooSoonSample[];
}

export interface CarryRoiStatsPreBand {
  count: number;
  min: number;
  p10: number;
  p50: number;
  p90: number;
  max: number;
}

export interface SelectCarryResult {
  candidates: CarryCandidate[];
  carryDebug: CarryDebugCounters;
  /** Near-miss samples (spread/ROI/too_soon) for debugging passed=0. */
  carrySamples: CarryDebugSamples;
  /** APR distribution before ROI band filter (for tuning). */
  carry_roi_stats_pre_band: CarryRoiStatsPreBand | null;
  /** Raw ROI distribution before band (debug). */
  carry_roi_raw_stats_pre_band: CarryRoiStatsPreBand | null;
  /** First few yesTokenIds that hit no_book_or_ask (for carry probe logging). */
  sampleNoBookTokenIds: string[];
}

/**
 * Select carry (YES) candidates from markets with YES orderbook.
 * Skips if config.carry.enabled is false. Returns candidates and debug counters.
 * When allowHttpFallback is true, uses CLOB HTTP top-of-book when WS has no book (paper-only).
 */
export async function selectCarryCandidates(
  markets: NormalizedMarket[],
  getTopOfBook: GetTopOfBook,
  config: CarryConfig,
  now: Date,
  fetchHttp?: FetchTopOfBookHttp
): Promise<SelectCarryResult> {
  const carryDebug: CarryDebugCounters = {
    missing_yes_token_id: 0,
    missing_end_time: 0,
    already_ended_or_resolving: 0,
    too_soon_to_resolve: 0,
    beyond_max_days: 0,
    procedural_rejected: 0,
    no_book_or_ask: 0,
    roi_out_of_band: 0,
    spread_too_high: 0,
    spread_edge_too_high: 0,
    edge_too_small: 0,
    ask_liq_too_low: 0,
    passed: 0,
    synthetic_used: 0,
    synthetic_rejected_no_bid: 0,
    synthetic_time_used: 0,
    synthetic_time_rejected: 0,
    http_used: 0,
    http_failed: 0,
  };

  const carrySamples: CarryDebugSamples = {
    samples_spread_too_high: [],
    samples_roi_out_of_band: [],
    samples_too_soon_to_resolve: [],
  };
  const roi_apr_pre_band: number[] = [];
  const roi_raw_pre_band: number[] = [];
  const MAX_NEAR_MISS_SAMPLE = 5;
  const MAX_TOO_SOON_SAMPLE = 3;

  if (!config.enabled) {
    return {
      candidates: [],
      carryDebug,
      carrySamples,
      carry_roi_stats_pre_band: null,
      carry_roi_raw_stats_pre_band: null,
      sampleNoBookTokenIds: [],
    };
  }

  const out: CarryCandidate[] = [];
  const sampleNoBookTokenIds: string[] = [];
  const MAX_NO_BOOK_SAMPLE = 5;
  const doFetchHttp = fetchHttp ?? fetchTopOfBookHttp;
  const {
    maxDays,
    minDaysToResolution = 2,
    roiMinPct,
    roiMaxPct,
    useRawRoi = false,
    maxSpread,
    minAskLiqUsd,
    allowCategories,
    allowKeywords,
    allowSyntheticAsk,
    syntheticTick,
    syntheticMaxAsk,
    allowHttpFallback = true,
    clobHttpBaseUrl,
    spreadEdgeMaxRatio = 2.0,
    spreadEdgeMinAbs = 0.0,
  } = config;

  for (const market of markets) {
    if (!market.yesTokenId) {
      carryDebug.missing_yes_token_id++;
      continue;
    }
    const yesTokenIdNorm = firstTokenId(market.yesTokenId);
    if (!yesTokenIdNorm) {
      carryDebug.missing_yes_token_id++;
      continue;
    }

    const endMs = getMarketEndTimeMs(market);
    if (endMs == null) {
      carryDebug.missing_end_time++;
      continue;
    }
    const end_time_iso: string | null = getMarketEndTimeIso(market) ?? null;
    const nowMs = now.getTime();
    const tDays = (endMs - nowMs) / (1000 * 60 * 60 * 24);
    if (tDays <= 0) {
      carryDebug.already_ended_or_resolving++;
      continue;
    }
    if (tDays < minDaysToResolution) {
      carryDebug.too_soon_to_resolve++;
      if (carrySamples.samples_too_soon_to_resolve.length < MAX_TOO_SOON_SAMPLE) {
        carrySamples.samples_too_soon_to_resolve.push({
          market_id: market.marketId,
          t_days: tDays,
          end_time_iso,
        });
      }
      continue;
    }
    if (tDays > maxDays) {
      carryDebug.beyond_max_days++;
      continue;
    }
    const days = tDays;

    if (!isProceduralCandidate(market, allowCategories, allowKeywords)) {
      carryDebug.procedural_rejected++;
      continue;
    }

    // Top-of-book must be for YES token only (carry ROI = (1 - yesAsk)/yesAsk). Never use noTokenId.
    let book: TopOfBook | null = getTopOfBook(yesTokenIdNorm);
    let httpFallbackUsed = false;
    if (!book && allowHttpFallback) {
      const httpTop = await doFetchHttp(yesTokenIdNorm, clobHttpBaseUrl);
      if (httpTop != null && (httpTop.noAsk != null || httpTop.noBid != null)) {
        book = httpToTopOfBook(httpTop, minAskLiqUsd);
        carryDebug.http_used++;
        httpFallbackUsed = true;
      } else {
        if (httpTop === null) carryDebug.http_failed++;
      }
    }
    if (!book) {
      carryDebug.no_book_or_ask++;
      if (sampleNoBookTokenIds.length < MAX_NO_BOOK_SAMPLE) sampleNoBookTokenIds.push(yesTokenIdNorm);
      continue;
    }

    let yesAsk: number;
    let spread: number;
    let askLiquidityUsd: number;
    let synthetic_ask = false;
    let synthetic_ask_price: number | undefined;
    let synthetic_reason: string | undefined;
    let top_noBid = book.noBid ?? null;
    let top_noAsk = book.noAsk ?? null;

    if (book.noAsk == null || book.noAsk <= 0) {
      if (allowHttpFallback) {
        const httpTop = await doFetchHttp(yesTokenIdNorm, clobHttpBaseUrl);
        if (httpTop?.noAsk != null && httpTop.noAsk > 0) {
          top_noAsk = httpTop.noAsk;
          if (httpTop.noBid != null) top_noBid = httpTop.noBid;
          carryDebug.http_used++;
          httpFallbackUsed = true;
          book = {
            ...book,
            noAsk: httpTop.noAsk,
            noBid: httpTop.noBid ?? book.noBid,
            spread: httpTop.spread ?? book.spread,
          };
        }
      }
      if (book.noAsk == null || book.noAsk <= 0) {
        if (!allowSyntheticAsk) {
          carryDebug.no_book_or_ask++;
          if (sampleNoBookTokenIds.length < MAX_NO_BOOK_SAMPLE) sampleNoBookTokenIds.push(yesTokenIdNorm);
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
          if (carrySamples.samples_spread_too_high.length < MAX_NEAR_MISS_SAMPLE) {
            const spreadObservable = top_noBid != null ? yesAsk - top_noBid : null;
            const edgeAbs = 1 - yesAsk;
            const price_source: CarryPriceSource = synthetic_ask ? "synthetic_ask" : httpFallbackUsed ? "http" : "ws";
            const rawR = carryRoiPct(yesAsk);
            carrySamples.samples_spread_too_high.push({
              market_id: market.marketId,
              yes_token_id: yesTokenIdNorm,
              t_days: days,
              end_time_iso: end_time_iso ?? null,
              yes_bid: top_noBid,
              yes_ask: yesAsk,
              spread,
              carry_roi_pct: carryRoiAprPct(rawR, days),
              carry_roi_raw_pct: rawR,
              price_source,
              spread_edge_ratio: spreadObservable != null && edgeAbs > 0 ? spreadObservable / edgeAbs : null,
            });
          }
          continue;
        }
        askLiquidityUsd = book.depthSummary?.askLiquidityUsd ?? 0;
        if (askLiquidityUsd < minAskLiqUsd) {
          carryDebug.ask_liq_too_low++;
          continue;
        }
      }
    } else {
      yesAsk = book.noAsk;
      spread = book.spread ?? 0;
      if (spread > maxSpread) {
        carryDebug.spread_too_high++;
        if (carrySamples.samples_spread_too_high.length < MAX_NEAR_MISS_SAMPLE) {
          const spreadObservable = top_noBid != null ? yesAsk - top_noBid : null;
          const edgeAbs = 1 - yesAsk;
          const price_source: CarryPriceSource = synthetic_ask ? "synthetic_ask" : httpFallbackUsed ? "http" : "ws";
          const rawR = carryRoiPct(yesAsk);
          carrySamples.samples_spread_too_high.push({
            market_id: market.marketId,
            yes_token_id: yesTokenIdNorm,
            t_days: days,
            end_time_iso: end_time_iso ?? null,
            yes_bid: top_noBid,
            yes_ask: yesAsk,
            spread,
            carry_roi_pct: carryRoiAprPct(rawR, days),
            carry_roi_raw_pct: rawR,
            price_source,
            spread_edge_ratio: spreadObservable != null && edgeAbs > 0 ? spreadObservable / edgeAbs : null,
          });
        }
        continue;
      }
      askLiquidityUsd = book.depthSummary?.askLiquidityUsd ?? 0;
      if (askLiquidityUsd < minAskLiqUsd) {
        carryDebug.ask_liq_too_low++;
        continue;
      }
    }

    const spreadObservable: number | null = top_noBid != null ? yesAsk - top_noBid : null;
    const edgeAbs = 1 - yesAsk;
    if (edgeAbs <= spreadEdgeMinAbs) {
      carryDebug.edge_too_small++;
      continue;
    }
    if (spreadObservable != null && spread > edgeAbs * spreadEdgeMaxRatio) {
      carryDebug.spread_edge_too_high++;
      continue;
    }

    const roi_raw_pct = carryRoiPct(yesAsk);
    const roi_apr_pct = carryRoiAprPct(roi_raw_pct, days);
    roi_apr_pre_band.push(roi_apr_pct);
    roi_raw_pre_band.push(roi_raw_pct);
    const roi_gate_pct = useRawRoi ? roi_raw_pct : roi_apr_pct;
    if (roi_gate_pct < roiMinPct || roi_gate_pct > roiMaxPct) {
      carryDebug.roi_out_of_band++;
      if (carrySamples.samples_roi_out_of_band.length < MAX_NEAR_MISS_SAMPLE) {
        const price_source: CarryPriceSource = synthetic_ask ? "synthetic_ask" : httpFallbackUsed ? "http" : "ws";
        const spread_edge_ratio: number | null =
          spreadObservable != null && edgeAbs > 0 ? spreadObservable / edgeAbs : null;
        carrySamples.samples_roi_out_of_band.push({
          market_id: market.marketId,
          yes_token_id: yesTokenIdNorm,
          t_days: days,
          end_time_iso: end_time_iso ?? null,
          yes_bid: top_noBid,
          yes_ask: yesAsk,
          spread,
          carry_roi_pct: roi_apr_pct,
          carry_roi_raw_pct: roi_raw_pct,
          price_source,
          spread_edge_ratio,
        });
      }
      continue;
    }

    carryDebug.passed++;
    if (synthetic_ask) carryDebug.synthetic_used++;

    const price_source: CarryPriceSource = synthetic_ask ? "synthetic_ask" : httpFallbackUsed ? "http" : "ws";
    const spread_edge_ratio: number | null =
      spreadObservable != null && edgeAbs > 0 ? spreadObservable / edgeAbs : null;

    out.push({
      market,
      yesTokenId: yesTokenIdNorm,
      yesAsk,
      carry_roi_pct: roi_apr_pct,
      carry_roi_raw_pct: roi_raw_pct,
      spread,
      askLiquidityUsd,
      time_to_resolution_days: days,
      assumption_key: carryAssumptionKey(market),
      window_key: carryWindowKey(days),
      yesBid: top_noBid,
      spreadObservable,
      edge_abs: edgeAbs,
      spread_edge_ratio,
      price_source,
      ...(end_time_iso != null && { end_time_iso }),
      ...(httpFallbackUsed && { http_fallback_used: true }),
      ...(synthetic_ask && {
        synthetic_ask: true,
        synthetic_ask_price,
        synthetic_reason,
        top_noBid,
        top_noAsk,
      }),
    });
  }

  const computeRoiStats = (arr: number[]): CarryRoiStatsPreBand | null => {
    if (arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const n = sorted.length;
    const ix = (p: number) => Math.min(Math.floor((p / 100) * (n - 1)), n - 1);
    return {
      count: n,
      min: sorted[0]!,
      p10: sorted[ix(10)]!,
      p50: sorted[ix(50)]!,
      p90: sorted[ix(90)]!,
      max: sorted[n - 1]!,
    };
  };
  const carry_roi_stats_pre_band = computeRoiStats(roi_apr_pre_band);
  const carry_roi_raw_stats_pre_band = computeRoiStats(roi_raw_pre_band);
  return {
    candidates: out,
    carryDebug,
    carrySamples,
    carry_roi_stats_pre_band,
    carry_roi_raw_stats_pre_band,
    sampleNoBookTokenIds,
  };
}
