import type { PaperPosition } from "../types";
import { loadPositions, upsertPosition, closePosition as storeClosePosition, computeExposuresByGroup as storeComputeExposuresByGroup } from "./store";

/** No-op for compatibility; init is done via initStore(config) in index. */
export function initPositionsDb(_dataDir: string): void {}

export function listPositions(dataDir: string, openOnly: boolean = true): PaperPosition[] {
  const all = loadPositions(dataDir);
  if (openOnly) return all.filter((p) => !p.closedAt);
  return all;
}

export function insertPosition(dataDir: string, position: PaperPosition): void {
  upsertPosition(dataDir, position);
}

export function closePosition(dataDir: string, positionId: string, expectedPnl: number): void {
  storeClosePosition(dataDir, positionId, expectedPnl);
}

export function computeExposuresByGroup(dataDir: string): {
  byCategory: Record<string, number>;
  byAssumption: Record<string, number>;
  byResolutionWindow: Record<string, number>;
  total: number;
} {
  return storeComputeExposuresByGroup(dataDir);
}
