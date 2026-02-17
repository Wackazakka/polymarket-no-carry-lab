import type { NormalizedMarket, EVResult, FilterResult } from "../types";

export interface EVConfig {
  fee_bps: number;
  p_tail: number;
  tail_loss_fraction: number;
  ambiguous_resolution_p_tail_multiplier: number;
  ev_mode?: "baseline" | "capture";
}

/**
 * Conservative EV for buying NO near 1.00.
 * - Gross: (1 - entryPrice) * probability NO wins (we assume market-implied from price).
 * - Fees: fee_bps applied to notional.
 * - Tail: p_tail * tail_loss_fraction * position value. If RESOLUTION_AMBIGUOUS, p_tail is multiplied.
 */
export function computeEV(
  market: NormalizedMarket,
  entryPrice: number,
  sizeUsd: number,
  config: EVConfig,
  filterResult: FilterResult
): EVResult {
  const explanation: string[] = [];
  const assumptions: Record<string, unknown> = {};

  const impliedYes = entryPrice;
  const impliedNo = 1 - entryPrice;
  assumptions.implied_no = impliedNo;
  assumptions.entry_price = entryPrice;
  assumptions.size_usd = sizeUsd;

  const shares = sizeUsd / entryPrice;
  const maxWin = (1 - entryPrice) * shares;
  const grossEv = impliedNo * maxWin;
  assumptions.gross_ev = grossEv;

  const feeBps = config.fee_bps / 10000;
  const feesEstimate = sizeUsd * feeBps;
  assumptions.fees_bps = config.fee_bps;
  explanation.push(`Fees: ${config.fee_bps} bps on ${sizeUsd} USD = ${feesEstimate.toFixed(4)} USD`);

  let tailRiskCost: number;
  const evMode = config.ev_mode ?? "baseline";
  if (evMode === "capture") {
    tailRiskCost = 0;
    assumptions.tailByp = "Y";
    assumptions.tail_bypass_reason = "capture_mode";
    assumptions.tail_risk_cost = 0;
    explanation.push("Tail bypass: ev_mode=capture => tailRiskCost=0");
  } else {
    let pTail = config.p_tail;
    if (filterResult.flags.includes("RESOLUTION_AMBIGUOUS")) {
      pTail *= config.ambiguous_resolution_p_tail_multiplier;
      assumptions.p_tail_effective = pTail;
      explanation.push(`Tail probability increased for ambiguous resolution: ${pTail.toFixed(4)}`);
    }
    const positionValue = shares * 1;
    tailRiskCost = pTail * config.tail_loss_fraction * positionValue;
    assumptions.tail_risk_cost = tailRiskCost;
    explanation.push(`Tail risk: p_tail=${pTail}, loss fraction=${config.tail_loss_fraction} => ${tailRiskCost.toFixed(4)} USD`);
  }

  const netEv = grossEv - feesEstimate - tailRiskCost;
  assumptions.net_ev = netEv;

  return {
    gross_ev: grossEv,
    fees_estimate: feesEstimate,
    tail_risk_cost: tailRiskCost,
    net_ev: netEv,
    assumptions,
    explanation,
    ...(evMode === "capture" && { tailByp: "Y", tail_bypass_reason: "capture_mode" }),
  };
}
