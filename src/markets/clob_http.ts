/**
 * CLOB REST helpers for top-of-book (e.g. carry HTTP fallback when WS has no book).
 * Node 18+ global fetch. LRU cache with TTL to avoid hammering.
 */

export interface HttpTopOfBook {
  noBid: number | null;
  noAsk: number | null;
  spread: number | null;
}

const CACHE_TTL_MS = 8_000;
const CACHE_MAX_SIZE = 200;

interface CacheEntry {
  data: HttpTopOfBook;
  expiry: number;
}

const cache = new Map<string, CacheEntry>();

function getCached(tokenId: string): HttpTopOfBook | null {
  const entry = cache.get(tokenId);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    cache.delete(tokenId);
    return null;
  }
  return entry.data;
}

function setCached(tokenId: string, data: HttpTopOfBook): void {
  while (cache.size >= CACHE_MAX_SIZE && cache.size > 0) {
    const firstKey = cache.keys().next().value;
    if (firstKey != null) cache.delete(firstKey);
    else break;
  }
  cache.set(tokenId, { data, expiry: Date.now() + CACHE_TTL_MS });
}

/**
 * Fetch top-of-book for a token from Polymarket CLOB REST (GET /book?token_id=...).
 * Returns null on non-200 or parse failure. Uses in-memory LRU cache with TTL (default 8s).
 */
export async function fetchTopOfBookHttp(
  tokenId: string,
  baseUrl?: string
): Promise<HttpTopOfBook | null> {
  const key = (tokenId ?? "").trim().replace(/[^0-9]/g, "") || tokenId;
  if (!key) return null;

  const cached = getCached(key);
  if (cached) return cached;

  const base = baseUrl ?? process.env.CLOB_HTTP_BASE ?? "https://clob.polymarket.com";
  const url = `${base.replace(/\/$/, "")}/book?token_id=${encodeURIComponent(key)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      bids?: Array<{ price: string; size: string }>;
      asks?: Array<{ price: string; size: string }>;
    };
    if (!json || typeof json !== "object") return null;

    const bids = Array.isArray(json.bids) ? json.bids : [];
    const asks = Array.isArray(json.asks) ? json.asks : [];
    let noBid: number | null = null;
    let noAsk: number | null = null;
    for (const b of bids) {
      const p = parseFloat(b?.price);
      if (!Number.isNaN(p) && (noBid == null || p > noBid)) noBid = p;
    }
    for (const a of asks) {
      const p = parseFloat(a?.price);
      if (!Number.isNaN(p) && (noAsk == null || p < noAsk)) noAsk = p;
    }
    const spread =
      noBid != null && noAsk != null && noAsk >= noBid ? noAsk - noBid : null;
    const data: HttpTopOfBook = { noBid, noAsk, spread };
    setCached(key, data);
    return data;
  } catch {
    return null;
  }
}
