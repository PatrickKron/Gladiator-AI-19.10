import { sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { backfillOhlcv, resolveCandleTarget, type BackfillResult } from './ohlcv.js';
import { TIMEFRAME_MS, isSupportedTimeframe } from './timeframes.js';
import { ingestTwelveData } from './twelvedata.js';
import { ingestYahooChart, yahooRefreshRange } from './yahoo-chart.js';

/**
 * Historie sicherstellen (OFFENER_PLAN §3 „Strategie-Katalog"): vor einem
 * Backtest fehlende ECHTE Kerzen einmalig nachladen, wenn die Abdeckung im
 * Zeitraum zu gering ist. Nie Lücken füllen oder interpolieren — es lädt
 * nur, was die Börse bzw. Kursquelle liefert; die Datenqualitäts-Prüfung bleibt.
 */
export const MIN_COVERAGE = 0.9;
const NON_BINANCE_DAILY_COVERAGE = 0.55;
const NON_BINANCE_INTRADAY_COVERAGE = 0.12;
const YAHOO_INTRADAY_MAX_WINDOW_MS = 60 * 86_400_000;
const TWELVEDATA_MAX_BARS = 5000;

export type Backfiller = (
  db: Db,
  opts: { venue?: string; symbol: string; timeframe: string; since: Date; until?: Date },
) => Promise<BackfillResult | void>;

/** Mindest-Abdeckung je Kursquelle & Timeframe (24/7-Krypto vs. Handelszeiten bei Aktien/ETF/Forex). */
export function requiredCoverage(venue: string, timeframe: string): number {
  if (venue === 'binance') return MIN_COVERAGE;
  if (timeframe === '1d' || timeframe === '1w' || timeframe === '1M') return NON_BINANCE_DAILY_COVERAGE;
  return NON_BINANCE_INTRADAY_COVERAGE;
}

/** Anteil vorhandener Kerzen am erwarteten Raster (0..1). */
export function coverageRatio(count: number, from: Date, to: Date, timeframeMs: number): number {
  const expected = Math.floor((to.getTime() - from.getTime()) / timeframeMs);
  if (expected <= 0) return 1;
  return Math.min(1, count / expected);
}

async function countCandles(db: Db, venue: string, symbol: string, timeframe: string, from: Date, to: Date): Promise<number> {
  const res = await db.execute(
    sql`SELECT count(*)::int AS n FROM ohlcv WHERE venue = ${venue} AND symbol = ${symbol} AND timeframe = ${timeframe} AND ts >= ${from} AND ts < ${to}`,
  );
  return Number((res.rows[0] as { n: number }).n);
}

async function defaultBackfill(
  db: Db,
  venue: string,
  opts: { symbol: string; timeframe: string; since: Date; until?: Date },
): Promise<void> {
  if (venue === 'binance') {
    await backfillOhlcv(db, opts);
    return;
  }
  if (venue === 'yahoo') {
    const range = yahooRefreshRange(opts.timeframe, null);
    let r = await ingestYahooChart(db, {
      symbol: opts.symbol,
      timeframe: opts.timeframe,
      range,
    });
    if (r.error && range === '60d') {
      r = await ingestYahooChart(db, {
        symbol: opts.symbol,
        timeframe: opts.timeframe,
        range: '1mo',
      });
    }
    if (r.error) throw new Error(r.error);
    return;
  }
  if (venue === 'twelvedata') {
    await ingestTwelveData(db, { symbol: opts.symbol, timeframe: opts.timeframe });
    return;
  }
  throw new Error(`Unbekannte Kerzenquelle "${venue}" für ${opts.symbol}`);
}

export async function ensureCandleHistory(
  db: Db,
  opts: { venue?: string; symbol: string; timeframe: string; from: Date; to: Date },
  backfill?: Backfiller,
): Promise<{ before: number; after: number; backfilled: boolean }> {
  if (!isSupportedTimeframe(opts.timeframe)) throw new Error(`Timeframe ${opts.timeframe} wird nicht unterstützt.`);
  const { venue, symbol } = await resolveCandleTarget(db, opts.symbol, opts.venue);
  const sourceTf = venue !== 'binance' && opts.timeframe === '4h' ? '1h' : opts.timeframe;
  const tfMs = TIMEFRAME_MS[sourceTf]!;
  // Yahoo erlaubt bei <1h höchstens 60 Tage Historie; Twelve Data liefert max. 5000 Kerzen pro Call.
  const effectiveFrom =
    venue === 'yahoo' && (sourceTf === '5m' || sourceTf === '15m' || sourceTf === '30m')
      ? new Date(Math.max(opts.from.getTime(), opts.to.getTime() - YAHOO_INTRADAY_MAX_WINDOW_MS))
      : venue === 'twelvedata'
        ? new Date(Math.max(opts.from.getTime(), opts.to.getTime() - TWELVEDATA_MAX_BARS * tfMs))
        : opts.from;
  const before = await countCandles(db, venue, symbol, sourceTf, effectiveFrom, opts.to);
  if (coverageRatio(before, effectiveFrom, opts.to, tfMs) >= requiredCoverage(venue, sourceTf)) {
    return { before, after: before, backfilled: false };
  }
  try {
    if (backfill) {
      await backfill(db, { venue, symbol, timeframe: sourceTf, since: opts.from, until: opts.to });
    } else {
      await defaultBackfill(db, venue, { symbol, timeframe: sourceTf, since: opts.from, until: opts.to });
    }
  } catch (err) {
    throw new Error(`Historie für ${symbol} (${venue}) ${opts.timeframe} konnte nicht nachgeladen werden: ${err instanceof Error ? err.message : String(err)}`);
  }
  const after = await countCandles(db, venue, symbol, sourceTf, effectiveFrom, opts.to);
  return { before, after, backfilled: true };
}
