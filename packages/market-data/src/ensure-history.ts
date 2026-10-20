import { sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { backfillOhlcv, type BackfillResult } from './ohlcv.js';
import { TIMEFRAME_MS, isSupportedTimeframe } from './timeframes.js';

/**
 * Historie sicherstellen (OFFENER_PLAN §3 „Strategie-Katalog"): vor einem
 * Backtest fehlende ECHTE Kerzen einmalig nachladen, wenn die Abdeckung im
 * Zeitraum unter 90 % liegt. Nie Lücken füllen oder interpolieren — es lädt
 * nur, was die Börse liefert; die Datenqualitäts-Prüfung des Backtests bleibt.
 */
export const MIN_COVERAGE = 0.9;

export type Backfiller = (
  db: Db,
  opts: { symbol: string; timeframe: string; since: Date; until?: Date },
) => Promise<BackfillResult>;

/** Anteil vorhandener Kerzen am erwarteten Raster (0..1). */
export function coverageRatio(count: number, from: Date, to: Date, timeframeMs: number): number {
  const expected = Math.floor((to.getTime() - from.getTime()) / timeframeMs);
  if (expected <= 0) return 1;
  return Math.min(1, count / expected);
}

async function countCandles(db: Db, symbol: string, timeframe: string, from: Date, to: Date): Promise<number> {
  const res = await db.execute(
    sql`SELECT count(*)::int AS n FROM ohlcv WHERE venue = 'binance' AND symbol = ${symbol} AND timeframe = ${timeframe} AND ts >= ${from} AND ts < ${to}`,
  );
  return Number((res.rows[0] as { n: number }).n);
}

export async function ensureCandleHistory(
  db: Db,
  opts: { symbol: string; timeframe: string; from: Date; to: Date },
  backfill: Backfiller = (d, o) => backfillOhlcv(d, o),
): Promise<{ before: number; after: number; backfilled: boolean }> {
  if (!isSupportedTimeframe(opts.timeframe)) throw new Error(`Timeframe ${opts.timeframe} wird nicht unterstützt.`);
  const tfMs = TIMEFRAME_MS[opts.timeframe];
  const before = await countCandles(db, opts.symbol, opts.timeframe, opts.from, opts.to);
  if (coverageRatio(before, opts.from, opts.to, tfMs) >= MIN_COVERAGE) return { before, after: before, backfilled: false };
  try {
    await backfill(db, { symbol: opts.symbol, timeframe: opts.timeframe, since: opts.from, until: opts.to });
  } catch (err) {
    throw new Error(`Historie für ${opts.symbol} ${opts.timeframe} konnte nicht nachgeladen werden: ${err instanceof Error ? err.message : String(err)}`);
  }
  const after = await countCandles(db, opts.symbol, opts.timeframe, opts.from, opts.to);
  return { before, after, backfilled: true };
}
