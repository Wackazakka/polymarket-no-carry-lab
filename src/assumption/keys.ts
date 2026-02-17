/**
 * Deterministic assumption_key and window_key for correlated caps (rule-based v1).
 * Same market + same nowTs -> same keys. No randomness, no Date.now() inside.
 */

import { createHash } from "crypto";
import type { NormalizedMarket } from "../types";

/** Normalize for hashing: lowercase, trim, collapse spaces, strip punctuation. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim();
}

const WINDOW_BUCKETS = [
  { maxHours: 72, id: "W0_0_72H" },
  { maxHours: 168, id: "W1_3_7D" },   // 3–7 days
  { maxHours: 720, id: "W2_8_30D" },  // 8–30 days
  { maxHours: 4320, id: "W3_31_180D" }, // 31–180 days
] as const;
const W_BEYOND = "W4_180D_PLUS";
const W_UNKNOWN = "W_UNKNOWN";

/**
 * Resolution or close time in ms (epoch). Prefer resolutionTime; fallback endDateIso.
 */
function getResolutionOrCloseTime(market: NormalizedMarket): number | null {
  if (market.resolutionTime && !Number.isNaN(market.resolutionTime.getTime())) {
    return market.resolutionTime.getTime();
  }
  const endStr = market.endDateIso;
  if (!endStr) return null;
  const d = new Date(endStr);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * Deterministic window key from time-to-resolution (or close_time). nowTs in ms.
 */
export function computeWindowKey(market: NormalizedMarket, nowTs: number): string {
  const endTs = getResolutionOrCloseTime(market);
  if (endTs == null) return W_UNKNOWN;
  const hoursLeft = (endTs - nowTs) / (1000 * 60 * 60);
  if (hoursLeft < 0) return W_UNKNOWN;
  for (const w of WINDOW_BUCKETS) {
    if (hoursLeft <= w.maxHours) return w.id;
  }
  return W_BEYOND;
}

/** First 8–12 words of text, normalized (for entity fallback). */
function firstWords(text: string, min = 8, max = 12): string {
  const words = normalize(text).split(/\s+/).filter(Boolean);
  const n = Math.min(max, Math.max(min, words.length));
  return words.slice(0, n).join(" ");
}

/**
 * V1 heuristics: elections (candidate/country+year), sports (teams+match), macro (country+indicator).
 * Fallback: normalized first 8–12 words of question.
 */
export function extractPrimaryEntity(market: NormalizedMarket): string {
  const q = (market.question ?? "").trim();
  const t = (market.title ?? "").trim();
  const text = `${q} ${t}`.trim().toLowerCase();
  const outcomes = (market.outcomes ?? []).slice(0, 4).join(" ").toLowerCase();

  // Elections: "X wins 2024", "election country year", candidate names
  const electionYear = text.match(/\b(20\d{2})\b/);
  const electionCountry = text.match(/\b(us|usa|uk|france|germany|brazil|india|mexico)\b/);
  const candidateLike = text.match(/(?:will|won't|wins?|president|pm|election)\s+([a-z][a-z\s]{2,30}?)(?:\s+in|\s+20|$)/i);
  if (electionYear || electionCountry || candidateLike) {
    const parts: string[] = [];
    if (electionCountry) parts.push(electionCountry[1]);
    if (candidateLike) parts.push(normalize(candidateLike[1].trim()));
    if (electionYear) parts.push(electionYear[1]);
    if (parts.length) return parts.join(" ");
  }

  // Sports: team names, "vs", match identifiers
  const vs = text.match(/(\w+(?:\s+\w+)?)\s+vs\.?\s+(\w+(?:\s+\w+)?)/i);
  if (vs) return normalize(`${vs[1]} vs ${vs[2]}`);
  const teamLike = text.match(/(?:win|winning|beat|defeat)\s+(.+?)(?:\?|\.|$)/i);
  if (teamLike) return firstWords(teamLike[1], 2, 6);

  // Macro: country + indicator (CPI, rate, recession, etc.)
  const macroCountry = text.match(/\b(us|fed|ecb|uk|euro|china|japan)\b/i);
  const macroIndicator = text.match(/\b(cpi|inflation|rate\s+cut|recession|gdp|employment|jobs)\b/i);
  if (macroCountry && macroIndicator) {
    return normalize(`${macroCountry[1]} ${macroIndicator[1]}`);
  }
  if (macroIndicator) return normalize(macroIndicator[1]);

  // Outcome names as weak signal (e.g. "Yes" / "No" not useful; named outcomes can be)
  const namedOutcomes = outcomes.replace(/\b(yes|no)\b/gi, "").trim();
  if (namedOutcomes.length > 3) {
    const o = firstWords(namedOutcomes, 2, 6);
    if (o) return o;
  }

  return firstWords(q || t || "unknown");
}

const THESIS_CAPTURE = "NO_CARRY_CAPTURE";
const THESIS_BASELINE = "NO_CARRY_BASELINE";

function stableHash(input: string): string {
  return createHash("sha1").update(input, "utf8").digest("hex").slice(0, 12);
}

/**
 * Deterministic assumption key: hash of (category, primary_entity, secondary_entity_optional, thesis_label, window_key).
 * ev_mode "capture" -> thesis NO_CARRY_CAPTURE; else NO_CARRY_BASELINE. nowTs only used for window_key.
 */
export function computeAssumptionKey(
  market: NormalizedMarket,
  ev_mode: "baseline" | "capture",
  nowTs: number
): string {
  const category = (market.category ?? "unknown").trim().toLowerCase() || "unknown";
  const primary_entity = extractPrimaryEntity(market);
  const secondary_entity_optional = ""; // v1
  const thesis_label = ev_mode === "capture" ? THESIS_CAPTURE : THESIS_BASELINE;
  const window_key = computeWindowKey(market, nowTs);
  const payload = [category, primary_entity, secondary_entity_optional, thesis_label, window_key]
    .map((x) => normalize(String(x)))
    .join("|");
  return "a1_" + stableHash(payload);
}
