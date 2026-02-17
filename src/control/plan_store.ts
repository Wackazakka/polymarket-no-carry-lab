/**
 * Last-scan plan store: plans proposed in the most recent scan.
 * Used by GET /plans and GET /status. Not the confirm queue (that is ops/plan_queue).
 */

let lastScanTs: string | null = null;
let lastPlans: unknown[] = [];
let lastMeta: Record<string, unknown> | null = null;

export function setPlans(
  plans: unknown[],
  scanTsIso: string,
  meta?: Record<string, unknown>
): void {
  lastPlans = plans.slice();
  lastScanTs = scanTsIso;
  lastMeta = meta ?? null;
}

export function getPlans(): {
  lastScanTs: string | null;
  count: number;
  plans: unknown[];
  meta: Record<string, unknown> | null;
} {
  return {
    lastScanTs,
    count: lastPlans.length,
    plans: lastPlans,
    meta: lastMeta,
  };
}
