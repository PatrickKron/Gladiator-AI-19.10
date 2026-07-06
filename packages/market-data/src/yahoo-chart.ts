import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { sanitizeCandles, type RawOhlcv } from './candles.js';

const { ohlcv } = schema;

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

/** App-Timeframe → Yahoo-Intervall. Für Aktien primär Tageskerzen. */
const YAHOO_INTERVAL: Record<string, string> = {
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '60m',
  '1d': '1d',
  '1wk': '1wk',
  '1M': '1mo',
};

export function yahooIntervalFor(timeframe: string): string {
  return YAHOO_INTERVAL[timeframe] ?? '1d';
}

export type YahooOhlcvParse = { ok: true; candles: RawOhlcv[] } | { ok: false; error: string };

type YahooQuote = {
  open?: (number | null)[];
  high?: (number | null)[];
  low?: (number | null)[];
  close?: (number | null)[];
  volume?: (number | null)[];
};
type YahooResult = { timestamp?: number[]; indicators?: { quote?: YahooQuote[] } };
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
  return { ok: true, candles };
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
};

/**
 * Ingest echter Aktien-/ETF-Kerzen von Yahoo in die OHLCV-Hypertable
 * (idempotent, onConflictDoNothing, Datenqualität via sanitizeCandles).
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
  let inserted = 0;
  if (valid.length > 0) {
    const rows = valid.map((c) => ({
      venue: YAHOO_VENUE,
      symbol: opts.symbol.toUpperCase(),
      timeframe,
      ts: c.ts,
      open: String(c.open),
      high: String(c.high),
      low: String(c.low),
      close: String(c.close),
      volume: String(c.volume),
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const res = await db.insert(ohlcv).values(rows.slice(i, i + 500)).onConflictDoNothing();
      inserted += res.rowCount ?? 0;
    }
  }
  return { venue: YAHOO_VENUE, symbol: opts.symbol.toUpperCase(), timeframe, fetched: parsed.candles.length, inserted, rejected: rejected.length };
}
