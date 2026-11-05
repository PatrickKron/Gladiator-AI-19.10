import { withBinancePublic } from '@gladiator/market-data';

/**
 * Echte Orderbuch-Tiefe (Level-2 DOM wie Bookmap/TradingLite) + optionale
 * CoinGlass-Liquidations-Daten für die 2D-Chart-Heatmap.
 *
 * Grundsatz (CLAUDE.md): Kein Fake.
 * - Für Krypto (Binance) wird das echte Level-2-Orderbuch (bis zu 500 Bid- + 500 Ask-Stufen)
 *   über die öffentliche Börsen-Schnittstelle geladen und zusätzlich in einem
 *   zeitgestempelten Ringpuffer gehalten, sodass echte Orderbuch-Wände (DOM)
 *   und deren zeitlicher Verlauf im Chart sichtbar sind.
 * - Ist COINGLASS_API_KEY gesetzt, werden externe CoinGlass-Liquidations-Cluster
 *   abgerufen; ohne Key wird ehrlich `coinglass.connected = false` gemeldet.
 */

export type OrderbookWallBucket = {
  bottom: number;
  top: number;
  mid: number;
  bidUsd: number;
  askUsd: number;
  totalUsd: number;
  dominantSide: 'bid' | 'ask' | 'neutral';
  /** Normierte Intensität 0..1 relativ zur stärksten Wand im aktuellen Buch. */
  intensity: number;
};

export type RecordedOrderbookSlice = {
  /** Unix-Sekunden des Snapshots. */
  time: number;
  buckets: { mid: number; totalUsd: number; side: 'bid' | 'ask'; intensity: number }[];
};

export type CoinglassLiquidationLevel = {
  price: number;
  usd: number;
  side: 'long' | 'short';
  intensity: number;
};

export type LiveChartHeatmapData = {
  symbol: string;
  venue: string;
  orderbook: {
    connected: boolean;
    ts: number | null;
    midPrice: number | null;
    totalBidUsd: number;
    totalAskUsd: number;
    topBidWall: { price: number; usd: number } | null;
    topAskWall: { price: number; usd: number } | null;
    walls: OrderbookWallBucket[];
    history: RecordedOrderbookSlice[];
  };
  coinglass: {
    configured: boolean;
    connected: boolean;
    reason?: string;
    levels: CoinglassLiquidationLevel[];
  };
};

type RawBook = {
  ts: number;
  bids: [number, number][];
  asks: [number, number][];
};

const BOOK_CACHE_TTL_MS = 8_000;
const MAX_HISTORY_SLICES = 90;
const MIN_SLICE_INTERVAL_SEC = 30;

const bookCache = new Map<string, { at: number; book: RawBook }>();
const bookHistory = new Map<string, RecordedOrderbookSlice[]>();
const coinglassCache = new Map<string, { at: number; levels: CoinglassLiquidationLevel[]; connected: boolean; reason?: string }>();

/**
 * Aggregiert ein echtes Level-2-Orderbuch (`bids`, `asks` als `[price, qty]`)
 * in `bucketCount` Preis-Bänder (rein & deterministisch, direkt testbar).
 */
