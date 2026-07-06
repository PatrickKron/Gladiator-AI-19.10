import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { sanitizeCandles, type RawOhlcv } from './candles.js';

const { ohlcv } = schema;

/**
 * Twelve Data (https://twelvedata.com) — echter Aktien-/ETF-/Forex-/Krypto-Feed.
 * Kostenloser Plan: 800 Calls/Tag, 8 Calls/min. Key kommt aus dem Vault
 * (TWELVE_DATA_API_KEY, AES-256-GCM). NUR echte Antworten werden verwendet —
 * API-Fehler ⇒ ok:false/Exception, nie erfundene Kerzen (04_ §4, eiserne Regel 1).
 *
 * Venue in der OHLCV-Hypertable: 'twelvedata' (getrennt von 'binance'), damit
 * Aktien-Kerzen die Krypto-Kerzen nie überschreiben.
 */

export const TWELVEDATA_VENUE = 'twelvedata';

/**
 * ALLE von Twelve Data angebotenen Auflösungen (nicht künstlich limitiert):
 * App-Timeframe → Twelve-Data-`interval`. Der App-Stil (`15m`, `1h`, `1d`)
 * bleibt konsistent mit dem Rest des Systems; die Hypertable-Spalte ist Text.
 */
export const TWELVE_DATA_INTERVALS: Record<string, string> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '45m': '45min',
  '1h': '1h',
  '2h': '2h',
  '4h': '4h',
  '1d': '1day',
  '1w': '1week',
  '1M': '1month',
};

/** App-Timeframe → Twelve-Data-Intervall. Unbekannt ⇒ Fehler (nie raten). */
export function twelveDataIntervalFor(timeframe: string): string {
  const interval = TWELVE_DATA_INTERVALS[timeframe];
  if (!interval) throw new Error(`Timeframe ${timeframe} wird von Twelve Data nicht unterstützt.`);
  return interval;
}

/** Twelve-Data-Intervall → App-Timeframe (Rückabbildung). */
export function appTimeframeForInterval(interval: string): string {
  const found = Object.entries(TWELVE_DATA_INTERVALS).find(([, v]) => v === interval);
  if (!found) throw new Error(`Twelve-Data-Intervall ${interval} ist nicht abgebildet.`);
  return found[0];
}

/** Ist ein Key gesetzt? (Vault lädt ihn beim Boot nach process.env.) */
export function twelveDataConfigured(): boolean {
  return Boolean(process.env.TWELVE_DATA_API_KEY);
}

export type TwelveDataParse =
  | { ok: true; symbol: string; interval: string; candles: RawOhlcv[] }
  | { ok: false; error: string };

/**
 * Parst eine `time_series`-Antwort. Twelve Data liefert `values` NEUESTE ZUERST —
 * wir drehen auf chronologisch aufsteigend (wie die Engine/DB erwartet).
 * `status: 'error'` oder leere Werte ⇒ ok:false (ehrlich, keine Ersatzwerte).
 */
export function parseTwelveDataTimeSeries(json: unknown): TwelveDataParse {
  const root = json as
    | {
        status?: string;
        code?: number;
        message?: string;
        meta?: { symbol?: string; interval?: string };
        values?: { datetime?: string; open?: string; high?: string; low?: string; close?: string; volume?: string }[];
      }
    | null;

  if (!root || typeof root !== 'object') return { ok: false, error: 'Leere oder ungültige Antwort.' };
  if (root.status === 'error') return { ok: false, error: root.message ?? `Twelve Data Fehler (Code ${root.code ?? '?'}).` };

  const values = root.values;
  if (!Array.isArray(values) || values.length === 0) {
    return { ok: false, error: 'Keine Kerzen in der Antwort (leere Zeitreihe).' };
  }

  const raw: RawOhlcv[] = [];
  for (const v of values) {
    if (!v.datetime) continue;
    // 'YYYY-MM-DD' (Tages-/Wochen-/Monatskerzen) oder 'YYYY-MM-DD HH:mm:ss' (intraday, UTC).
    const iso = v.datetime.includes(' ') ? v.datetime.replace(' ', 'T') + 'Z' : v.datetime;
    const ts = new Date(iso).getTime();
    if (Number.isNaN(ts)) continue;
    raw.push([
      ts,
      Number(v.open),
      Number(v.high),
      Number(v.low),
      Number(v.close),
      v.volume != null ? Number(v.volume) : 0,
    ]);
  }
  if (raw.length === 0) return { ok: false, error: 'Kerzen ohne gültigen Zeitstempel — nichts Verwertbares.' };

  // Neueste zuerst → chronologisch aufsteigend
  raw.sort((a, b) => a[0] - b[0]);

  return { ok: true, symbol: root.meta?.symbol ?? '?', interval: root.meta?.interval ?? '?', candles: raw };
}

