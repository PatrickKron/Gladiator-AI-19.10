import { TV_SYMBOL_MAP, CBOE_SYMBOL_MAP } from './tv-symbol-map.js';

/**
 * Live-Quotes für ALLE Katalog-Assets (221) aus drei verifizierten
 * keyless-Quellen — jede Quelle fällt einzeln ehrlich aus (null je Asset),
 * nie erfundene Werte:
 *   CRYPTO       → Binance REST /api/v3/ticker/24hr (Batch, ein Call)
 *   Aktien/ETF/  → TradingView-Scanner (Batch-POST; Yahoo blockt die
 *   Index/Future    Server-IP hart mit 429 — deshalb TV)
 *   VVIX/GVZ     → CBOE-Delayed-Quotes (fehlen im TV-Scanner)
 */

export type QuoteAsset = { ticker: string; assetType: string; tradingPair: string | null };

export type AssetQuote = {
  ticker: string;
  price: number;
  /** Änderung in % (24 h bei Krypto, Handelstag sonst); null wenn Quelle keine liefert. */
  changePct: number | null;
  /** ISO-Währungscode der Quelle (EUR/JPY/… bei Auslandsbörsen); USX = US-Cent. */
  currency: string | null;
  source: 'binance' | 'tradingview' | 'cboe';
  ts: string;
};

export type QuoteSource =
  | { kind: 'binance'; symbol: string }
  | { kind: 'tradingview'; symbol: string }
  | { kind: 'cboe'; symbol: string }
  | null;

/** Krypto-Paar → Binance-REST-Symbol ("BTC/USDT" → "BTCUSDT"). */
export function binanceRestSymbol(tradingPair: string | null | undefined): string | null {
  if (!tradingPair) return null;
  const upper = tradingPair.toUpperCase().trim().replace('/', '');
  return /^[A-Z0-9]{5,20}$/.test(upper) ? upper : null;
}

/** Verifizierte Quelle je Asset; null = ehrlich „keine Quelle" (wird so angezeigt). */
export function quoteSourceFor(asset: QuoteAsset): QuoteSource {
  const key = `${asset.assetType.toUpperCase()}:${asset.ticker.toUpperCase()}`;
  const cboe = CBOE_SYMBOL_MAP[key];
  if (cboe) return { kind: 'cboe', symbol: cboe };
  const tv = TV_SYMBOL_MAP[key];
  if (tv) return { kind: 'tradingview', symbol: tv };
  if (asset.assetType.toUpperCase() === 'CRYPTO') {
    const sym = binanceRestSymbol(asset.tradingPair);
    if (sym) return { kind: 'binance', symbol: sym };
  }
  return null;
}

// ── Parser (pure, getestet) ──────────────────────────────────────────────

export type RawQuote = { price: number; changePct: number | null; currency: string | null };

/** Parst die Scanner-Antwort (columns: name,close,change,currency,description). */
export function parseTvScanResponse(json: unknown): Map<string, RawQuote> {
  const out = new Map<string, RawQuote>();
  const data = (json as { data?: { s?: string; d?: unknown[] }[] } | null)?.data;
  if (!Array.isArray(data)) return out;
  for (const row of data) {
    if (!row || typeof row.s !== 'string') continue;
    const close = row.d?.[1];
    if (typeof close !== 'number' || !Number.isFinite(close)) continue;
    const change = row.d?.[2];
    const currency = row.d?.[3];
    out.set(row.s, {
      price: close,
      changePct: typeof change === 'number' && Number.isFinite(change) ? change : null,
      currency: typeof currency === 'string' ? currency : null,
    });
  }
  return out;
}

/** Parst /api/v3/ticker/24hr-Batch (Array aus {symbol,lastPrice,priceChangePercent}). */
export function parseBinanceTickers(json: unknown): Map<string, RawQuote> {
  const out = new Map<string, RawQuote>();
  if (!Array.isArray(json)) return out;
  for (const row of json as { symbol?: string; lastPrice?: string; priceChangePercent?: string }[]) {
    const price = Number(row.lastPrice);
    if (typeof row.symbol !== 'string' || !Number.isFinite(price) || price <= 0) continue;
    const change = Number(row.priceChangePercent);
    out.set(row.symbol, { price, changePct: Number.isFinite(change) ? change : null, currency: 'USDT' });
  }
  return out;
}

/** Parst eine CBOE-Delayed-Quote ({data:{current_price,price_change_percent}}). */
export function parseCboeQuote(json: unknown): RawQuote | null {
  const d = (json as { data?: { current_price?: number; price_change_percent?: number } } | null)?.data;
  if (!d || typeof d.current_price !== 'number' || !Number.isFinite(d.current_price) || d.current_price <= 0) return null;
  return {
    price: d.current_price,
    changePct: typeof d.price_change_percent === 'number' && Number.isFinite(d.price_change_percent) ? d.price_change_percent : null,
    currency: 'USD',
  };
}

// ── Fetcher mit In-Memory-Cache ─────────────────────────────────────────

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const TV_CHUNK = 300;
const CACHE_TTL_MS = 60_000; // TV/CBOE: Delayed-Quotes, 60 s reichen
const BINANCE_TTL_MS = 15_000;

type CacheEntry = { quote: RawQuote | null; fetchedAt: number };
const cache = new Map<string, CacheEntry>(); // Key: `${kind}:${symbol}`

/** Nur für Tests: Cache leeren. */
export function clearQuoteCacheForTests(): void {
  cache.clear();
}