export function aggregateOrderbookWalls(
  bids: [number, number][],
  asks: [number, number][],
  bucketCount = 32,
): {
  midPrice: number | null;
  totalBidUsd: number;
  totalAskUsd: number;
  topBidWall: { price: number; usd: number } | null;
  topAskWall: { price: number; usd: number } | null;
  walls: OrderbookWallBucket[];
} {
  const validBids = bids.filter(([p, q]) => Number.isFinite(p) && p > 0 && Number.isFinite(q) && q > 0);
  const validAsks = asks.filter(([p, q]) => Number.isFinite(p) && p > 0 && Number.isFinite(q) && q > 0);
  if (validBids.length === 0 && validAsks.length === 0) {
    return { midPrice: null, totalBidUsd: 0, totalAskUsd: 0, topBidWall: null, topAskWall: null, walls: [] };
  }

  let minP = Infinity;
  let maxP = -Infinity;
  let bestBid = -Infinity;
  let bestAsk = Infinity;
  let totalBidUsd = 0;
  let totalAskUsd = 0;

  for (const [p, q] of validBids) {
    if (p < minP) minP = p;
    if (p > maxP) maxP = p;
    if (p > bestBid) bestBid = p;
    totalBidUsd += p * q;
  }
  for (const [p, q] of validAsks) {
    if (p < minP) minP = p;
    if (p > maxP) maxP = p;
    if (p < bestAsk) bestAsk = p;
    totalAskUsd += p * q;
  }

  const midPrice =
    Number.isFinite(bestBid) && Number.isFinite(bestAsk)
      ? (bestBid + bestAsk) / 2
      : Number.isFinite(bestBid)
        ? bestBid
        : Number.isFinite(bestAsk)
          ? bestAsk
          : null;

  const span = maxP - minP;
  if (!(span > 0)) {
    return { midPrice, totalBidUsd, totalAskUsd, topBidWall: null, topAskWall: null, walls: [] };
  }

  const n = Math.max(8, Math.min(80, Math.floor(bucketCount)));
  const step = span / n;
  const bidBuckets = new Float64Array(n);
  const askBuckets = new Float64Array(n);

  for (const [p, q] of validBids) {
    const idx = Math.min(n - 1, Math.max(0, Math.floor((p - minP) / step)));
    bidBuckets[idx] = (bidBuckets[idx] ?? 0) + p * q;
  }
  for (const [p, q] of validAsks) {
    const idx = Math.min(n - 1, Math.max(0, Math.floor((p - minP) / step)));
    askBuckets[idx] = (askBuckets[idx] ?? 0) + p * q;
  }

  let maxBucketUsd = 0;
  let topBidWall: { price: number; usd: number } | null = null;
  let topAskWall: { price: number; usd: number } | null = null;

  for (let i = 0; i < n; i++) {
    const bUsd = bidBuckets[i] ?? 0;
    const aUsd = askBuckets[i] ?? 0;
    const tot = bUsd + aUsd;
    if (tot > maxBucketUsd) maxBucketUsd = tot;
    const mid = minP + (i + 0.5) * step;
    if (bUsd > 0 && (!topBidWall || bUsd > topBidWall.usd)) {
      topBidWall = { price: mid, usd: Math.round(bUsd) };
    }
    if (aUsd > 0 && (!topAskWall || aUsd > topAskWall.usd)) {
      topAskWall = { price: mid, usd: Math.round(aUsd) };
    }
  }

  const walls: OrderbookWallBucket[] = [];
  for (let i = 0; i < n; i++) {
    const bidUsd = bidBuckets[i] ?? 0;
    const askUsd = askBuckets[i] ?? 0;
    const totalUsd = bidUsd + askUsd;
    if (totalUsd <= 0) continue;
    const bottom = minP + i * step;
    const top = bottom + step;
    const mid = (bottom + top) / 2;
    const dominantSide: 'bid' | 'ask' | 'neutral' =
      bidUsd > askUsd * 1.15 ? 'bid' : askUsd > bidUsd * 1.15 ? 'ask' : 'neutral';
    walls.push({
      bottom,
      top,
      mid,
      bidUsd: Math.round(bidUsd),
      askUsd: Math.round(askUsd),
      totalUsd: Math.round(totalUsd),
      dominantSide,
      intensity: maxBucketUsd > 0 ? Math.min(1, totalUsd / maxBucketUsd) : 0,
    });
  }

  return {
    midPrice,
    totalBidUsd: Math.round(totalBidUsd),
    totalAskUsd: Math.round(totalAskUsd),
    topBidWall,
    topAskWall,
    walls,
  };
}

async function fetchCoinGlassLevels(symbol: string): Promise<{
  configured: boolean;
  connected: boolean;
  reason?: string;
  levels: CoinglassLiquidationLevel[];
}> {
  const apiKey = process.env.COINGLASS_API_KEY?.trim();
  if (!apiKey) {
    return { configured: false, connected: false, reason: 'no_key', levels: [] };
  }

  const baseCoin = (symbol.split('/')[0] ?? symbol).replace(/USDT$/i, '').toUpperCase();
  const cached = coinglassCache.get(baseCoin);
  if (cached && Date.now() - cached.at < 60_000) {
    return {
      configured: true,
      connected: cached.connected,
      ...(cached.reason ? { reason: cached.reason } : {}),
      levels: cached.levels,
    };
  }

  try {
    const url = `https://open-api-v3.coinglass.com/api/futures/liquidation/order?symbol=${encodeURIComponent(baseCoin)}&exName=Binance`;
    const res = await fetch(url, {
      headers: { 'CG-API-KEY': apiKey, accept: 'application/json' },
    });
    const json = (await res.json()) as {
      code?: string;
      msg?: string;
      data?: Array<{ price?: number; volUsd?: number; side?: number | string }>;
    };
    if (!res.ok || (json.code && json.code !== '0')) {
      const reason = json.msg ?? `HTTP ${res.status}`;
      coinglassCache.set(baseCoin, { at: Date.now(), levels: [], connected: false, reason });
      return { configured: true, connected: false, reason, levels: [] };
    }

    const raw = Array.isArray(json.data) ? json.data : [];
    let maxUsd = 0;
    const parsed: { price: number; usd: number; side: 'long' | 'short' }[] = [];
    for (const item of raw) {
      const price = Number(item.price);
      const usd = Number(item.volUsd);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(usd) || usd <= 0) continue;
      if (usd > maxUsd) maxUsd = usd;
      const side: 'long' | 'short' = item.side === 1 || item.side === '1' || item.side === 'long' ? 'long' : 'short';
      parsed.push({ price, usd, side });
    }
    const levels: CoinglassLiquidationLevel[] = parsed.map((p) => ({
      ...p,
      intensity: maxUsd > 0 ? Math.min(1, p.usd / maxUsd) : 0,
    }));
    coinglassCache.set(baseCoin, { at: Date.now(), levels, connected: true });
    return { configured: true, connected: true, levels };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { configured: true, connected: false, reason, levels: [] };
  }
}

