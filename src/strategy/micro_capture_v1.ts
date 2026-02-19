/**
 * micro_capture_v1 preset: NO outcome, capture-style, short hold.
 * Paper-only trade suggestions. No end_time/resolution, no carry.
 * Gates on ask premium vs mid; optional ask/bid size imbalance.
 */

import type { NormalizedMarket, TopOfBook } from "../types";

export const PRESET_NAME = "micro_capture_v1" as const;

const EPS = 1e-9;

export interface MicroCaptureV1Preset {
  /** outcome */
  outcome: "NO";
  /** ev_mode */
  ev_mode: "capture";
  /** Minimum spread (e.g. 0.04) to consider. */
  minSpread: number;
  /** Minimum ask premium vs mid in %. askPremiumPct = ((noAsk - mid) / mid) * 100. */
  minAskMidPremiumPct: number;
  /** Optional: require (askLiquidityUsd / max(bidLiquidityUsd, eps)) >= this. Skipped if book has no sizes. */
  minAskBidImbalanceRatio?: number;
  /** Take-profit in % (e.g. 3). Exit when NO price drops by this much. */
  take_profit_pct: number;
  /** Stop-loss in % (e.g. 2). Exit when NO price rises by this much. */
  stop_loss_pct: number;
  /** Max hold time in minutes (e.g. 180). */
  max_hold_minutes: number;
}

export const DEFAULT_MICRO_CAPTURE_V1: MicroCaptureV1Preset = {
  outcome: "NO",
  ev_mode: "capture",
  minSpread: 0.04,
  minAskMidPremiumPct: 1.5,
  take_profit_pct: 3,
  stop_loss_pct: 2,
  max_hold_minutes: 180,
};

export interface MicroCaptureV1Result {
  pass: boolean;
  /** Entry price = best ask (NO). */
  entry?: number;
  /** Proposed exit price when taking profit (NO price target). */
  takeProfitPrice?: number;
  /** Proposed exit price when stopping loss. */
  stopLossPrice?: number;
  maxHoldMinutes?: number;
  /** For ev_breakdown. */
  no_bid?: number | null;
  no_ask?: number;
  mid?: number;
  ask_premium_pct?: number;
  spread?: number | null;
  rationale: string[];
}

/**
 * Evaluate one market for micro_capture_v1.
 * Does not use end_time, resolution, or carry. Entry = best_ask.
 * Gates on askPremiumPct = ((noAsk - mid) / mid) * 100 >= minAskMidPremiumPct.
 * Optional: (askLiquidityUsd / max(bidLiquidityUsd, eps)) >= minAskBidImbalanceRatio when preset and book provide sizes.
 */
export function evaluateMicroCaptureV1(
  market: NormalizedMarket,
  book: TopOfBook | null,
  preset: MicroCaptureV1Preset
): MicroCaptureV1Result {
  const rationale: string[] = [];
  if (market.closed) {
    rationale.push("market closed");
    return { pass: false, rationale };
  }
  if (!market.noTokenId) {
    rationale.push("no NO token");
    return { pass: false, rationale };
  }
  const noAsk = book?.noAsk ?? null;
  const noBid = book?.noBid ?? null;
  if (noAsk == null || book == null) {
    rationale.push("no NO ask (missing book)");
    return { pass: false, rationale };
  }
  const entry = noAsk;
  const spread = book.spread ?? null;
  if (spread == null || spread < preset.minSpread) {
    rationale.push(`spread ${spread ?? "null"} < minSpread ${preset.minSpread}`);
    return { pass: false, rationale };
  }
  const mid = noBid != null ? (noBid + noAsk) / 2 : noAsk;
  const askPremiumPct = mid > 0 ? ((noAsk - mid) / mid) * 100 : 0;
  if (askPremiumPct < preset.minAskMidPremiumPct) {
    rationale.push(
      `ask_premium_pct ${askPremiumPct.toFixed(2)}% < minAskMidPremiumPct ${preset.minAskMidPremiumPct}`
    );
    return { pass: false, rationale };
  }
  if (preset.minAskBidImbalanceRatio != null && preset.minAskBidImbalanceRatio > 0) {
    const ds = book.depthSummary;
    const askLiq = ds?.askLiquidityUsd ?? 0;
    const bidLiq = ds?.bidLiquidityUsd ?? 0;
    if (typeof askLiq === "number" && typeof bidLiq === "number") {
      const ratio = askLiq / Math.max(bidLiq, EPS);
      if (ratio < preset.minAskBidImbalanceRatio) {
        rationale.push(
          `ask/bid liquidity ratio ${ratio.toFixed(2)} < minAskBidImbalanceRatio ${preset.minAskBidImbalanceRatio}`
        );
        return { pass: false, rationale };
      }
    }
  }
  const takeProfitPrice = entry * (1 - preset.take_profit_pct / 100);
  const stopLossPrice = entry * (1 + preset.stop_loss_pct / 100);
  rationale.push(
    `entry=best_ask=${entry.toFixed(4)}`,
    `take_profit=${preset.take_profit_pct}% -> exit_at=${takeProfitPrice.toFixed(4)}`,
    `stop_loss=${preset.stop_loss_pct}% -> exit_at=${stopLossPrice.toFixed(4)}`,
    `max_hold=${preset.max_hold_minutes}min`,
    `spread=${spread.toFixed(4)}>=${preset.minSpread} mid=${mid.toFixed(4)} ask_premium_pct=${askPremiumPct.toFixed(2)}%>=${preset.minAskMidPremiumPct}%`
  );
  return {
    pass: true,
    entry,
    takeProfitPrice,
    stopLossPrice,
    maxHoldMinutes: preset.max_hold_minutes,
    no_bid: noBid,
    no_ask: noAsk,
    mid,
    ask_premium_pct: askPremiumPct,
    spread,
    rationale,
  };
}
