import { request } from "undici";
import type { NormalizedMarket } from "../types";

export interface PolymarketProvider {
  fetchActiveMarkets(limit: number, offset: number): Promise<NormalizedMarket[]>;
}

/** Gamma API market shape (subset we use). */
interface GammaMarket {
  id?: string;
  conditionId?: string;
  question?: string;
  slug?: string;
  endDate?: string;
  endDateIso?: string;
  category?: string;
  description?: string;
  outcomes?: string;
  liquidityNum?: number;
  closed?: boolean;
  clobTokenIds?: string;
  resolutionSource?: string;
  [k: string]: unknown;
}

/** Gamma API event shape (events contain markets). */
interface GammaEvent {
  id?: string;
  title?: string;
  description?: string;
  endDate?: string;
  markets?: GammaMarket[];
  [k: string]: unknown;
}

function parseOutcomes(outcomes: string | undefined): string[] {
  if (!outcomes) return ["Yes", "No"];
  try {
    const parsed = JSON.parse(outcomes) as unknown;
    return Array.isArray(parsed) ? parsed as string[] : ["Yes", "No"];
  } catch {
    return ["Yes", "No"];
  }
}

function parseClobTokenIds(clobTokenIds: string | undefined): { yes: string | null; no: string | null } {
  if (!clobTokenIds || typeof clobTokenIds !== "string") return { yes: null, no: null };
  const parts = clobTokenIds.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { yes: parts[0], no: parts[1] };
  }
  return { yes: parts[0] ?? null, no: null };
}

function marketToNormalized(m: GammaMarket): NormalizedMarket {
  const tokens = parseClobTokenIds(m.clobTokenIds);
  let resolutionTime: Date | null = null;
  const endStr = m.endDateIso ?? m.endDate;
  if (endStr) {
    const d = new Date(endStr);
    if (!Number.isNaN(d.getTime())) resolutionTime = d;
  }
  return {
    marketId: String(m.conditionId ?? m.id ?? ""),
    conditionId: String(m.conditionId ?? m.id ?? ""),
    question: m.question ?? "",
    title: m.question ?? "",
    outcomes: parseOutcomes(m.outcomes),
    resolutionTime,
    endDateIso: endStr ?? null,
    category: m.category ?? null,
    description: m.description ?? null,
    rulesText: [m.description, m.resolutionSource].filter(Boolean).join("\n") || null,
    noTokenId: tokens.no,
    yesTokenId: tokens.yes,
    liquidityNum: typeof m.liquidityNum === "number" ? m.liquidityNum : null,
    closed: Boolean(m.closed),
  };
}

async function fetchEventsPage(
  gammaBaseUrl: string,
  limit: number,
  offset: number
): Promise<GammaEvent[]> {
  const url = `${gammaBaseUrl.replace(/\/$/, "")}/events?closed=false&limit=${limit}&offset=${offset}&order=id&ascending=false`;
  const { statusCode, body } = await request(url, { method: "GET" });
  if (statusCode !== 200) {
    throw new Error(`Gamma API returned ${statusCode}`);
  }
  const json = (await body.json()) as unknown;
  if (!Array.isArray(json)) return [];
  return json as GammaEvent[];
}

/**
 * Flatten events into markets. Each event can have multiple markets.
 */
function eventsToMarkets(events: GammaEvent[]): NormalizedMarket[] {
  const out: NormalizedMarket[] = [];
  for (const ev of events) {
    const markets = ev.markets ?? [];
    for (const m of markets) {
      if (m.conditionId || m.id) {
        out.push(marketToNormalized(m));
      }
    }
  }
  return out;
}

/**
 * Fetch active markets from Gamma API (read-only). Uses events endpoint as recommended.
 * Normalizes to internal NormalizedMarket type.
 */
export async function fetchActiveMarkets(
  gammaBaseUrl: string,
  options: { limit?: number; maxPages?: number } = {}
): Promise<NormalizedMarket[]> {
  const limit = options.limit ?? 100;
  const maxPages = options.maxPages ?? 5;
  const all: NormalizedMarket[] = [];
  let offset = 0;
  let page = 0;
  while (page < maxPages) {
    const events = await fetchEventsPage(gammaBaseUrl, limit, offset);
    const markets = eventsToMarkets(events);
    for (const m of markets) {
      if (!m.closed && m.noTokenId) all.push(m);
    }
    if (events.length < limit) break;
    offset += limit;
    page++;
  }
  return all;
}
