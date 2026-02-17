/**
 * In-memory trade plan queue (MVP). Optional JSONL persistence later.
 * Plans are keyed by plan_id for idempotent confirm.
 */

import type { TradePlan } from "../types";

const queue: TradePlan[] = [];
const executedIds = new Set<string>();

export function enqueuePlan(plan: TradePlan): void {
  if (executedIds.has(plan.plan_id)) return;
  const existing = queue.find((p) => p.plan_id === plan.plan_id);
  if (existing) return;
  queue.push({ ...plan, status: "queued" as const });
}

export function getPlans(): TradePlan[] {
  return queue.filter((p) => p.status === "queued");
}

export function getAllPlans(): TradePlan[] {
  return [...queue];
}

export function getPlan(plan_id: string): TradePlan | undefined {
  return queue.find((p) => p.plan_id === plan_id);
}

export function markPlanExecuted(plan_id: string, executed_at: string): boolean {
  const plan = queue.find((p) => p.plan_id === plan_id);
  if (!plan) return false;
  if (plan.status === "executed") {
    executedIds.add(plan_id);
    return true;
  }
  plan.status = "executed";
  plan.executed_at = executed_at;
  executedIds.add(plan_id);
  return true;
}

export function isPlanExecuted(plan_id: string): boolean {
  return executedIds.has(plan_id) || queue.some((p) => p.plan_id === plan_id && p.status === "executed");
}

export function clearQueue(): void {
  queue.length = 0;
  executedIds.clear();
}

export function queueLength(): number {
  return queue.filter((p) => p.status === "queued").length;
}

export function resetPlanQueueForTesting(): void {
  queue.length = 0;
  executedIds.clear();
}
