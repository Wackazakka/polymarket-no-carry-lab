/**
 * Polymarket NO-Carry Lab v0.2 — Read-only, paper-trading simulator.
 * No private keys, no wallets, no signing, no order placement.
 */

import { loadConfig, getConfigPath } from "./config/load_config";
import { enforceNoLiveTrading } from "./safety/ban_live_trading";
import { fetchActiveMarkets } from "./market_fetcher";
import {
  getTopOfBook,
  getDepth,
  startOrderbookStream,
  fetchOrderbookSnapshot,
  normalizeBookKey,
  getBooksDebug,
} from "./markets/orderbook_ws";
import {
  evaluateMarketCandidate,
  evaluateMarketCandidateWithDetails,
  computeEV,
  type FailedCheck,
} from "./opportunity_detector";
import {
  simulateFill,
  openPaperPosition,
  type TradeProposal,
  type FillResult,
} from "./execution";
import { computeAssumptionKey, computeWindowKey } from "./assumption/keys";
import {
  allowTrade,
  buildRiskStateFromPositions,
  inferCategory,
  inferAssumptionGroup,
  computeResolutionWindowBucket,
  type TradeProposalForRisk,
  type AllowTradeResult,
} from "./risk/risk_engine";
import { selectCarryCandidates } from "./strategy/carry_yes";
import { initStore } from "./state/store";
import { initPositionsDb, listPositions, insertPosition } from "./state/positions";
import { initLedgerDb, appendLedger } from "./state/ledger";
import { generateReport, writeReportToFile, type ReportInput } from "./audit";
import type { NormalizedMarket, TradePlan } from "./types";
import { randomUUID, createHash } from "crypto";
import {
  getMode,
  isPanic,
  isConfirmMode,
  isAutoExecute,
  setModeChangeCallback,
  panicStop,
  getModeState,
  getConfirmGateRejection,
} from "./ops/mode_manager";
import {
  enqueuePlan,
  getPlan,
  markPlanExecuted,
  isPlanExecuted,
  clearQueue,
  queueLength,
} from "./ops/plan_queue";
import { createControlApi } from "./ops/control_api";
import type { ConfirmResult } from "./ops/control_api";
import { setPlans, getPlans } from "./control/plan_store";

const TZ_OSLO = "Europe/Oslo";

function nowInOsloHour(): number {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ_OSLO,
    hour: "numeric",
    hour12: false,
  });
  return parseInt(formatter.format(new Date()), 10);
}

function shouldRunDailyReport(config: { reporting: { daily_report_hour_local: number } }): boolean {
  return nowInOsloHour() === config.reporting.daily_report_hour_local;
}

/** Effective carry config (defaults applied) for logging and /status. */
function effectiveCarryCfg(config: { carry?: { enabled?: boolean; roiMinPct?: number; roiMaxPct?: number; maxSpread?: number; maxDays?: number; minDaysToResolution?: number; spreadEdgeMaxRatio?: number; spreadEdgeMinAbs?: number; allowSyntheticAsk?: boolean; allowHttpFallback?: boolean } | null }): Record<string, unknown> {
  const c = config.carry ?? { enabled: false };
  return {
    enabled: c.enabled ?? true,
    roiMinPct: c.roiMinPct ?? 6,
    roiMaxPct: c.roiMaxPct ?? 7,
    maxSpread: c.maxSpread ?? 0.02,
    maxDays: c.maxDays ?? 30,
    minDaysToResolution: c.minDaysToResolution ?? 2,
    spreadEdgeMaxRatio: c.spreadEdgeMaxRatio ?? 2.0,
    spreadEdgeMinAbs: c.spreadEdgeMinAbs ?? 0.0,
    allowSyntheticAsk: c.allowSyntheticAsk ?? false,
    allowHttpFallback: c.allowHttpFallback ?? true,
  };
}

/** Strip to digits only; for API payload (e.g. no_token_id in /plans). */
function normalizeTokenId(x: unknown): string {
  if (typeof x !== "string") return "";
  return x.replace(/[^0-9]/g, "");
}

/** Stable plan identity for upsert: same market + token + outcome => same plan_id. */
function stablePlanId(marketId: string, tokenId: string, outcome: "NO" | "YES"): string {
  const normalized = normalizeTokenId(tokenId) || String(tokenId).trim();
  const key = `${marketId}|${normalized}|${outcome}`;
  return createHash("sha1").update(key, "utf8").digest("hex");
}

