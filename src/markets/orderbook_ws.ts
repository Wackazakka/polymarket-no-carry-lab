import WebSocket from "ws";
import type { OrderLevel, TopOfBook } from "../types";

export interface OrderbookState {
  bids: OrderLevel[];
  asks: OrderLevel[];
  timestamp: number;
}

const RECONNECT_BASE_MS = 2000;
const MAX_RECONNECT_MS = 60000;
const MAX_DEPTH_PER_SIDE = 50;

/** In-memory orderbook per asset (token) ID. Keys are normalized (digits only) to match CLOB asset_id. */
const books = new Map<string, OrderbookState>();

/** Canonical key for storage/lookup: digits only. Aligns WS snapshot asset_id with candidate noTokenId. */
export function normalizeBookKey(tokenId: string | null): string {
  if (!tokenId) return "";
  return String(tokenId).trim().replace(/[^0-9]/g, "");
}

function parseLevels(arr: Array<{ price: string; size: string }> | undefined): OrderLevel[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => ({
      price: parseFloat(String(x.price)),
      size: parseFloat(String(x.size)),
    }))
    .filter((x) => !Number.isNaN(x.price) && !Number.isNaN(x.size));
}

function toBidLevels(arr: Array<{ price: string; size: string }> | undefined): OrderLevel[] {
  return parseLevels(arr).sort((a, b) => b.price - a.price).slice(0, MAX_DEPTH_PER_SIDE);
}
function toAskLevels(arr: Array<{ price: string; size: string }> | undefined): OrderLevel[] {
  return parseLevels(arr).sort((a, b) => a.price - b.price).slice(0, MAX_DEPTH_PER_SIDE);
}

function applySnapshot(assetId: string, item: Record<string, unknown>): void {
  const key = normalizeBookKey(assetId);
  if (!key) return;
  const bids = toBidLevels((item.bids ?? item.buys) as Array<{ price: string; size: string }>);
  const asks = toAskLevels((item.asks ?? item.sells) as Array<{ price: string; size: string }>);
  books.set(key, { bids, asks, timestamp: Date.now() });
  console.log("[orderbook_ws] snapshot applied for asset_id=" + key + " bids=" + bids.length + " asks=" + asks.length);
}

function applyPriceChange(
  cur: OrderbookState,
  price: number,
  sizeNum: number,
  side: string
): OrderbookState {
  const bids = cur.bids.slice();
  const asks = cur.asks.slice();
  if (side === "BUY") {
    const idx = bids.findIndex((l) => l.price === price);
    if (sizeNum === 0) {
      if (idx >= 0) bids.splice(idx, 1);
    } else {
      if (idx >= 0) bids[idx].size = sizeNum;
      else bids.push({ price, size: sizeNum });
    }
    bids.sort((a, b) => b.price - a.price);
    return { bids: bids.slice(0, MAX_DEPTH_PER_SIDE), asks, timestamp: Date.now() };
  } else {
    const idx = asks.findIndex((l) => l.price === price);
    if (sizeNum === 0) {
      if (idx >= 0) asks.splice(idx, 1);
    } else {
      if (idx >= 0) asks[idx].size = sizeNum;
      else asks.push({ price, size: sizeNum });
    }
    asks.sort((a, b) => a.price - b.price);
    return { bids, asks: asks.slice(0, MAX_DEPTH_PER_SIDE), timestamp: Date.now() };
  }
}