export async function loadLiveChartHeatmap(symbol: string, venue = 'binance'): Promise<LiveChartHeatmapData> {
  const normSymbol = symbol.trim().toUpperCase();
  const isBinance = venue === 'binance' && normSymbol.includes('/');

  const coinglass = isBinance
    ? await fetchCoinGlassLevels(normSymbol)
    : { configured: Boolean(process.env.COINGLASS_API_KEY), connected: false, reason: 'crypto_only', levels: [] };

  if (!isBinance) {
    return {
      symbol: normSymbol,
      venue,
      orderbook: {
        connected: false,
        ts: null,
        midPrice: null,
        totalBidUsd: 0,
        totalAskUsd: 0,
        topBidWall: null,
        topAskWall: null,
        walls: [],
        history: [],
      },
      coinglass,
    };
  }

  try {
    let cached = bookCache.get(normSymbol);
    if (!cached || Date.now() - cached.at > BOOK_CACHE_TTL_MS) {
      const ob = await withBinancePublic((ex) =>
        (ex as unknown as {
          fetchOrderBook(sym: string, limit?: number): Promise<{ timestamp?: number; bids: [number, number][]; asks: [number, number][] }>;
        }).fetchOrderBook(normSymbol, 500),
      );
      cached = {
        at: Date.now(),
        book: {
          ts: ob.timestamp ?? Date.now(),
          bids: ob.bids.map(([p, q]) => [Number(p), Number(q)] as [number, number]),
          asks: ob.asks.map(([p, q]) => [Number(p), Number(q)] as [number, number]),
        },
      };
      bookCache.set(normSymbol, cached);
    }

    const agg = aggregateOrderbookWalls(cached.book.bids, cached.book.asks, 32);
    const nowSec = Math.floor(cached.book.ts / 1000);
    const hist = bookHistory.get(normSymbol) ?? [];
    const lastSlice = hist[hist.length - 1];
    if (!lastSlice || nowSec - lastSlice.time >= MIN_SLICE_INTERVAL_SEC) {
      hist.push({
        time: nowSec,
        buckets: agg.walls
          .filter((w) => w.intensity >= 0.18)
          .map((w) => ({
            mid: w.mid,
            totalUsd: w.totalUsd,
            side: w.dominantSide === 'ask' ? 'ask' : 'bid',
            intensity: w.intensity,
          })),
      });
      if (hist.length > MAX_HISTORY_SLICES) hist.shift();
      bookHistory.set(normSymbol, hist);
    }

    return {
      symbol: normSymbol,
      venue,
      orderbook: {
        connected: agg.walls.length > 0,
        ts: cached.book.ts,
        midPrice: agg.midPrice,
        totalBidUsd: agg.totalBidUsd,
        totalAskUsd: agg.totalAskUsd,
        topBidWall: agg.topBidWall,
        topAskWall: agg.topAskWall,
        walls: agg.walls,
        history: hist,
      },
      coinglass,
    };
  } catch {
    return {
      symbol: normSymbol,
      venue,
      orderbook: {
        connected: false,
        ts: null,
        midPrice: null,
        totalBidUsd: 0,
        totalAskUsd: 0,
        topBidWall: null,
        topAskWall: null,
        walls: [],
        history: bookHistory.get(normSymbol) ?? [],
      },
      coinglass,
    };
  }
}