function cached(kind: string, symbol: string, ttl: number): RawQuote | null | undefined {
  const e = cache.get(`${kind}:${symbol}`);
  if (e && Date.now() - e.fetchedAt < ttl) return e.quote;
  return undefined;
}

function store(kind: string, symbol: string, quote: RawQuote | null): void {
  cache.set(`${kind}:${symbol}`, { quote, fetchedAt: Date.now() });
}

async function fetchTvQuotes(symbols: string[]): Promise<Map<string, RawQuote | null>> {
  const out = new Map<string, RawQuote | null>();
  const misses: string[] = [];
  for (const s of symbols) {
    const hit = cached('tv', s, CACHE_TTL_MS);
    if (hit !== undefined) out.set(s, hit);
    else misses.push(s);
  }
  for (let i = 0; i < misses.length; i += TV_CHUNK) {
    const chunk = misses.slice(i, i + TV_CHUNK);
    const res = await fetch('https://scanner.tradingview.com/global/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ symbols: { tickers: chunk, query: { types: [] } }, columns: ['name', 'close', 'change', 'currency', 'description'] }),
    });
    if (!res.ok) throw new Error(`TradingView-Scanner: HTTP ${res.status}`);
    const parsed = parseTvScanResponse(await res.json());
    for (const s of chunk) {
      const q = parsed.get(s) ?? null; // Scanner lässt unbekannte Symbole still weg → ehrlich null
      store('tv', s, q);
      out.set(s, q);
    }
  }
  return out;
}

async function fetchBinanceQuotes(symbols: string[]): Promise<Map<string, RawQuote | null>> {
  const out = new Map<string, RawQuote | null>();
  const misses: string[] = [];
  for (const s of symbols) {
    const hit = cached('binance', s, BINANCE_TTL_MS);
    if (hit !== undefined) out.set(s, hit);
    else misses.push(s);
  }
  if (misses.length > 0) {
    // Ein unbekanntes Symbol lässt den Batch mit 400 platzen → dann einzeln nachfassen.
    const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(misses))}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) {
      const parsed = parseBinanceTickers(await res.json());
      for (const s of misses) {
        const q = parsed.get(s) ?? null;
        store('binance', s, q);
        out.set(s, q);
      }
    } else {
      for (const s of misses) {
        try {
          const single = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(s)}`, { headers: { 'User-Agent': UA } });
          const q = single.ok ? (parseBinanceTickers([await single.json()]).get(s) ?? null) : null;
          store('binance', s, q);
          out.set(s, q);
        } catch {
          store('binance', s, null);
          out.set(s, null);
        }
      }
    }
  }
  return out;
}

async function fetchCboeQuotes(symbols: string[]): Promise<Map<string, RawQuote | null>> {
  const out = new Map<string, RawQuote | null>();
  for (const s of symbols) {
    const hit = cached('cboe', s, CACHE_TTL_MS);
    if (hit !== undefined) {
      out.set(s, hit);
      continue;
    }
    try {
      const res = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/quotes/${encodeURIComponent(s)}.json`, { headers: { 'User-Agent': UA } });
      const q = res.ok ? parseCboeQuote(await res.json()) : null;
      store('cboe', s, q);
      out.set(s, q);
    } catch {
      store('cboe', s, null);
      out.set(s, null);
    }
  }
  return out;
}

/**
 * Quotes für eine Asset-Liste — gruppiert nach Quelle, jede Quelle isoliert
 * (eine tote Quelle liefert null für ihre Assets, blockiert die anderen nicht).
 */
export async function getAssetQuotes(assetList: QuoteAsset[]): Promise<Record<string, AssetQuote | null>> {
  const bySource = { binance: new Map<string, string[]>(), tradingview: new Map<string, string[]>(), cboe: new Map<string, string[]>() };
  const out: Record<string, AssetQuote | null> = {};
  for (const a of assetList) {
    const src = quoteSourceFor(a);
    out[a.ticker] = null;
    if (!src) continue;
    const group = bySource[src.kind];
    const tickers = group.get(src.symbol) ?? [];
    tickers.push(a.ticker);
    group.set(src.symbol, tickers);
  }
  const ts = new Date().toISOString();

  const apply = (source: AssetQuote['source'], group: Map<string, string[]>, quotes: Map<string, RawQuote | null>) => {
    for (const [symbol, tickers] of group) {
      const q = quotes.get(symbol);
      if (!q) continue;
      for (const ticker of tickers) out[ticker] = { ticker, price: q.price, changePct: q.changePct, currency: q.currency, source, ts };
    }
  };

  const [binance, tv, cboe] = await Promise.allSettled([
    bySource.binance.size > 0 ? fetchBinanceQuotes([...bySource.binance.keys()]) : Promise.resolve(new Map<string, RawQuote | null>()),
    bySource.tradingview.size > 0 ? fetchTvQuotes([...bySource.tradingview.keys()]) : Promise.resolve(new Map<string, RawQuote | null>()),
    bySource.cboe.size > 0 ? fetchCboeQuotes([...bySource.cboe.keys()]) : Promise.resolve(new Map<string, RawQuote | null>()),
  ]);
  if (binance.status === 'fulfilled') apply('binance', bySource.binance, binance.value);
  if (tv.status === 'fulfilled') apply('tradingview', bySource.tradingview, tv.value);
  if (cboe.status === 'fulfilled') apply('cboe', bySource.cboe, cboe.value);
  return out;
}