/**
 * Holt eine Zeitreihe von Twelve Data. `outputsize` bis 5000 (Free-Plan-Max).
 * Wirft bei HTTP-/Netzwerkfehlern; Parser meldet API-Fehler als ok:false.
 */
export async function fetchTwelveDataTimeSeries(
  symbol: string,
  timeframe: string,
  opts: { outputsize?: number; apiKey?: string } = {},
): Promise<TwelveDataParse> {
  const apiKey = opts.apiKey ?? process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return { ok: false, error: 'Kein TWELVE_DATA_API_KEY gesetzt — in den Einstellungen eintragen.' };
  const interval = twelveDataIntervalFor(timeframe);
  const outputsize = Math.min(Math.max(opts.outputsize ?? 5000, 1), 5000);
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}&outputsize=${outputsize}&apikey=${encodeURIComponent(apiKey)}&format=JSON`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Twelve Data ${symbol}@${interval}: HTTP ${res.status}`);
  return parseTwelveDataTimeSeries(await res.json());
}

export type TwelveDataIngestResult = {
  venue: string;
  symbol: string;
  timeframe: string;
  interval: string;
  fetched: number;
  inserted: number;
  rejected: number;
};

/**
 * Ingest EINER Auflösung in die OHLCV-Hypertable (idempotent, onConflictDoNothing).
 * Datenqualität wird geprüft (sanitizeCandles); verworfene Kerzen werden gemeldet.
 */
export async function ingestTwelveData(
  db: Db,
  opts: { symbol: string; timeframe: string; outputsize?: number; apiKey?: string },
  log: (msg: string) => void = () => {},
): Promise<TwelveDataIngestResult> {
  const interval = twelveDataIntervalFor(opts.timeframe);
  const parsed = await fetchTwelveDataTimeSeries(opts.symbol, opts.timeframe, {
    outputsize: opts.outputsize,
    apiKey: opts.apiKey,
  });
  if (!parsed.ok) throw new Error(parsed.error);

  const { valid, rejected } = sanitizeCandles(parsed.candles);
  for (const r of rejected) {
    log(`VERWORFEN ${opts.symbol} ${opts.timeframe} @${r.candle.ts.toISOString()}: ${r.errors.join(', ')}`);
  }

  let inserted = 0;
  if (valid.length > 0) {
    const rows = valid.map((c) => ({
      venue: TWELVEDATA_VENUE,
      symbol: opts.symbol,
      timeframe: opts.timeframe,
      ts: c.ts,
      open: String(c.open),
      high: String(c.high),
      low: String(c.low),
      close: String(c.close),
      volume: String(c.volume),
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const res = await db.insert(ohlcv).values(chunk).onConflictDoNothing();
      inserted += res.rowCount ?? 0;
    }
  }

  return {
    venue: TWELVEDATA_VENUE,
    symbol: opts.symbol,
    timeframe: opts.timeframe,
    interval,
    fetched: parsed.candles.length,
    inserted,
    rejected: rejected.length,
  };
}

/**
 * Ingest ALLER angebotenen Auflösungen für ein Symbol (nacheinander, mit
 * Rücksicht auf das 8-Calls/min-Limit). Einzelne Fehler stoppen den Lauf nicht —
 * sie werden ehrlich je Timeframe protokolliert.
 */
export async function ingestTwelveDataAllTimeframes(
  db: Db,
  opts: { symbol: string; timeframes?: string[]; outputsize?: number; apiKey?: string; delayMs?: number },
  log: (msg: string) => void = () => {},
): Promise<{ results: TwelveDataIngestResult[]; errors: { timeframe: string; error: string }[] }> {
  const timeframes = opts.timeframes ?? Object.keys(TWELVE_DATA_INTERVALS);
  const results: TwelveDataIngestResult[] = [];
  const errors: { timeframe: string; error: string }[] = [];
  const delayMs = opts.delayMs ?? 8_000; // 8 Calls/min → ~7,5 s Abstand, konservativ 8 s

  for (let i = 0; i < timeframes.length; i++) {
    const timeframe = timeframes[i]!;
    try {
      const res = await ingestTwelveData(db, { symbol: opts.symbol, timeframe, outputsize: opts.outputsize, apiKey: opts.apiKey }, log);
      results.push(res);
      log(`${opts.symbol} ${timeframe}: ${res.inserted} neu (${res.fetched} geladen, ${res.rejected} verworfen)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ timeframe, error: msg });
      log(`FEHLER ${opts.symbol} ${timeframe}: ${msg}`);
    }
    if (i < timeframes.length - 1 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  return { results, errors };
}
