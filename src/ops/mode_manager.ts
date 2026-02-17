/**
 * Execution mode state: DISARMED (default), ARMED_CONFIRM, ARMED_AUTO.
 * Panic flag blocks execution and clears queue when set.
 * Mode changes are persisted as audit events via onModeChange.
 */

import type { ExecutionMode } from "../types";

export interface ModeState {
  mode: ExecutionMode;
  panic: boolean;
}

export type ModeChangeCallback = (state: ModeState, previous: ModeState) => void;

const DEFAULT_STATE: ModeState = { mode: "DISARMED", panic: false };

let state: ModeState = { ...DEFAULT_STATE };
let onModeChange: ModeChangeCallback | null = null;

export function getModeState(): ModeState {
  return { ...state };
}

export function getMode(): ExecutionMode {
  return state.mode;
}

export function isPanic(): boolean {
  return state.panic;
}

/** True if we may execute (auto or after confirm). */
export function mayExecute(): boolean {
  return !state.panic && (state.mode === "ARMED_AUTO" || state.mode === "ARMED_CONFIRM");
}

/** True if we execute immediately when allowed (no confirm). */
export function isAutoExecute(): boolean {
  return !state.panic && state.mode === "ARMED_AUTO";
}

/** True if we only enqueue plans and wait for confirm. */
export function isConfirmMode(): boolean {
  return !state.panic && state.mode === "ARMED_CONFIRM";
}

/** Reason confirm execution is not allowed, or null if allowed. */
export function getConfirmGateRejection(): "panic" | "mode" | null {
  if (state.panic) return "panic";
  if (state.mode !== "ARMED_CONFIRM") return "mode";
  return null;
}

export function setMode(newMode: ExecutionMode): void {
  const previous = { ...state };
  state.mode = newMode;
  if (onModeChange) onModeChange(state, previous);
}

export function setPanic(panic: boolean): void {
  const previous = { ...state };
  if (panic) {
    state.panic = true;
    state.mode = "DISARMED";
  } else {
    state.panic = false;
  }
  if (onModeChange) onModeChange(state, previous);
}

/** Panic stop: disarm and set panic flag. */
export function panicStop(): void {
  setPanic(true);
}

export function setModeChangeCallback(cb: ModeChangeCallback | null): void {
  onModeChange = cb;
}

export function resetModeStateForTesting(): void {
  state = { ...DEFAULT_STATE };
}
