import type { Db } from '@gladiator/db';
import { ingestTwelveData, twelveDataConfigured, type YahooIngestResult } from '@gladiator/market-data';
import { loadYahooCandles, registeredAssets, type CandleVenue, type RegisteredAsset } from './asset-register.js';
import { ensureCandles } from './universe.js';

/**
 * Kerzen-Refresh für das Asset-Register (Worker-Job `candle-refresh`, alle 15 min): Vorher
 * wurden Yahoo-/Twelve-Data-Kerzen nach dem ersten Laden nie aktualisiert und Binance nur
 * für das Scan-Universum — Screener, Alarme und Demo-Kurse liefen auf alten Kerzen. Jetzt
 * je registriertem Asset (Priorität aus registeredAssets, Cap CANDLE_REFRESH_MAX):
 *   binance    → ensureCandles (inkrementell, frische Zeitrahmen werden übersprungen)
 *   yahoo      → loadYahooCandles (1d · 1h · 15m, kleinstes Fenster ab der letzten Kerze)
 *   twelvedata → nur mit Key, 1h + 1d mit kleinem outputsize (Rate-Limit 8/min)
 * Sequentiell mit Pause je Quelle; ein Fehler betrifft nur sein Symbol, der Lauf geht weiter.
 */

/** Höchstens so viele registrierte Assets je Lauf (Basis + jüngste Favoriten zuerst). */
export const CANDLE_REFRESH_MAX = 150;
/** Pause nach jedem Asset je Quelle (ms) — schont Rate-Limits (Twelve Data frei: 8 Anfragen/min). */
export const CANDLE_REFRESH_PAUSE_MS: Record<CandleVenue, number> = { binance: 250, yahoo: 400, twelvedata: 8_000 };
const TWELVE_DATA_TIMEFRAMES = ['1h', '1d'] as const;
const TWELVE_DATA_OUTPUTSIZE = 50;

export type CandleRefreshResult = {
  assets: number;
  refreshed: Record<CandleVenue, number>;
  inserted: number;
  skipped: string[];
  errors: string[];
};

export type CandleRefreshDeps = {
  list?: (db: Db) => Promise<RegisteredAsset[]>;
  ensureBinance?: (db: Db, symbol: string) => Promise<{ symbol: string; inserted: number; errors: string[] }>;
  ingestYahoo?: (db: Db, opts: { symbol: string; timeframe?: string; range?: string }) => Promise<YahooIngestResult>;
  ingestTwelveData?: (db: Db, opts: { symbol: string; timeframe: string; outputsize: number }) => Promise<{ inserted: number }>;
  twelveDataConfigured?: () => boolean;
  pauseMs?: Partial<Record<CandleVenue, number>>;
  now?: () => Date;
  limit?: number;
};

const errText = (err: unknown) => String(err instanceof Error ? err.message : err).slice(0, 200);
const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

export async function refreshRegisteredCandles(db: Db, deps: CandleRefreshDeps = {}): Promise<CandleRefreshResult> {
  const result: CandleRefreshResult = { assets: 0, refreshed: { binance: 0, yahoo: 0, twelvedata: 0 }, inserted: 0, skipped: [], errors: [] };
  const pause = { ...CANDLE_REFRESH_PAUSE_MS, ...deps.pauseMs };
  const list = (await (deps.list ?? registeredAssets)(db)).slice(0, deps.limit ?? CANDLE_REFRESH_MAX);
  result.assets = list.length;
  const tdConfigured = (deps.twelveDataConfigured ?? twelveDataConfigured)();

  for (const a of list) {
    try {
      if (a.venue === 'binance') {
        const r = await (deps.ensureBinance ?? ensureCandles)(db, a.symbol);
        result.inserted += r.inserted;
        for (const e of r.errors) result.errors.push(`binance:${e}`);
        result.refreshed.binance++;
      } else if (a.venue === 'yahoo') {
        const r = await loadYahooCandles(db, a.symbol, { ingest: deps.ingestYahoo, now: deps.now?.(), pauseMs: pause.yahoo });
        result.inserted += r.inserted;
        for (const e of r.errors) result.errors.push(`yahoo:${a.symbol} ${e}`);
        result.refreshed.yahoo++;
      } else {
        if (!tdConfigured) {
          result.skipped.push(`twelvedata:${a.symbol} — kein TWELVE_DATA_API_KEY`);
          continue;
        }
        const ingest = deps.ingestTwelveData ?? ingestTwelveData;
        for (const timeframe of TWELVE_DATA_TIMEFRAMES) {
          try {
            const r = await ingest(db, { symbol: a.symbol, timeframe, outputsize: TWELVE_DATA_OUTPUTSIZE });
            result.inserted += r.inserted;
          } catch (err) {
            result.errors.push(`twelvedata:${a.symbol} ${timeframe}: ${errText(err)}`);
          }
          await sleep(pause.twelvedata);
        }
        result.refreshed.twelvedata++;
      }
    } catch (err) {
      result.errors.push(`${a.venue}:${a.symbol}: ${errText(err)}`);
    }
    if (a.venue !== 'twelvedata') await sleep(pause[a.venue]);
  }
  return result;
}
