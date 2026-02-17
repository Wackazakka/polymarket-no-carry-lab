import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { Config } from "../config/load_config";
import type { PaperPosition } from "../types";
import type { RiskState, HeadroomSnapshot } from "../risk/risk_engine";
import { worstCaseIfAssumptionFails } from "../risk/risk_engine";
import { getExpectedPnl } from "../strategy/paper_executor";

export interface ReportInput {
  candidatesScanned: number;
  candidatesPassedFilters: number;
  tradesProposed: number;
  tradesBlockedByRisk: number;
  blockReasons: Record<string, number>;
  positions: PaperPosition[];
  riskState: RiskState;
  topCandidatesByNetEv: Array<{
    marketId: string;
    question?: string;
    net_ev: number;
    reason?: string;
    tail_risk_cost?: number;
    tailByp?: string;
    tail_bypass_reason?: string;
    category?: string | null;
    window_key?: string;
    assumption_key?: string;
    headroom?: HeadroomSnapshot;
  }>;
  worstCandidates: Array<{ marketId: string; question?: string; net_ev?: number; reason?: string }>;
}

export interface ReportResult {
  text: string;
  json: ReportInput & {
    totalExposureUsd: number;
    expectedPnlPaper: number;
    worstCaseByAssumption: Array<{ assumptionGroup: string; worstCaseUsd: number }>;
  };
}

function formatSection(title: string, lines: string[]): string {
  return `\n## ${title}\n${lines.join("\n")}\n`;
}

export function generateReport(state: ReportInput, config: Config): ReportResult {
  const riskState = state.riskState;
  const totalExposureUsd = riskState.totalExposureUsd;
  const openPositions = state.positions.filter((p) => !p.closedAt);
  let expectedPnlPaper = 0;
  for (const p of openPositions) {
    expectedPnlPaper += getExpectedPnl(p);
  }

  const assumptionGroups = Object.keys(riskState.exposuresByAssumption);
  const worstCaseByAssumption = assumptionGroups
    .map((ag) => ({
      assumptionGroup: ag,
      worstCaseUsd: worstCaseIfAssumptionFails(ag, riskState),
    }))
    .filter((x) => x.worstCaseUsd > 0)
    .sort((a, b) => b.worstCaseUsd - a.worstCaseUsd)
    .slice(0, 5);

  const lines: string[] = [];
  lines.push("# Polymarket NO-Carry Lab — Report");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("**This is paper trading only. No live orders. Expected PnL is not realized.**");
  lines.push("");

  lines.push(formatSection("Scan summary", [
    `Candidates scanned: ${state.candidatesScanned}`,
    `Passed filters: ${state.candidatesPassedFilters}`,
    `Trades proposed: ${state.tradesProposed}`,
    `Blocked by risk: ${state.tradesBlockedByRisk}`,
  ]).trim());

  const topBlockReasons = Object.entries(state.blockReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([r, c]) => `  - ${r}: ${c}`);
  lines.push(formatSection("Top block reasons (risk)", topBlockReasons.length ? topBlockReasons : ["  (none)"]).trim());

  lines.push(formatSection("Open positions", [
    `Count: ${openPositions.length}`,
    `Total exposure (USD): ${totalExposureUsd.toFixed(2)}`,
  ]).trim());

  const categoryLines = Object.entries(riskState.exposuresByCategory).map(([k, v]) => `  ${k}: ${v.toFixed(2)} USD`);
  lines.push(formatSection("Exposure by category", categoryLines.length ? categoryLines : ["  (none)"]).trim());

  const assumptionLines = Object.entries(riskState.exposuresByAssumption).map(([k, v]) => `  ${k}: ${v.toFixed(2)} USD`);
  lines.push(formatSection("Exposure by assumption group", assumptionLines.length ? assumptionLines : ["  (none)"]).trim());

  const windowLines = Object.entries(riskState.exposuresByResolutionWindow).map(([k, v]) => `  ${k}: ${v.toFixed(2)} USD`);
  lines.push(formatSection("Exposure by resolution window", windowLines.length ? windowLines : ["  (none)"]).trim());

  lines.push("");
  lines.push("### Expected PnL (paper)");
  lines.push(`Total expected PnL (if all NO resolve in our favor): ${expectedPnlPaper.toFixed(2)} USD`);
  lines.push("(Conservative tail/loss not subtracted here; see EV model.)");
  lines.push("");

  lines.push("### Worst-case if one assumption fails");
  worstCaseByAssumption.forEach((x) => {
    lines.push(`  ${x.assumptionGroup}: ${x.worstCaseUsd.toFixed(2)} USD`);
  });
  if (worstCaseByAssumption.length === 0) lines.push("  (none)");
  lines.push("");

  const n = config.reporting.print_top_n;
  const topCandidates = state.topCandidatesByNetEv.slice(0, n);
  const anyTailBypass = topCandidates.some((c) => c.tailByp === "Y");
  lines.push(formatSection(`Top ${n} candidates by net EV`, [
    ...topCandidates.map((c) => {
      const cat = c.category ?? "—";
      const wk = c.window_key ?? "—";
      const ak = c.assumption_key != null ? c.assumption_key.slice(0, 10) + (c.assumption_key.length > 10 ? "…" : "") : "—";
      const hr = c.headroom
        ? `headroom: G=${c.headroom.global.toFixed(0)} C=${c.headroom.category.toFixed(0)} A=${c.headroom.assumption.toFixed(0)} W=${c.headroom.window.toFixed(0)} M=${c.headroom.per_market.toFixed(0)}`
        : "";
      return `  - ${c.marketId} | cat=${cat} | ${wk} | a1=${ak} | net_ev=${c.net_ev?.toFixed(4) ?? "?"} | tail_cost=${c.tail_risk_cost?.toFixed(4) ?? "?"} | tailByp=${c.tailByp ?? "N"}${c.tail_bypass_reason ? ` (${c.tail_bypass_reason})` : ""}${hr ? ` | ${hr}` : ""} | ${c.question ?? ""}`;
    }),
    ...(anyTailBypass ? ["  (Tail bypass applied for capture_mode candidates.)"] : []),
  ]).trim());

  lines.push(formatSection(`Top ${n} worst / ambiguous / high spread`, state.worstCandidates.slice(0, n).map((c) =>
    `  - ${c.marketId} | ${c.reason ?? ""} | ${c.question ?? ""}`
  )).trim());

  const text = lines.join("\n");

  const json = {
    ...state,
    totalExposureUsd,
    expectedPnlPaper,
    worstCaseByAssumption,
  };

  return { text, json };
}

export function writeReportToFile(
  result: ReportResult,
  config: Config
): string {
  const dir = config.reporting.report_dir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const txtPath = join(dir, `report_${ts}.txt`);
  const jsonPath = join(dir, `report_${ts}.json`);
  writeFileSync(txtPath, result.text, "utf-8");
  writeFileSync(jsonPath, JSON.stringify(result.json, null, 2), "utf-8");
  return txtPath;
}
