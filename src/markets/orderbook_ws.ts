import WebSocket from "ws";
import type { OrderLevel, TopOfBook } from "../types";

export interface OrderbookState {
  bids: OrderLevel[];
  asks: OrderLevel[];
  timestamp: number;
}

const DEFAULT_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/";
const RECONNECT_BASE_MS = 2000;
const MAX_RECONNECT_MS = 60000;

/** In-memory orderbook per asset (token) ID. */
const books = new Map<string, OrderbookState>();

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
  return parseLevels(arr).sort((a, b) => b.price - a.price);
}
function toAskLevels(arr: Array<{ price: string; size: string }> | undefined): OrderLevel[] {
  return parseLevels(arr).sort((a, b) => a.price - b.price);
}

function updateBookFromMessage(assetId: string, msg: Record<string, unknown>): void {
  const eventType = msg.event_type as string | undefined;
  if (eventType === "book") {
    const bids = toBidLevels((msg.bids ?? msg.buys) as Array<{ price: string; size: string }>);
    const asks = toAskLevels((msg.asks ?? msg.sells) as Array<{ price: string; size: string }>);
    const ts = typeof msg.timestamp === "string" ? parseInt(msg.timestamp, 10) : Date.now();
    books.set(assetId, { bids, asks, timestamp: ts });
    return;
  }
  if (eventType === "price_change") {
    const priceChanges = msg.price_changes as Array<{
      asset_id?: string;
      best_bid?: string;
      best_ask?: string;
      price?: string;
      size?: string;
      side?: string;
    }> | undefined;
    if (Array.isArray(priceChanges)) {
      for (const pc of priceChanges) {
        const aid = (pc.asset_id ?? assetId) as string;
        const cur = books.get(aid) ?? { bids: [], asks: [], timestamp: Date.now() };
        const price = parseFloat(String(pc.price ?? 0));
        const size = parseFloat(String(pc.size ?? 0));
        const side = String(pc.side ?? "").toUpperCase();
        const bestBid = parseFloat(String(pc.best_bid ?? 0));
        const bestAsk = parseFloat(String(pc.best_ask ?? 0));
        if (side === "BUY") {
          const idx = cur.bids.findIndex((l) => l.price === price);
          if (idx >= 0) cur.bids[idx].size = size;
          else if (size > 0) cur.bids.push({ price, size });
          if (bestBid >= 0) cur.bids = cur.bids.filter((l) => l.size > 0).sort((a, b) => b.price - a.price);
        } else {
          const idx = cur.asks.findIndex((l) => l.price === price);
          if (idx >= 0) cur.asks[idx].size = size;
          else if (size > 0) cur.asks.push({ price, size });
          if (bestAsk >= 0) cur.asks = cur.asks.filter((l) => l.size > 0).sort((a, b) => a.price - b.price);
        }
        cur.timestamp = Date.now();
        books.set(aid, cur);
      }
    }
  }
}

/**
 * Get top of book for a token (NO side). Market ID is for lookup; we key by token ID in books.
 */
export function getTopOfBook(noTokenId: string | null, maxLevels: number = 5): TopOfBook | null {
  if (!noTokenId) return null;
  const state = books.get(noTokenId);
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

/** Get full depth for a token (for fill simulation). */
export function getDepth(noTokenId: string | null): OrderLevel[] {
  if (!noTokenId) return [];
  const state = books.get(noTokenId);
  if (!state) return [];
  return state.asks.slice();
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
  options: { wsUrl?: string } = {}
): { stop: () => void } {
  const wsUrl = options.wsUrl ?? DEFAULT_WS_URL;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;

  function connect(): void {
    if (stopped) return;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      console.error("[orderbook_ws] WebSocket connect error:", e);
      scheduleReconnect();
      return;
    }
    ws.on("open", () => {
      attempt = 0;
      for (const tokenId of tokenIds) {
        const msg = JSON.stringify({
          auth: {},
          type: "market",
          assets_ids: [tokenId],
        });
        ws?.send(msg);
      }
    });
    ws.on("message", (data: Buffer | string) => {
      try {
        const text = typeof data === "string" ? data : data.toString();
        const msg = JSON.parse(text) as Record<string, unknown>;
        const assetId = msg.asset_id as string | undefined;
        const market = msg.market as string | undefined;
        if (assetId) {
          updateBookFromMessage(assetId, msg);
          const state = books.get(assetId);
          if (state && market) {
            onUpdate({ assetId, marketId: market, book: state });
          }
        }
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
    const aid = book.asset_id;
    const bids = toBidLevels(book.bids);
    const asks = toAskLevels(book.asks);
    books.set(aid, { bids, asks, timestamp: Date.now() });
  }
}
