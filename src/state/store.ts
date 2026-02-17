/**
 * File-based persistence: JSONL for ledger, JSON for current positions.
 * No native addons. Uses config.db.path to derive data directory.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { dirname, join } from "path";
import type { Config } from "../config/load_config";
import type { PaperPosition } from "../types";
import type { LedgerEntry } from "../types";

const LEDGER_FILE = "ledger.jsonl";
const POSITIONS_FILE = "positions.json";

/**
 * Ensure data directory exists. Returns data directory path (dirname of config.db.path).
 * Logs where ledger and positions are written.
 */
export function initStore(config: Config): string {
  const dataDir = dirname(config.db.path);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  const ledgerPath = join(dataDir, LEDGER_FILE);
  const positionsPath = join(dataDir, POSITIONS_FILE);
  console.log("[store] Data directory:", dataDir);
  console.log("[store] Ledger:", ledgerPath);
  console.log("[store] Positions:", positionsPath);
  return dataDir;
}

function ledgerPath(dataDir: string): string {
  return join(dataDir, LEDGER_FILE);
}

function positionsPath(dataDir: string): string {
  return join(dataDir, POSITIONS_FILE);
}

/** Append one ledger entry (one JSON line). */
export function appendLedger(dataDir: string, entry: Omit<LedgerEntry, "id">): void {
  const line = JSON.stringify({
    timestamp: entry.timestamp,
    action: entry.action,
    marketId: entry.marketId,
    metadata: entry.metadata ?? {},
  }) + "\n";
  appendFileSync(ledgerPath(dataDir), line, "utf-8");
}

/** Read last N ledger entries (from end of file). */
export function getLedger(dataDir: string, limit: number): LedgerEntry[] {
  const path = ledgerPath(dataDir);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((s) => s.trim());
  const fromEnd = lines.slice(-limit).reverse();
  return fromEnd.map((line, i) => {
    const o = JSON.parse(line) as { timestamp: string; action: string; marketId: string; metadata?: Record<string, unknown> };
    return {
      id: fromEnd.length - i,
      timestamp: o.timestamp,
      action: o.action as LedgerEntry["action"],
      marketId: o.marketId,
      metadata: o.metadata ?? {},
    };
  });
}

/** Load all positions from positions.json. */
export function loadPositions(dataDir: string): PaperPosition[] {
  const path = positionsPath(dataDir);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr as PaperPosition[];
  } catch {
    return [];
  }
}

/** Overwrite positions.json with current state. */
export function savePositions(dataDir: string, positions: PaperPosition[]): void {
  const path = positionsPath(dataDir);
  writeFileSync(path, JSON.stringify(positions, null, 2), "utf-8");
}

/** Add or replace position by id. */
export function upsertPosition(dataDir: string, position: PaperPosition): void {
  const positions = loadPositions(dataDir);
  const idx = positions.findIndex((p) => p.id === position.id);
  if (idx >= 0) positions[idx] = position;
  else positions.push(position);
  savePositions(dataDir, positions);
}

/** Mark position closed and set expected PnL. */
export function closePosition(dataDir: string, positionId: string, expectedPnl: number): void {
  const positions = loadPositions(dataDir);
  const p = positions.find((x) => x.id === positionId);
  if (!p) return;
  p.closedAt = new Date().toISOString();
  p.expectedPnl = expectedPnl;
  savePositions(dataDir, positions);
}

/** Same output shape as before: by category, by assumption, by resolution window, total. */
export function computeExposuresByGroup(dataDir: string): {
  byCategory: Record<string, number>;
  byAssumption: Record<string, number>;
  byResolutionWindow: Record<string, number>;
  total: number;
} {
  const positions = loadPositions(dataDir).filter((p) => !p.closedAt);
  const byCategory: Record<string, number> = {};
  const byAssumption: Record<string, number> = {};
  const byResolutionWindow: Record<string, number> = {};
  let total = 0;
  for (const p of positions) {
    total += p.sizeUsd;
    const cat = p.category ?? "uncategorized";
    byCategory[cat] = (byCategory[cat] ?? 0) + p.sizeUsd;
    const ag = p.assumptionGroup ?? "other";
    byAssumption[ag] = (byAssumption[ag] ?? 0) + p.sizeUsd;
    const rw = p.resolutionWindowBucket ?? "unknown";
    byResolutionWindow[rw] = (byResolutionWindow[rw] ?? 0) + p.sizeUsd;
  }
  return { byCategory, byAssumption, byResolutionWindow, total };
}
