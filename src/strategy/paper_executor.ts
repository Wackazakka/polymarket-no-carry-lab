import type { OrderLevel, PaperPosition } from "../types";

export interface SimulationConfig {
  default_order_size_usd: number;
  slippage_bps: number;
  max_fill_depth_levels: number;
}

export interface TradeProposal {
  marketId: string;
  conditionId: string;
  noTokenId: string;
  side: "NO";
  sizeUsd: number;
  bestAsk: number;
  category: string | null;
  assumptionGroup: string | null;
  resolutionWindowBucket: string | null;
  assumptionKey: string;
  windowKey: string;
}

export interface FillResult {
  filled: boolean;
  fillSizeUsd: number;
  fillSizeShares: number;
  entryPriceVwap: number;
  reason: string;
}

/**
 * Propose "buy NO" at best ask with slippage. Simulate fill across depth.
 * Conservative: partial fill or reject if not enough liquidity.
 */
export function simulateFill(
  proposal: TradeProposal,
  noAskLevels: OrderLevel[],
  config: SimulationConfig
): FillResult {
  const slippage = config.slippage_bps / 10000;
  const maxLevels = config.max_fill_depth_levels;
  const targetUsd = proposal.sizeUsd;
  const effectivePriceCap = proposal.bestAsk * (1 + slippage);

  let remainingUsd = targetUsd;
  let costUsd = 0;
  let sharesFilled = 0;
  const levelsUsed = noAskLevels.slice(0, maxLevels);

  for (const level of levelsUsed) {
    if (remainingUsd <= 0) break;
    if (level.price > effectivePriceCap) break;
    const availableUsd = level.price * level.size;
    const takeUsd = Math.min(remainingUsd, availableUsd);
    const takeShares = takeUsd / level.price;
    costUsd += takeUsd;
    sharesFilled += takeShares;
    remainingUsd -= takeUsd;
  }

  if (sharesFilled <= 0) {
    return {
      filled: false,
      fillSizeUsd: 0,
      fillSizeShares: 0,
      entryPriceVwap: 0,
      reason: "no liquidity within slippage or depth",
    };
  }

  const fillSizeUsd = costUsd;
  const entryPriceVwap = fillSizeUsd / sharesFilled;
  const partial = remainingUsd > 0;
  return {
    filled: true,
    fillSizeUsd,
    fillSizeShares: sharesFilled,
    entryPriceVwap,
    reason: partial ? "partial fill (insufficient depth)" : "full fill",
  };
}

/**
 * Build a paper position from a filled trade. Expected PnL: (1 - entryPrice) * shares - tail cost (handled in EV).
 * We store expected PnL as (1 - entryPrice) * shares for "if NO wins" outcome; reporting can subtract tail.
 */
export function openPaperPosition(
  proposal: TradeProposal,
  fill: FillResult,
  id: string
): PaperPosition {
  if (!fill.filled) throw new Error("Cannot open position without fill");
  const expectedPnl = (1 - fill.entryPriceVwap) * fill.fillSizeShares;
  return {
    id,
    marketId: proposal.marketId,
    conditionId: proposal.conditionId,
    side: "NO",
    entryPrice: fill.entryPriceVwap,
    sizeUsd: fill.fillSizeUsd,
    sizeShares: fill.fillSizeShares,
    category: proposal.category,
    assumptionGroup: proposal.assumptionGroup,
    resolutionWindowBucket: proposal.resolutionWindowBucket,
    assumptionKey: proposal.assumptionKey ?? null,
    windowKey: proposal.windowKey ?? null,
    openedAt: new Date().toISOString(),
    closedAt: null,
    expectedPnl,
  };
}

/**
 * Compute expected PnL for a position (deterministic). Label clearly as expected, not realized.
 */
export function getExpectedPnl(position: PaperPosition): number {
  if (position.closedAt) return position.expectedPnl ?? 0;
  return (1 - position.entryPrice) * position.sizeShares;
}