/** Plan id by market + outcome + ev_breakdown.mode so capture and carry never collide. */
function planIdFromMode(marketId: string, outcome: "NO" | "YES", mode: string): string {
  return createHash("sha1").update(`${marketId}:${outcome}:${mode}`, "utf8").digest("hex");
}

function main(): void {
  const config = loadConfig();
  console.log("[config] loaded from", getConfigPath());
  console.log("[carry cfg]", JSON.stringify(effectiveCarryCfg(config)));
  enforceNoLiveTrading(config);

  const dataDir = initStore(config);
  initPositionsDb(dataDir);
  initLedgerDb(dataDir);

  setModeChangeCallback((state, previous) => {
    appendLedger(dataDir, {
      timestamp: new Date().toISOString(),
      action: "mode_change",
      marketId: "",
      metadata: { mode: state.mode, panic: state.panic, previousMode: previous.mode, previousPanic: previous.panic },
    });
  });

  const reportIntervalMs = config.reporting.report_interval_minutes * 60 * 1000;
  let lastDailyReportHour: number | null = null;
  let lastReportTime = 0;
  const blockReasonsCount: Record<string, number> = {};
  let candidatesScanned = 0;
  let candidatesPassedFilters = 0;
  let tradesProposed = 0;
  let tradesBlockedByRisk = 0;
  const topCandidatesByNetEv: ReportInput["topCandidatesByNetEv"] = [];
  const worstCandidates: ReportInput["worstCandidates"] = [];

  function tickReport(): void {
    const positions = listPositions(dataDir, true);
    const riskState = buildRiskStateFromPositions(positions);
    const input: ReportInput = {
      candidatesScanned,
      candidatesPassedFilters,
      tradesProposed,
      tradesBlockedByRisk,
      blockReasons: { ...blockReasonsCount },
      positions,
      riskState,
      topCandidatesByNetEv: [...topCandidatesByNetEv].sort((a, b) => (b.net_ev ?? 0) - (a.net_ev ?? 0)).slice(0, config.reporting.print_top_n),
      worstCandidates: [...worstCandidates].slice(0, config.reporting.print_top_n),
    };
    const result = generateReport(input, config);
    console.log(result.text);
    const path = writeReportToFile(result, config);
    console.log(`[report] Written to ${path}`);
  }

  function maybeReport(): void {
    const now = Date.now();
    const runInterval = now - lastReportTime >= reportIntervalMs;
    const hour = nowInOsloHour();
    const runDaily = shouldRunDailyReport(config) && lastDailyReportHour !== hour;
    if (runInterval || runDaily) {
      lastReportTime = now;
      if (runDaily) lastDailyReportHour = hour;
      tickReport();
    }
  }

  let orderbookStop: { stop: () => void } | null = null;
  let scanTimer: ReturnType<typeof setInterval> | null = null;

  async function runScan(): Promise<void> {
    console.log(`[scan] Polling markets at ${new Date().toISOString()}`);
    console.log("\n================ SCAN START ================");
    const markets = await fetchActiveMarkets(config.api.gammaBaseUrl, {
      limit: 100,
      maxPages: 3,
    }).catch((e) => {
      console.warn("[scan] Fetch markets failed:", e.message);
      return [];
    });

    if (markets.length === 0) {
      console.log("[scan] No markets (or fetch failed). Skipping.");
      return;
    }

    const withNoToken = markets.filter((m) => m.noTokenId);
    const withYesToken = markets.filter((m) => m.yesTokenId);
    const subscribedCap = config.ws?.max_assets_subscribed ?? 200;
    const noIds = withNoToken.map((m) => normalizeBookKey(m.noTokenId!)).filter((k) => k.length >= 10);
    const yesIds = withYesToken.map((m) => normalizeBookKey(m.yesTokenId!)).filter((k) => k.length >= 10);
    const tokenIds = [...new Set([...noIds, ...yesIds])].slice(0, subscribedCap);
    await fetchOrderbookSnapshot(config.api.clobRestBaseUrl, tokenIds);

    const tokenToMarket = new Map<string, NormalizedMarket>();
    for (const m of withNoToken) {
      if (m.noTokenId) tokenToMarket.set(normalizeBookKey(m.noTokenId), m);
    }
    for (const m of withYesToken) {
      if (m.yesTokenId) tokenToMarket.set(normalizeBookKey(m.yesTokenId), m);
    }

    candidatesScanned += markets.length;
    const now = new Date();
    const selection = config.selection;
    const diagnosticLoose = Boolean(config.diagnostic_loose_filters);
    const evMode = config.fees.ev_mode ?? "baseline";
    const filterConfig = diagnosticLoose
      ? {
          min_no_price: 0.8,
          max_spread: 0.05,
          min_liquidity_usd: 100,
          max_time_to_resolution_hours: selection.max_time_to_resolution_hours * 1.5,
          ev_mode: evMode,
          capture_min_no_ask: selection.capture_min_no_ask,
          capture_max_no_ask: selection.capture_max_no_ask,
        }
      : {
          min_no_price: selection.min_no_price,
          max_spread: selection.max_spread,
          min_liquidity_usd: selection.min_liquidity_usd,
          max_time_to_resolution_hours: selection.max_time_to_resolution_hours,
          ev_mode: evMode,
          capture_min_no_ask: selection.capture_min_no_ask,
          capture_max_no_ask: selection.capture_max_no_ask,
        };
    const noAskDesc = evMode === "capture"
      ? `capture band [${filterConfig.capture_min_no_ask}, ${filterConfig.capture_max_no_ask}]`
      : `min_no_price=${filterConfig.min_no_price}`;
    console.log("[scan] ev_mode=" + evMode + " NO-ask threshold: " + noAskDesc);
    console.log("[carry cfg]", JSON.stringify(effectiveCarryCfg(config)));
    if (diagnosticLoose) {
      console.log("[diagnostic] Loose filters: " + noAskDesc + " max_spread=0.05 min_liquidity_usd=100 max_time_to_resolution_hours=" + filterConfig.max_time_to_resolution_hours);
    }

    const passed: Array<{ market: NormalizedMarket; book: ReturnType<typeof getTopOfBook>; filterResult: ReturnType<typeof evaluateMarketCandidate> }> = [];
    const failedWithDetails: Array<{ market: NormalizedMarket; failedChecks: FailedCheck[] }> = [];
    let missingOrderbookCount = 0;
    let evaluatedWithBookCount = 0;
    const totalCandidates = withNoToken.length;
    const booksDebug = getBooksDebug();
    const warmupSkip = booksDebug.size < 5;

    for (let i = 0; i < withNoToken.length; i++) {
      const market = withNoToken[i];
      if (!market.noTokenId) continue;
      const lookupKey = normalizeBookKey(market.noTokenId);
      const hasKey = booksDebug.hasKey(market.noTokenId);
      if (i < 5) {
        console.log(
          "[scan] candidate",
          i + 1,
          "marketId=" + market.marketId,
          "conditionId=" + market.conditionId,
          "yesTokenId=" + (market.yesTokenId ?? ""),
          "noTokenId=" + market.noTokenId,
          "lookupKey=" + lookupKey,
          "bookMap.has=" + hasKey,
          "sampleKeys=" + JSON.stringify(booksDebug.sampleKeys)
        );
      }
      if (warmupSkip) continue;
      const book = getTopOfBook(market.noTokenId, config.simulation.max_fill_depth_levels);
      const hasValidBook = book != null && book.noAsk != null && book.noBid != null;
      if (hasValidBook) evaluatedWithBookCount++;
      else missingOrderbookCount++;

      if (diagnosticLoose) {
        const result = evaluateMarketCandidateWithDetails(market, book, now, filterConfig);
        if (result.pass) {
          candidatesPassedFilters++;
          passed.push({ market, book, filterResult: result });
        } else {
          if (hasValidBook) failedWithDetails.push({ market, failedChecks: result.failedChecks });
          appendLedger(dataDir, {
            timestamp: now.toISOString(),
            action: "scan_fail",
            marketId: market.marketId,
            metadata: { reasons: result.reasons },
          });
        }
      } else {
        const filterResult = evaluateMarketCandidate(market, book, now, filterConfig);
        if (filterResult.pass) {
          candidatesPassedFilters++;
          passed.push({ market, book, filterResult });
        } else {
          appendLedger(dataDir, {
            timestamp: now.toISOString(),
            action: "scan_fail",
            marketId: market.marketId,
            metadata: { reasons: filterResult.reasons },
          });
        }
      }
    }

    if (diagnosticLoose) {
      console.log("[diagnostic] orderbook coverage: evaluatedWithBook=" + evaluatedWithBookCount + " missingOrderbook=" + missingOrderbookCount + " totalCandidates=" + totalCandidates + " subscribedTokens=" + tokenIds.length);
    }

    if (diagnosticLoose && failedWithDetails.length > 0) {
      const nearMisses = failedWithDetails.filter((f) => f.failedChecks.length === 1).slice(0, 10);
      console.log("[diagnostic] Near misses (failed by only one filter), top 10:");
      for (const { market, failedChecks } of nearMisses) {
        const fc = failedChecks[0];
        const byHowMuch = fc.threshold !== 0 ? ` (e.g. ${fc.check}=${fc.value} > ${fc.threshold})` : "";
        console.log("[diagnostic]   " + market.marketId.slice(0, 24) + "… " + fc.check + ": " + fc.message + byHowMuch);
      }
      if (nearMisses.length === 0) {
        console.log("[diagnostic]   (none — all failures had more than one filter)");
      }
    }

    const positions = listPositions(dataDir, true);
    let riskState = buildRiskStateFromPositions(positions);
    const nowTs = Date.now();
    const scanTsIso = new Date(nowTs).toISOString();

    /** Phase 1: build the single proposed-plans array (same length as "Trades proposed", same items as ops loop). */
    const proposedPlans: Array<{
      planId: string;
      createdAt: string;
      planPayload: Omit<TradePlan, "plan_id" | "created_at" | "status">;
      market: NormalizedMarket;
      proposal: TradeProposal;
      effectiveFill: FillResult;
      allow: AllowTradeResult;
      evResult: { net_ev: number; tail_risk_cost?: number; tailByp?: string; tail_bypass_reason?: string };
      category: string | null;
      assumptionKey: string;
      windowKey: string;
      sizeToOpen: number;
    }> = [];

    for (const { market, book, filterResult } of passed) {
      const entryPrice = book!.noAsk!;
      const sizeUsd = config.simulation.default_order_size_usd;
      const evResult = computeEV(market, entryPrice, sizeUsd, config.fees, filterResult);
      if (evResult.net_ev <= 0) {
        worstCandidates.push({
          marketId: market.marketId,
          question: market.question,
          net_ev: evResult.net_ev,
          reason: "negative_ev",
        });
        appendLedger(dataDir, {
          timestamp: new Date().toISOString(),
          action: "scan_pass",
          marketId: market.marketId,
          metadata: { ev_negative: true, net_ev: evResult.net_ev, tail_risk_cost: evResult.tail_risk_cost, tailByp: evResult.tailByp, tail_bypass_reason: evResult.tail_bypass_reason },
        });
        continue;
      }

      const category = inferCategory(market);
      const assumptionGroup = inferAssumptionGroup(market);
      const resolutionWindowBucket = computeResolutionWindowBucket(market.resolutionTime, config);
      const assumptionKey = computeAssumptionKey(market, config.fees.ev_mode, nowTs);
      const windowKey = computeWindowKey(market, nowTs);

      const proposal: TradeProposal = {
        marketId: market.marketId,
        conditionId: market.conditionId,
        noTokenId: market.noTokenId!,
        side: "NO",
        sizeUsd,
        bestAsk: entryPrice,
        category,
        assumptionGroup,
        resolutionWindowBucket,
        assumptionKey,
        windowKey,
      };

      const depth = getDepth(market.noTokenId);
      const fill = simulateFill(proposal, depth, config.simulation);
      if (!fill.filled) {
        worstCandidates.push({
          marketId: market.marketId,
          question: market.question,
          reason: `no_fill: ${fill.reason}`,
        });
        console.log(`[scan] ${market.marketId} no fill: ${fill.reason}`);
        continue;
      }

      const riskProposal: TradeProposalForRisk = {
        marketId: proposal.marketId,
        conditionId: proposal.conditionId,
        sizeUsd: fill.fillSizeUsd,
        category,
        assumptionGroup,
        resolutionWindowBucket,
        assumptionKey,
        windowKey,
      };
      const allow = allowTrade(riskProposal, riskState, config);
      if (allow.decision === "BLOCK") {
        tradesBlockedByRisk++;
        for (const b of allow.reasons) {
          blockReasonsCount[b] = (blockReasonsCount[b] ?? 0) + 1;
        }
        appendLedger(dataDir, {
          timestamp: new Date().toISOString(),
          action: "trade_blocked",
          marketId: market.marketId,
          metadata: { blocks: allow.reasons, proposal: riskProposal },
        });
        console.log(`[risk] BLOCKED ${market.marketId}: ${allow.reasons.join("; ")}`);
        continue;
      }

      const sizeToOpen =
        allow.decision === "ALLOW_REDUCED_SIZE" && allow.suggested_size != null
          ? allow.suggested_size
          : fill.fillSizeUsd;
      const effectiveFill =
        sizeToOpen < fill.fillSizeUsd
          ? {
              ...fill,
              fillSizeUsd: sizeToOpen,
              fillSizeShares: sizeToOpen / fill.entryPriceVwap,
            }
          : fill;

      const planId = planIdFromMode(market.marketId, "NO", evMode);
      const planPayload: Omit<TradePlan, "plan_id" | "created_at" | "status"> = {
        market_id: market.marketId,
        condition_id: market.conditionId,
        no_token_id: market.noTokenId!,
        outcome: "NO",
        sizeUsd: sizeToOpen,
        limit_price: entryPrice,
        category,
        assumption_key: assumptionKey,
        window_key: windowKey,
        ev_breakdown: {
          mode: evMode,
          net_ev: evResult.net_ev,
          tail_risk_cost: evResult.tail_risk_cost,
          tailByp: evResult.tailByp,
          tail_bypass_reason: evResult.tail_bypass_reason,
        },
        headroom: allow.headroom,
      };
      const createdAt = new Date().toISOString();
      proposedPlans.push({
        planId,
        createdAt,
        planPayload,
        market,
        proposal,
        effectiveFill,
        allow,
        evResult,
        category,
        assumptionKey,
        windowKey,
        sizeToOpen,
      });
    }

    /** Report count = length of the real proposed array. */
    tradesProposed = proposedPlans.length;
    /** 1:1 JSON-safe copy for plan_store (same length as proposedPlans). created_at/updated_at set by store on upsert. */
    let plansForApi = proposedPlans.map((p) => ({
      plan_id: p.planId,
      ...p.planPayload,
      no_token_id: normalizeTokenId(p.planPayload.no_token_id),
      status: "proposed" as const,
    }));

    /** Carry (YES) plans: same store shape, outcome YES, no_token_id = yes token. */
    const carryConfig = config.carry ?? { enabled: false };
    const carryCfgForMeta = effectiveCarryCfg(config);
    let carryMeta: Record<string, unknown> = { carry_cfg: carryCfgForMeta };
    if (carryConfig.enabled) {
      const { candidates: carryCandidates, carryDebug, sampleNoBookTokenIds } = await selectCarryCandidates(
        markets,
        (tid) => getTopOfBook(tid, config.simulation.max_fill_depth_levels),
        {
          enabled: true,
          maxDays: carryConfig.maxDays ?? 30,
          minDaysToResolution: carryConfig.minDaysToResolution ?? 2,
          roiMinPct: carryConfig.roiMinPct ?? 6,
          roiMaxPct: carryConfig.roiMaxPct ?? 7,
          maxSpread: carryConfig.maxSpread ?? 0.02,
          minAskLiqUsd: carryConfig.minAskLiqUsd ?? 500,
          sizeUsd: carryConfig.sizeUsd,
          bankroll_fraction: carryConfig.bankroll_fraction,
          allowCategories: carryConfig.allowCategories ?? [],
          allowKeywords: carryConfig.allowKeywords ?? [],
          allowSyntheticAsk: carryConfig.allowSyntheticAsk ?? false,
          syntheticTick: carryConfig.syntheticTick ?? 0.01,
          syntheticMaxAsk: carryConfig.syntheticMaxAsk ?? 0.995,
          allowHttpFallback: carryConfig.allowHttpFallback ?? true,
          clobHttpBaseUrl: config.api.clobRestBaseUrl,
          spreadEdgeMaxRatio: carryConfig.spreadEdgeMaxRatio ?? 2.0,
          spreadEdgeMinAbs: carryConfig.spreadEdgeMinAbs ?? 0.0,
        },
        now
      );
      carryMeta = { carry_cfg: carryCfgForMeta, carry_debug: carryDebug };
      console.log(
        "[carry]",
        "passed=" + carryDebug.passed,
        "synthetic_used=" + carryDebug.synthetic_used,
        "synthetic_rejected_no_bid=" + carryDebug.synthetic_rejected_no_bid,
        "synthetic_time_used=" + carryDebug.synthetic_time_used,
        "synthetic_time_rejected=" + carryDebug.synthetic_time_rejected,
        "missing_yes=" + carryDebug.missing_yes_token_id,
        "no_end_time=" + carryDebug.missing_end_time,
        "already_ended=" + carryDebug.already_ended_or_resolving,
        "too_soon=" + carryDebug.too_soon_to_resolve,
        "beyond_max_days=" + carryDebug.beyond_max_days,
        "procedural=" + carryDebug.procedural_rejected,
        "no_book=" + carryDebug.no_book_or_ask,
        "roi_band=" + carryDebug.roi_out_of_band,
        "spread=" + carryDebug.spread_too_high,
        "spread_edge=" + carryDebug.spread_edge_too_high,
        "edge_small=" + carryDebug.edge_too_small,
        "ask_liq=" + carryDebug.ask_liq_too_low,
        "http_used=" + carryDebug.http_used,
        "http_failed=" + carryDebug.http_failed
      );
      if (sampleNoBookTokenIds.length > 0) {
        const booksDebug = getBooksDebug();
        for (const yesTokenId of sampleNoBookTokenIds) {
          const normalized_key = normalizeBookKey(yesTokenId);
          const has_book = booksDebug.hasKey(yesTokenId);
          console.log("[carry probe]", { yesTokenId, has_book, normalized_key });
        }
      }
      const sizeUsdCarry = carryConfig.sizeUsd ?? 100;
      for (const c of carryCandidates) {
        const category = inferCategory(c.market);
        const resolutionWindowBucket = computeResolutionWindowBucket(c.market.resolutionTime, config);
        const riskProposal: TradeProposalForRisk = {
          marketId: c.market.marketId,
          conditionId: c.market.conditionId,
          sizeUsd: sizeUsdCarry,
          category,
          assumptionGroup: c.assumption_key,
          resolutionWindowBucket,
          assumptionKey: c.assumption_key,
          windowKey: c.window_key,
        };
        const allow = allowTrade(riskProposal, riskState, config);
        if (allow.decision === "BLOCK") continue;
        const sizeToOpen =
          allow.decision === "ALLOW_REDUCED_SIZE" && allow.suggested_size != null
            ? allow.suggested_size
            : sizeUsdCarry;
        const planId = planIdFromMode(c.market.marketId, "YES", "carry");
        const carryPlanPayload = {
          plan_id: planId,
          market_id: c.market.marketId,
          condition_id: c.market.conditionId,
          no_token_id: normalizeTokenId(c.yesTokenId),
          outcome: "YES" as const,
          sizeUsd: sizeToOpen,
          limit_price: c.yesAsk,
          category,
          assumption_key: c.assumption_key,
          window_key: c.window_key,
          ev_breakdown: {
            net_ev: c.carry_roi_pct,
            mode: "carry",
            carry_roi_pct: c.carry_roi_pct,
            hold_to_resolution: true,
            time_to_resolution_days: c.time_to_resolution_days,
            ...(c.end_time_iso != null && { end_time_iso: c.end_time_iso }),
            yes_bid: c.yesBid,
            yes_ask: c.yesAsk,
            spread: c.spreadObservable,
            edge_abs: c.edge_abs,
            spread_edge_ratio: c.spread_edge_ratio,
            price_source: c.price_source,
            ...(c.http_fallback_used && { http_fallback_used: true }),
            ...(c.synthetic_ask && {
              synthetic_ask: true,
              synthetic_ask_price: c.synthetic_ask_price,
              synthetic_reason: c.synthetic_reason,
              top_noBid: c.top_noBid ?? undefined,
              top_noAsk: c.top_noAsk ?? undefined,
            }),
          },
          headroom: allow.headroom,
          status: "proposed" as const,
        };
        plansForApi.push(carryPlanPayload);
      }
    }

    if (plansForApi.length > 0 && /[^0-9]/.test(plansForApi[0].no_token_id)) {
      console.warn("[bug] no_token_id not normalized:", plansForApi[0].no_token_id);
    }
    const carryPlans = plansForApi.filter(
      (p) => (p as { ev_breakdown?: { mode?: string } }).ev_breakdown?.mode === "carry"
    );
    console.log("\n================ CARRY DEBUG ================");
    console.log(`[carry] total plansForApi : ${plansForApi.length}`);
    console.log(`[carry] carry plans       : ${carryPlans.length}`);
    if (carryPlans.length > 0) {
      console.log("[carry] sample (tDays + end_time_iso):");
      carryPlans.slice(0, 3).forEach((p, i) => {
        const ev = (p as {
          market_id?: string;
          ev_breakdown?: { carry_roi_pct?: number; time_to_resolution_days?: number; end_time_iso?: string };
        });
        console.log(
          `  ${i + 1}) market=${ev.market_id} roi=${ev.ev_breakdown?.carry_roi_pct} tDays=${ev.ev_breakdown?.time_to_resolution_days} end_time_iso=${ev.ev_breakdown?.end_time_iso ?? "—"}`
        );
      });
    } else {
      console.log("[carry] ⚠️ NO CARRY PLANS GENERATED");
    }
    console.log("============================================\n");
    setPlans(plansForApi, scanTsIso, { ev_mode: evMode, ...carryMeta });
    const storeCount = getPlans().count;
    const proposedCount = plansForApi.length;
    console.log(`[debug] plan_store_count=${storeCount} proposed_count=${proposedCount}`);
    if (storeCount !== proposedCount) {
      console.log(`[bug] proposed_count_mismatch plan_store_count=${storeCount} proposed_count=${proposedCount}`);
    }

    /** Phase 2: ops loop over the same proposed-plans array. */
    for (const item of proposedPlans) {
      const { planId, planPayload, market: marketItem, proposal: proposalItem, effectiveFill: effectiveFillItem, allow: allowItem, evResult: evResultItem, category: cat, assumptionKey: ak, windowKey: wk, sizeToOpen: sizeToOpenItem } = item;
      if (getMode() === "DISARMED" || isPanic()) {
        console.log(`[ops] Skipping execution (mode=${getMode()}, panic=${isPanic()}) for ${marketItem.marketId}`);
        continue;
      }
      if (isConfirmMode()) {
        const plan: TradePlan = {
          ...planPayload,
          plan_id: planId,
          created_at: item.createdAt,
          status: "queued",
        };
        enqueuePlan(plan);
        appendLedger(dataDir, {
          timestamp: new Date().toISOString(),
          action: "plan_created",
          marketId: marketItem.marketId,
          metadata: { plan_id: planId, sizeUsd: sizeToOpenItem, assumption_key: ak, window_key: wk },
        });
        console.log(`[ops] Plan queued ${planId} for ${marketItem.marketId} (ARMED_CONFIRM)`);
        continue;
      }
      if (isAutoExecute()) {
        const position = openPaperPosition(proposalItem, effectiveFillItem, randomUUID());
        insertPosition(dataDir, position);
        riskState = buildRiskStateFromPositions(listPositions(dataDir, true));
        appendLedger(dataDir, {
          timestamp: new Date().toISOString(),
          action: "trade_opened",
          marketId: marketItem.marketId,
          metadata: {
            positionId: position.id,
            sizeUsd: position.sizeUsd,
            assumptionKey: ak,
            windowKey: wk,
            plan_id: planId,
            tail_risk_cost: evResultItem.tail_risk_cost,
            tailByp: evResultItem.tailByp,
            tail_bypass_reason: evResultItem.tail_bypass_reason,
          },
        });
        appendLedger(dataDir, {
          timestamp: new Date().toISOString(),
          action: "plan_executed",
          marketId: marketItem.marketId,
          metadata: { plan_id: planId, positionId: position.id, sizeUsd: position.sizeUsd },
        });
        console.log(`[paper] OPENED ${marketItem.marketId} size=${position.sizeUsd.toFixed(2)} USD (plan ${planId})`);
        topCandidatesByNetEv.push({
          marketId: marketItem.marketId,
          question: marketItem.question,
          net_ev: evResultItem.net_ev,
          tail_risk_cost: evResultItem.tail_risk_cost,
          tailByp: evResultItem.tailByp,
          tail_bypass_reason: evResultItem.tail_bypass_reason,
          category: cat,
          window_key: wk,
          assumption_key: ak,
          headroom: allowItem.headroom,
        });
      }
    }

    maybeReport();
  }

  function sanitizeTokenId(x: string): string | null {
    const s = String(x).trim().replace(/[^0-9]/g, "");
    return s.length >= 10 ? s : null;
  }

  async function executePlan(planId: string): Promise<ConfirmResult> {
    const plan = getPlan(planId);
    if (!plan) return null;
    if (isPlanExecuted(planId)) return { executed: false, reason: "already executed" };
    const ev = plan.ev_breakdown as { mode?: string; synthetic_ask?: boolean; synthetic_time?: boolean } | undefined;
    if (ev?.mode === "carry" && (ev?.synthetic_ask === true || ev?.synthetic_time === true)) {
      console.log(`[ops] Skipping execute (paper-only synthetic carry) plan_id=${planId}`);
      return { executed: false, reason: "paper_only_synthetic_carry" };
    }
    const gate = getConfirmGateRejection();
    if (gate) return { executed: false, reason: gate };
    const proposal: TradeProposal = {
      marketId: plan.market_id,
      conditionId: plan.condition_id,
      noTokenId: plan.no_token_id,
      side: "NO",
      sizeUsd: plan.sizeUsd,
      bestAsk: plan.limit_price,
      category: plan.category,
      assumptionGroup: plan.assumption_key,
      resolutionWindowBucket: plan.window_key,
      assumptionKey: plan.assumption_key,
      windowKey: plan.window_key,
    };
    const depth = getDepth(plan.no_token_id);
    const fill = simulateFill(proposal, depth, config.simulation);
    if (!fill.filled) return { executed: false, reason: `no_fill: ${fill.reason}` };
    const riskState = buildRiskStateFromPositions(listPositions(dataDir, true));
    const riskProposal: TradeProposalForRisk = {
      marketId: plan.market_id,
      conditionId: plan.condition_id,
      sizeUsd: fill.fillSizeUsd,
      category: plan.category,
      assumptionGroup: plan.assumption_key,
      resolutionWindowBucket: plan.window_key,
      assumptionKey: plan.assumption_key,
      windowKey: plan.window_key,
    };
    const allow = allowTrade(riskProposal, riskState, config);
    if (allow.decision === "BLOCK") return { executed: false, reason: "blocked" };
    const sizeToOpen =
      allow.decision === "ALLOW_REDUCED_SIZE" && allow.suggested_size != null
        ? allow.suggested_size
        : fill.fillSizeUsd;
    const effectiveFill =
      sizeToOpen < fill.fillSizeUsd
        ? {
            ...fill,
            fillSizeUsd: sizeToOpen,
            fillSizeShares: sizeToOpen / fill.entryPriceVwap,
          }
        : fill;
    const position = openPaperPosition(proposal, effectiveFill, randomUUID());
    insertPosition(dataDir, position);
    const executedAt = new Date().toISOString();
    markPlanExecuted(planId, executedAt);
    appendLedger(dataDir, {
      timestamp: executedAt,
      action: "trade_opened",
      marketId: plan.market_id,
      metadata: {
        positionId: position.id,
        sizeUsd: position.sizeUsd,
        plan_id: planId,
        assumptionKey: plan.assumption_key,
        windowKey: plan.window_key,
      },
    });
    appendLedger(dataDir, {
      timestamp: executedAt,
      action: "plan_executed",
      marketId: plan.market_id,
      metadata: { plan_id: planId, positionId: position.id, sizeUsd: position.sizeUsd },
    });
    console.log(`[ops] CONFIRM executed plan ${planId} -> position ${position.id}`);
    return { executed: true, positionId: position.id };
  }

  createControlApi(config.control_api.port, { confirmHandler: executePlan }, { clobRestBaseUrl: config.api.clobRestBaseUrl });

  (async () => {
    await runScan().catch((e) => console.error("[startup]", e));
    const marketsForWs = await fetchActiveMarkets(config.api.gammaBaseUrl, { limit: 20, maxPages: 1 }).catch(() => []);
    const wsSubscribedCap = config.ws?.max_assets_subscribed ?? 200;
    const noTokenIds = (marketsForWs.filter((m) => m.noTokenId).map((m) => m.noTokenId!) ?? []) as string[];
    const yesTokenIds = (marketsForWs.filter((m) => m.yesTokenId).map((m) => m.yesTokenId!) ?? []) as string[];
    const tokenIdsRaw = [...new Set([...noTokenIds, ...yesTokenIds])].slice(0, wsSubscribedCap);
    const tokenIdsForWs = tokenIdsRaw.map(sanitizeTokenId).filter((x): x is string => x != null);
    console.log("[orderbook_ws] [diagnostic] tokenIds raw count:", tokenIdsRaw.length, "sanitized count:", tokenIdsForWs.length);
    console.log("[orderbook_ws] [diagnostic] Subscribing tokenIds sample (sanitized):", tokenIdsForWs.slice(0, 5));
    if (tokenIdsForWs.length > 0) {
      orderbookStop = startOrderbookStream(
        tokenIdsForWs,
        () => {},
        { wsUrl: config.ws.market_url }
      );
      console.log("[orderbook_ws] WS URL:", config.ws.market_url);
      setTimeout(() => {
        const toCheck = tokenIdsForWs.slice(0, 3);
        for (let i = 0; i < toCheck.length; i++) {
          const topOfBook = getTopOfBook(toCheck[i]);
          console.log("[debug] topOfBook for token", i + 1, toCheck[i].slice(0, 12) + "…:", topOfBook == null ? null : { noBid: topOfBook.noBid, noAsk: topOfBook.noAsk, spread: topOfBook.spread });
        }
      }, 10000);
    }
    scanTimer = setInterval(() => {
      runScan().catch((e) => console.warn("[scan]", e.message));
    }, config.scanner.pollIntervalMs);
  })();

  process.on("SIGINT", () => {
    console.log("\n[shutdown] SIGINT — flushing and exiting.");
    if (orderbookStop) orderbookStop.stop();
    if (scanTimer) clearInterval(scanTimer);
    tickReport();
    process.exit(0);
  });
}

main();
