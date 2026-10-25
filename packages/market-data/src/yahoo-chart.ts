import type { Db } from '@gladiator/db';
import { sanitizeCandles, type RawOhlcv } from './candles.js';
import { candleRows, upsertCandles } from './candle-store.js';

/**
 * Yahoo v8 Chart-Endpoint (query1.finance.yahoo.com/v8/finance/chart) —
 * echter historischer OHLCV-Feed für Aktien/ETF/Indizes/Rohstoffe OHNE API-Key
 * (Reverse-Engineering, Patricks bevorzugter Weg). Es ist ein öffentlicher
 * JSON-Endpoint mit Rate-Limit (kein Bot-PoW wie Stooq) — mit User-Agent und
 * schonendem Tempo legitim nutzbar. NUR echte Antworten; fehlende Bars (null)
 * werden übersprungen, nie interpoliert (eiserne Regel 1).
 *
 * Venue in der OHLCV-Hypertable: 'yahoo' (getrennt von 'binance'/'twelvedata'),
 * damit Aktien-Kerzen die Krypto-Kerzen nie überschreiben.
 */

export const YAHOO_VENUE = 'yahoo';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/**
 * App-Timeframe (SUPPORTED_TIMEFRAMES) → Yahoo-Intervall. Für Aktien primär Tageskerzen.
 * Wochenkerzen heißen in der App '1w' (früher fälschlich als '1wk' gespeichert — Migration 0043).
 */
const YAHOO_INTERVAL: Record<string, string> = {
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '60m',
  '1d': '1d',
  '1w': '1wk',
  '1M': '1mo',
};

export function yahooIntervalFor(timeframe: string): string {
  return YAHOO_INTERVAL[timeframe] ?? '1d';
}

/**
 * Erstladung eines Yahoo-Assets (Asset-Register): Tageskerzen 5 Jahre, Stundenkerzen 1 Jahr
 * (Yahoo-Grenze für 60m: 730 Tage), 15-min-Kerzen 60 Tage (Yahoo-Grenze für Intraday).
 * 4h gibt es bei Yahoo nicht, und eine Aggregation aus 1h gibt es im Code (noch) nicht —
 * deshalb ehrlich kein 4h statt erfundener Bündelung.
 */
export const YAHOO_LOAD_PLAN: { timeframe: string; range: string }[] = [
  { timeframe: '1d', range: '5y' },
  { timeframe: '1h', range: '1y' },
  { timeframe: '15m', range: '60d' },
];

const RANGE_DAYS: Record<string, number> = { '1d': 1, '5d': 5, '1mo': 31, '60d': 60, '3mo': 92, '6mo': 183, '1y': 366, '2y': 731, '5y': 1827 };
/** Erlaubte Fenster je Zeitrahmen, klein → groß (das größte = Yahoo-Grenze bzw. Erstladung). */
const REFRESH_LADDER: Record<string, string[]> = {
  '15m': ['1d', '5d', '1mo', '60d'],
  '1h': ['5d', '1mo', '3mo', '6mo', '1y'],
  '1d': ['1mo', '3mo', '6mo', '1y', '2y', '5y'],
};

/**
 * Inkrementeller Refresh (Kerzen-Job alle 15 min): das kleinste Yahoo-`range`, das die Lücke
 * seit der letzten Kerze plus eine Kerzenlänge deckt — schont das Rate-Limit. Nie größer als
 * Yahoo je Intervall erlaubt; ohne Kerze das Erstlade-Fenster. Rein/testbar.
 */
export function yahooRefreshRange(timeframe: string, lastTs: Date | null, now: Date = new Date()): string {
  const ladder = REFRESH_LADDER[timeframe] ?? REFRESH_LADDER['1d']!;
  const largest = ladder[ladder.length - 1]!;
  if (!lastTs) return largest;
  const intervalMs = timeframe === '15m' ? 900_000 : timeframe === '1h' ? 3_600_000 : 86_400_000;
  const needDays = (now.getTime() - lastTs.getTime() + intervalMs) / 86_400_000;
  return ladder.find((r) => RANGE_DAYS[r]! >= needDays) ?? largest;
}

/** Echte Instrument-Metadaten aus dem Chart-Block (nur was Yahoo schickt, sonst null). */
export type YahooChartMeta = { symbol: string | null; instrumentType: string | null; name: string | null; currency: string | null; exchange: string | null };

export type YahooOhlcvParse = { ok: true; candles: RawOhlcv[]; meta: YahooChartMeta | null } | { ok: false; error: string };

