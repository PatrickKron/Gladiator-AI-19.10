/**
 * Yahoo-Finance-Chart-API (öffentlich, kein Key): Aktien/ETF/Indizes —
 * inkl. der Makro-Symbole ^VIX, DX-Y.NYB (Dollar-Index), ^TNX (US-10Y-Rendite).
 * NUR echte Antworten werden verwendet; Fehler ⇒ null/Exception, nie Ersatzwerte.
 */

export type YahooChart = {
  symbol: string;
  price: number;
  previousClose: number | null;
  currency: string | null;
  points: { ts: Date; close: number }[];
};

/** Makro-Symbole für den GRS (Aegis): echte Yahoo-Ticker. */
export const MACRO_SYMBOLS = {
  VIX: '^VIX',
  DXY: 'DX-Y.NYB',
  US10Y: '^TNX',
} as const;

export type MacroSeriesId = keyof typeof MACRO_SYMBOLS;

/** Parst die v8/chart-Antwort. Ungültig/Fehler ⇒ null. Null-Closes werden übersprungen. */
export function parseYahooChart(json: unknown): YahooChart | null {
  const root = json as { chart?: { result?: unknown[] | null; error?: unknown } } | null;
  const result = root?.chart?.result?.[0] as
    | {
        meta?: { symbol?: string; regularMarketPrice?: number; previousClose?: number; chartPreviousClose?: number; currency?: string };
        timestamp?: number[];
        indicators?: { quote?: { close?: (number | null)[] }[] };
      }
    | undefined;
  if (!result?.meta?.symbol || typeof result.meta.regularMarketPrice !== 'number') return null;

  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const points: { ts: Date; close: number }[] = [];
  for (let i = 0; i < Math.min(timestamps.length, closes.length); i++) {
    const close = closes[i];
    if (typeof close === 'number' && Number.isFinite(close)) {
      points.push({ ts: new Date(timestamps[i]! * 1000), close });
    }
  }

  return {
    symbol: result.meta.symbol,
    price: result.meta.regularMarketPrice,
    previousClose: result.meta.previousClose ?? result.meta.chartPreviousClose ?? null,
    currency: result.meta.currency ?? null,
    points,
  };
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

/** Holt Chart-Daten (range z. B. '3mo', interval '1d'). Wirft bei HTTP-Fehlern. */
export async function fetchYahooChart(symbol: string, range = '3mo', interval = '1d'): Promise<YahooChart | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Yahoo ${symbol}: HTTP ${res.status}`);
  return parseYahooChart(await res.json());
}

// ── Aktien-/ETF-Quotes mit In-Memory-Cache (Pakete-Seite) ────────────────

export type StockQuote = { symbol: string; price: number; previousClose: number | null; currency: string | null; ts: Date };

const quoteCache = new Map<string, { quote: StockQuote | null; fetchedAt: number }>();
const QUOTE_TTL_MS = 5 * 60_000;

/** Einzel-Quote mit 5-min-Cache. Unbekanntes Symbol ⇒ ehrlich null (kein Kurs). */
export async function getStockQuote(symbol: string): Promise<StockQuote | null> {
  const cached = quoteCache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < QUOTE_TTL_MS) return cached.quote;
  let quote: StockQuote | null = null;
  try {
    const chart = await fetchYahooChart(symbol, '1d', '1h');
    if (chart) {
      quote = { symbol, price: chart.price, previousClose: chart.previousClose, currency: chart.currency, ts: new Date() };
    }
  } catch {
    quote = null; // ehrlich: kein Kurs verfügbar
  }
  quoteCache.set(symbol, { quote, fetchedAt: Date.now() });
  return quote;
}

/** Batch mit begrenzter Parallelität (Rücksicht auf die öffentliche API). */
export async function getStockQuotes(symbols: string[]): Promise<Record<string, StockQuote | null>> {
  const out: Record<string, StockQuote | null> = {};
  const CONCURRENCY = 4;
  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((s) => getStockQuote(s)));
    batch.forEach((s, j) => (out[s] = results[j]!));
  }
  return out;
}