function handleMessage(msg: unknown, onUpdate: (update: OrderbookUpdate) => void): void {
  if (Array.isArray(msg)) {
    for (const item of msg) {
      const o = item as Record<string, unknown>;
      const assetId = o.asset_id as string | undefined;
      const key = normalizeBookKey(assetId ?? "");
      if (!key) continue;
      const hasBook = (o.bids && Array.isArray(o.bids)) || (o.asks && Array.isArray(o.asks)) || (o.buys && Array.isArray(o.buys)) || (o.sells && Array.isArray(o.sells));
      if (hasBook) {
        applySnapshot(assetId ?? "", o);
        const state = books.get(key);
        if (state) onUpdate({ assetId: key, marketId: (o.market as string) ?? "", book: state });
      }
    }
    return;
  }

  const obj = msg as Record<string, unknown>;
  const priceChanges = obj.price_changes as Array<{ asset_id?: string; price?: string; size?: string; side?: string }> | undefined;
  if (Array.isArray(priceChanges)) {
    for (const pc of priceChanges) {
      const aid = (pc.asset_id ?? obj.asset_id) as string;
      const key = normalizeBookKey(aid);
      if (!key) continue;
      const price = parseFloat(String(pc.price ?? 0));
      const sizeStr = String(pc.size ?? "0");
      const sizeNum = parseFloat(sizeStr);
      const side = String(pc.side ?? "").toUpperCase();
      if (Number.isNaN(price)) continue;
      const cur = books.get(key) ?? { bids: [], asks: [], timestamp: Date.now() };
      const next = applyPriceChange(cur, price, sizeNum, side);
      books.set(key, next);
      onUpdate({ assetId: key, marketId: (obj.market as string) ?? "", book: next });
    }
    return;
  }

  const assetId = obj.asset_id as string | undefined;
  const key = normalizeBookKey(assetId ?? "");
  if (!key) return;
  const hasBook = (obj.bids && Array.isArray(obj.bids)) || (obj.asks && Array.isArray(obj.asks)) || (obj.buys && Array.isArray(obj.buys)) || (obj.sells && Array.isArray(obj.sells));
  if (hasBook) {
    applySnapshot(assetId ?? "", obj);
    const state = books.get(key);
    if (state) onUpdate({ assetId: key, marketId: (obj.market as string) ?? "", book: state });
  }
}

/**
 * Get top of book for a token (NO side). Lookup uses same normalized key (asset_id) as WS/REST.
 */
export function getTopOfBook(noTokenId: string | null, maxLevels: number = 5): TopOfBook | null {
  if (!noTokenId) return null;
  const key = normalizeBookKey(noTokenId);
  if (!key) return null;
  const state = books.get(key);
  if (!state) return null;
  const bids = state.bids.slice(0, maxLevels);
  const asks = state.asks.slice(0, maxLevels);
  const noBid = bids.length > 0 ? bids[0].price : null;
  const noAsk = asks.length > 0 ? asks[0].price : null;
  const spread = noBid != null && noAsk != null ? noAsk - noBid : null;
  const bidLiquidityUsd = bids.reduce((s, l) => s + l.price * l.size, 0);
  const askLiquidityUsd = asks.reduce((s, l) => s + l.price * l.size, 0);
  return {
    noBid,
    noAsk,
    spread,
    depthSummary: {
      bidLiquidityUsd,
      askLiquidityUsd,
      levels: Math.max(bids.length, asks.length),
    },
  };
}

/** Get full depth for a token (for fill simulation). Default "asks" for buying NO; use "bids" for selling (exits). */
export function getDepth(
  noTokenId: string | null,
  side: "bids" | "asks" = "asks"
): OrderLevel[] {
  if (!noTokenId) return [];
  const key = normalizeBookKey(noTokenId);
  if (!key) return [];
  const state = books.get(key);
  if (!state) return [];
  return (side === "asks" ? state.asks : state.bids).slice();
}

/** Debug: hasKey (using same normalized lookup), sample keys, size. */
export function getBooksDebug(): { hasKey: (tokenId: string | null) => boolean; sampleKeys: string[]; size: number } {
  const keys = [...books.keys()];
  return {
    hasKey: (tokenId: string | null) => (normalizeBookKey(tokenId) ? books.has(normalizeBookKey(tokenId)) : false),
    sampleKeys: keys.slice(0, 3),
    size: books.size,
  };
}

