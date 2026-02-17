/**
 * Shared types for the NO-Carry Lab (read-only, paper only).
 */

export interface NormalizedMarket {
  marketId: string;
  conditionId: string;
  question: string;
  title: string;
  outcomes: string[];
  resolutionTime: Date | null;
  endDateIso: string | null;
  category: string | null;
  description: string | null;
  rulesText: string | null;
  /** Token ID for NO outcome (for CLOB orderbook). */
  noTokenId: string | null;
  /** Token ID for YES outcome. */
  yesTokenId: string | null;
  liquidityNum: number | null;
  closed: boolean;
}

export interface OrderLevel {
  price: number;
  size: number;
}

export interface TopOfBook {
  noBid: number | null;
  noAsk: number | null;
  spread: number | null;
  depthSummary: { bidLiquidityUsd: number; askLiquidityUsd: number; levels: number };
}

export interface FilterResult {
  pass: boolean;
  reasons: string[];
  flags: string[];
}

export interface EVResult {
  gross_ev: number;
  fees_estimate: number;
  tail_risk_cost: number;
  net_ev: number;
  assumptions: Record<string, unknown>;
  explanation: string[];
  /** "Y" when tail was bypassed (e.g. capture mode). */
  tailByp?: string;
  /** Reason for bypass, e.g. "capture_mode". */
  tail_bypass_reason?: string;
}

export interface PaperPosition {
  id: string;
  marketId: string;
  conditionId: string;
  side: "NO";
  entryPrice: number;
  sizeUsd: number;
  sizeShares: number;
  category: string | null;
  assumptionGroup: string | null;
  resolutionWindowBucket: string | null;
  openedAt: string;
  closedAt: string | null;
  expectedPnl: number | null;
}

export interface LedgerEntry {
  id?: number;
  timestamp: string;
  action: "scan_pass" | "scan_fail" | "trade_blocked" | "trade_opened" | "trade_closed";
  marketId: string;
  metadata: Record<string, unknown>;
}

export type ResolutionWindowId = string;
