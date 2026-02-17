import type { LedgerEntry } from "../types";
import { appendLedger as storeAppendLedger, getLedger } from "./store";

/** No-op for compatibility; init is done via initStore(config) in index. */
export function initLedgerDb(_dataDir: string): void {}

export function appendLedger(dataDir: string, entry: Omit<LedgerEntry, "id">): void {
  storeAppendLedger(dataDir, entry);
}

export function getLastLedgerEntries(dataDir: string, n: number): LedgerEntry[] {
  return getLedger(dataDir, n);
}
