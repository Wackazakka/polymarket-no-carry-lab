/**
 * micro_capture_v1 preset: NO outcome, capture-style, short hold.
 * Paper-only trade suggestions. No end_time/resolution, no carry.
 * Logs entry, proposed exit (TP/SL), and rationale.
 */

import type { NormalizedMarket, TopOfBook } from "../types";

export const PRESET_NAME = "micro_capture_v1" as const;

export interface MicroCaptureV1Preset {
  /** outcome */
  outcome: "NO";
  /** ev_mode */
  ev_mode: "capture";
  /** Minimum spread (e.g. 0.04) to consider. */
  minSpread: number;
  /** Minimum drift/edge in % (e.g. 1.5). Edge = (1 - noAsk)*100. */
  minDriftPct: number;
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
  minDriftPct: 1.5,
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
  rationale: string[];
}

/**
 * Evaluate one market for micro_capture_v1.
 * Does not use end_time, resolution, or carry. Entry = best_ask.
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
  const entry = book?.noAsk ?? null;
  if (entry == null || book == null) {
    rationale.push("no NO ask (missing book)");
    return { pass: false, rationale };
  }
  const spread = book.spread ?? null;
  if (spread == null || spread < preset.minSpread) {
    rationale.push(`spread ${spread ?? "null"} < minSpread ${preset.minSpread}`);
    return { pass: false, rationale };
  }
  const edgePct = (1 - entry) * 100;
  if (edgePct < preset.minDriftPct) {
    rationale.push(`edge ${edgePct.toFixed(2)}% < minDriftPct ${preset.minDriftPct}`);
    return { pass: false, rationale };
  }
  const takeProfitPrice = entry * (1 - preset.take_profit_pct / 100);
  const stopLossPrice = entry * (1 + preset.stop_loss_pct / 100);
  rationale.push(
    `entry=best_ask=${entry.toFixed(4)}`,
    `take_profit=${preset.take_profit_pct}% -> exit_at=${takeProfitPrice.toFixed(4)}`,
    `stop_loss=${preset.stop_loss_pct}% -> exit_at=${stopLossPrice.toFixed(4)}`,
    `max_hold=${preset.max_hold_minutes}min`,
    `spread=${spread.toFixed(4)}>=${preset.minSpread} edge=${edgePct.toFixed(2)}%>=${preset.minDriftPct}%`
  );
  return {
    pass: true,
    entry,
    takeProfitPrice,
    stopLossPrice,
    maxHoldMinutes: preset.max_hold_minutes,
    rationale,
  };
}