type YahooQuote = {
  open?: (number | null)[];
  high?: (number | null)[];
  low?: (number | null)[];
  close?: (number | null)[];
  volume?: (number | null)[];
};
type YahooMetaRaw = { symbol?: unknown; instrumentType?: unknown; longName?: unknown; shortName?: unknown; currency?: unknown; fullExchangeName?: unknown; exchangeName?: unknown };
type YahooResult = { meta?: YahooMetaRaw; timestamp?: number[]; indicators?: { quote?: YahooQuote[] } };

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function parseMeta(m: YahooMetaRaw | undefined): YahooChartMeta | null {
  if (!m || typeof m !== 'object') return null;
  return {
    symbol: str(m.symbol),
    instrumentType: str(m.instrumentType)?.toUpperCase() ?? null,
    name: str(m.longName) ?? str(m.shortName),
    currency: str(m.currency),
    exchange: str(m.fullExchangeName) ?? str(m.exchangeName),
  };
}
type YahooJson = { chart?: { result?: YahooResult[] | null; error?: { code?: string; description?: string } | null } };

/** Yahoo v8 JSON → RawOhlcv[] (ts in ms). Fehlende Bars werden übersprungen. */
export function parseYahooOhlcv(json: unknown): YahooOhlcvParse {
  const j = json as YahooJson;
  const err = j?.chart?.error;
  if (err) return { ok: false, error: String(err.description ?? err.code ?? 'Yahoo-Fehler') };
  const result = j?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const ts = result?.timestamp;
  if (!result || !quote || !ts) return { ok: false, error: 'Yahoo: kein verwertbarer result/quote-Block' };

  const candles: RawOhlcv[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    const v = quote.volume?.[i];
    // fehlende Bar (Yahoo paddet mit null) → ehrlich überspringen
    if (o == null || h == null || l == null || c == null) continue;
    candles.push([ts[i]! * 1000, o, h, l, c, v ?? 0]);
  }
  if (candles.length === 0) return { ok: false, error: 'Yahoo: keine gültigen Kerzen' };
  return { ok: true, candles, meta: parseMeta(result.meta) };
}

/** Holt echte OHLCV von Yahoo (kein Key). range z. B. '2y', interval z. B. '1d'. */
export async function fetchYahooOhlcv(
  symbol: string,
  opts: { range?: string; interval?: string } = {},
): Promise<YahooOhlcvParse> {
  const range = opts.range ?? '2y';
  const interval = opts.interval ?? '1d';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  } catch (e) {
    return { ok: false, error: `Yahoo nicht erreichbar: ${String(e)}` };
  }
  if (!res.ok) return { ok: false, error: `Yahoo HTTP ${res.status}` };
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: 'Yahoo: Antwort kein JSON (evtl. Rate-Limit/Bot-Wall)' };
  }
  return parseYahooOhlcv(json);
}

export type YahooIngestResult = {
  venue: string;
  symbol: string;
  timeframe: string;
  fetched: number;
  inserted: number;
  rejected: number;
  error?: string;
  /** Instrument-Metadaten aus derselben Antwort (Typ/Name/Währung) — für das Asset-Register. */
  meta?: YahooChartMeta | null;
};

/**
 * Ingest echter Aktien-/ETF-Kerzen von Yahoo in die OHLCV-Hypertable
 * (idempotent, Upsert — neuester Stand gewinnt, Datenqualität via sanitizeCandles).
 * `symbol` ist das App-Symbol (= Yahoo-Ticker für US-Titel, z. B. 'AAPL').
 */
export async function ingestYahooChart(
  db: Db,
  opts: { symbol: string; timeframe?: string; range?: string; yahooSymbol?: string },
): Promise<YahooIngestResult> {
  const timeframe = opts.timeframe ?? '1d';
  const interval = yahooIntervalFor(timeframe);
  const parsed = await fetchYahooOhlcv(opts.yahooSymbol ?? opts.symbol, { range: opts.range ?? '2y', interval });
  if (!parsed.ok) {
    return { venue: YAHOO_VENUE, symbol: opts.symbol, timeframe, fetched: 0, inserted: 0, rejected: 0, error: parsed.error };
  }
  const { valid, rejected } = sanitizeCandles(parsed.candles);
  // Upsert (candle-store.ts): offene letzte Kerze und nachträgliche Yahoo-Korrekturen im Fenster werden übernommen
  const inserted = valid.length > 0 ? await upsertCandles(db, candleRows(YAHOO_VENUE, opts.symbol.toUpperCase(), timeframe, valid)) : 0;
  return { venue: YAHOO_VENUE, symbol: opts.symbol.toUpperCase(), timeframe, fetched: parsed.candles.length, inserted, rejected: rejected.length, meta: parsed.meta };
}