/** Test-only: inject book state for a token. No-op when NODE_ENV !== "test". */
export function setBookForTest(tokenId: string, bids: OrderLevel[], asks: OrderLevel[]): void {
  if (process.env.NODE_ENV !== "test") return;
  const key = normalizeBookKey(tokenId);
  if (!key) return;
  const bidsSorted = bids.slice().sort((a, b) => b.price - a.price);
  const asksSorted = asks.slice().sort((a, b) => a.price - b.price);
  books.set(key, { bids: bidsSorted, asks: asksSorted, timestamp: Date.now() });
}

export interface OrderbookUpdate {
  assetId: string;
  marketId: string;
  book: OrderbookState;
}

/**
 * Start WebSocket stream for given token IDs (NO token IDs). Subscribes to "market" channel.
 * Reconnects with backoff. Calls onUpdate when book data arrives.
 */
export function startOrderbookStream(
  tokenIds: string[],
  onUpdate: (update: OrderbookUpdate) => void,
  options: { wsUrl: string }
): { stop: () => void } {
  const wsUrl = options.wsUrl;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;

  function connect(): void {
    if (stopped) return;
    console.log("[orderbook_ws] Connecting to", wsUrl);
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      console.error("[orderbook_ws] WebSocket connect error:", e);
      scheduleReconnect();
      return;
    }
    ws.on("open", () => {
      attempt = 0;
      const msg = { type: "MARKET", assets_ids: tokenIds };
      ws?.send(JSON.stringify(msg));
      console.log("[orderbook_ws] [diagnostic] Sent initial subscribe, assets_ids count:", tokenIds.length);
    });
    let msgLogCount = 0;
    const MAX_DIAG_LOGS = 5;
    const TRUNCATE_LEN = 300;
    ws.on("message", (data: Buffer | string) => {
      try {
        const text = typeof data === "string" ? data : data.toString();
        if (msgLogCount < MAX_DIAG_LOGS) {
          msgLogCount++;
          const truncated = text.length > TRUNCATE_LEN ? text.slice(0, TRUNCATE_LEN) + "…" : text;
          console.log(`[orderbook_ws] [diagnostic] msg#${msgLogCount} ${truncated}`);
        }
        const msg = JSON.parse(text) as unknown;
        handleMessage(msg, onUpdate);
      } catch {
        // ignore parse errors
      }
    });
    ws.on("error", (err) => {
      console.error("[orderbook_ws] WS error:", err.message);
    });
    ws.on("close", () => {
      ws = null;
      if (!stopped) scheduleReconnect();
    });
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, MAX_RECONNECT_MS);
    attempt++;
    console.warn(`[orderbook_ws] Reconnecting in ${delay}ms (attempt ${attempt})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  connect();

  return {
    stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        ws.close();
        ws = null;
      }
    },
  };
}

/**
 * Fetch orderbook snapshot via REST (POST /books) for given token IDs.
 * Use to prime in-memory books before or instead of WS.
 */
export async function fetchOrderbookSnapshot(
  clobRestBaseUrl: string,
  tokenIds: string[]
): Promise<void> {
  if (tokenIds.length === 0) return;
  const url = `${clobRestBaseUrl.replace(/\/$/, "")}/books`;
  const body = tokenIds.map((id) => ({ token_id: id }));
  const { request } = await import("undici");
  const { statusCode, body: resBody } = await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (statusCode !== 200) {
    console.warn("[orderbook_ws] REST books returned", statusCode);
    return;
  }
  const json = (await resBody.json()) as Array<{
    asset_id: string;
    bids?: Array<{ price: string; size: string }>;
    asks?: Array<{ price: string; size: string }>;
  }>;
  if (!Array.isArray(json)) return;
  for (const book of json) {
    const key = normalizeBookKey(book.asset_id);
    if (!key) continue;
    const bids = toBidLevels(book.bids);
    const asks = toAskLevels(book.asks);
    books.set(key, { bids, asks, timestamp: Date.now() });
  }
}
