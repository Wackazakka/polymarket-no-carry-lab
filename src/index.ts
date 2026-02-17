/**
 * Polymarket NO-Carry Lab v0.2 — Read-only, paper-trading simulator.
 * No private keys, no wallets, no signing, no order placement.
 */

import { loadConfig } from "./config/load_config";
import { enforceNoLiveTrading } from "./safety/ban_live_trading";
import { fetchActiveMarkets } from "./market_fetcher";
import {
  getTopOfBook,
  getDepth,
  startOrderbookStream,
  fetchOrderbookSnapshot,
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
} from "./execution";
import { computeAssumptionKey, computeWindowKey } from "./assumption/keys";
import {
  allowTrade,
  buildRiskStateFromPositions,
  inferCategory,
  inferAssumptionGroup,
  computeResolutionWindowBucket,
  type TradeProposalForRisk,
} from "./risk/risk_engine";
import { initStore } from "./state/store";
import { initPositionsDb, listPositions, insertPosition } from "./state/positions";
import { initLedgerDb, appendLedger } from "./state/ledger";
import { generateReport, writeReportToFile, type ReportInput } from "./audit";
import type { NormalizedMarket, TradePlan } from "./types";
import { randomUUID } from "crypto";
import {
  getMode,
  isPanic,
  isConfirmMode,
  isAutoExecute,
  setModeChangeCallback,
  panicStop,
  getModeState,
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

function main(): void {
  const config = loadConfig();
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
    const subscribedCap = config.ws?.max_assets_subscribed ?? 200;
    const tokenIds = [...new Set(withNoToken.map((m) => m.noTokenId!).slice(0, subscribedCap))];
    await fetchOrderbookSnapshot(config.api.clobRestBaseUrl, tokenIds);

    const tokenToMarket = new Map<string, NormalizedMarket>();
    for (const m of withNoToken) {
      if (m.noTokenId) tokenToMarket.set(m.noTokenId, m);
    }

    candidatesScanned += markets.length;
    const now = new Date();
    const selection = config.selection;
    const diagnosticLoose = Boolean(config.diagnostic_loose_filters);
    const filterConfig = diagnosticLoose
      ? {
          min_no_price: 0.8,
          max_spread: 0.05,
          min_liquidity_usd: 100,
          max_time_to_resolution_hours: selection.max_time_to_resolution_hours * 1.5,
        }
      : {
          min_no_price: selection.min_no_price,
          max_spread: selection.max_spread,
          min_liquidity_usd: selection.min_liquidity_usd,
          max_time_to_resolution_hours: selection.max_time_to_resolution_hours,
        };
    if (diagnosticLoose) {
      console.log("[diagnostic] Using loose filter thresholds: min_no_price=0.8 max_spread=0.05 min_liquidity_usd=100 max_time_to_resolution_hours=" + filterConfig.max_time_to_resolution_hours);
    }

    const passed: Array<{ market: NormalizedMarket; book: ReturnType<typeof getTopOfBook>; filterResult: ReturnType<typeof evaluateMarketCandidate> }> = [];
    const failedWithDetails: Array<{ market: NormalizedMarket; failedChecks: FailedCheck[] }> = [];
    let missingOrderbookCount = 0;
    let evaluatedWithBookCount = 0;
    const totalCandidates = withNoToken.length;

    for (const market of withNoToken) {
      if (!market.noTokenId) continue;
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
      const nowTs = Date.now();
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

      tradesProposed++;
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

      const planId = randomUUID();
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
          net_ev: evResult.net_ev,
          tail_risk_cost: evResult.tail_risk_cost,
          tailByp: evResult.tailByp,
          tail_bypass_reason: evResult.tail_bypass_reason,
        },
        headroom: allow.headroom,
      };

      if (getMode() === "DISARMED" || isPanic()) {
        console.log(`[ops] Skipping execution (mode=${getMode()}, panic=${isPanic()}) for ${market.marketId}`);
        continue;
      }

      if (isConfirmMode()) {
        const plan: TradePlan = {
          ...planPayload,
          plan_id: planId,
          created_at: new Date().toISOString(),
          status: "queued",
        };
        enqueuePlan(plan);
        appendLedger(dataDir, {
          timestamp: new Date().toISOString(),
          action: "plan_created",
          marketId: market.marketId,
          metadata: { plan_id: planId, sizeUsd: sizeToOpen, assumption_key: assumptionKey, window_key: windowKey },
        });
        console.log(`[ops] Plan queued ${planId} for ${market.marketId} (ARMED_CONFIRM)`);
        continue;
      }

      if (isAutoExecute()) {
        const position = openPaperPosition(proposal, effectiveFill, randomUUID());
        insertPosition(dataDir, position);
        riskState = buildRiskStateFromPositions(listPositions(dataDir, true));
        appendLedger(dataDir, {
          timestamp: new Date().toISOString(),
          action: "trade_opened",
          marketId: market.marketId,
          metadata: {
            positionId: position.id,
            sizeUsd: position.sizeUsd,
            assumptionKey,
            windowKey,
            plan_id: planId,
            tail_risk_cost: evResult.tail_risk_cost,
            tailByp: evResult.tailByp,
            tail_bypass_reason: evResult.tail_bypass_reason,
          },
        });
        appendLedger(dataDir, {
          timestamp: new Date().toISOString(),
          action: "plan_executed",
          marketId: market.marketId,
          metadata: { plan_id: planId, positionId: position.id, sizeUsd: position.sizeUsd },
        });
        console.log(`[paper] OPENED ${market.marketId} size=${position.sizeUsd.toFixed(2)} USD (plan ${planId})`);
        topCandidatesByNetEv.push({
          marketId: market.marketId,
          question: market.question,
          net_ev: evResult.net_ev,
          tail_risk_cost: evResult.tail_risk_cost,
          tailByp: evResult.tailByp,
          tail_bypass_reason: evResult.tail_bypass_reason,
          category,
          window_key: windowKey,
          assumption_key: assumptionKey,
          headroom: allow.headroom,
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

  createControlApi(config.control_api.port, { confirmHandler: executePlan });

  (async () => {
    await runScan().catch((e) => console.error("[startup]", e));
    const marketsForWs = await fetchActiveMarkets(config.api.gammaBaseUrl, { limit: 20, maxPages: 1 }).catch(() => []);
    const wsSubscribedCap = config.ws?.max_assets_subscribed ?? 200;
    const tokenIdsRaw = [...new Set(marketsForWs.filter((m) => m.noTokenId).map((m) => m.noTokenId!).slice(0, wsSubscribedCap))];
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
