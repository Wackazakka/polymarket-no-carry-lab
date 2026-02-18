/**
 * Last-scan plan store: plans proposed in the most recent scan.
 * Used by GET /plans and GET /status. Not the confirm queue (that is ops/plan_queue).
 * Plans are keyed by plan_id; setPlans upserts (preserves created_at for existing, sets updated_at = now).
 */

let lastScanTs: string | null = null;
const plansById = new Map<string, Record<string, unknown>>();
let lastMeta: Record<string, unknown> | null = null;

export function setPlans(
  plans: unknown[],
  scanTsIso: string,
  meta?: Record<string, unknown>
): void {
  const nowIso = new Date().toISOString();
  for (const p of plans) {
    const plan = p as Record<string, unknown> & { plan_id: string };
    const id = plan.plan_id;
    const existing = plansById.get(id);
    const created_at =
      existing != null && typeof existing.created_at === "string" ? existing.created_at : nowIso;
    const updated_at = nowIso;
    plansById.set(id, { ...plan, created_at, updated_at });
  }
  const ids = new Set(plans.map((x) => (x as { plan_id: string }).plan_id));
  for (const id of plansById.keys()) {
    if (!ids.has(id)) plansById.delete(id);
  }
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
    count: plansById.size,
    plans: Array.from(plansById.values()),
    meta: lastMeta,
  };
}
