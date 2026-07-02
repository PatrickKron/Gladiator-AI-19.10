import ccxt from 'ccxt';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { sanitizeCandles, type RawOhlcv } from './candles.js';

const { ohlcv } = schema;

export type BackfillResult = {
  venue: string;
  symbol: string;
  timeframe: string;
  fetched: number;
  inserted: number;
  rejected: number;
};

/**
 * Historische OHLCV von einer echten Börse (ccxt, REST, paginiert) in die
 * Timescale-Hypertable laden. Idempotent (onConflictDoNothing auf PK).
 * enableRateLimit ist Pflicht (06_ §7a).
 */
export async function backfillOhlcv(
  db: Db,
  opts: { venue?: 'binance'; symbol: string; timeframe: string; since: Date; until?: Date },
  log: (msg: string) => void = () => {},
): Promise<BackfillResult> {
  const venue = opts.venue ?? 'binance';
  const exchange = new ccxt.binance({ enableRateLimit: true });
  const tfMs = exchange.parseTimeframe(opts.timeframe) * 1000;
  const untilMs = (opts.until ?? new Date()).getTime();

  let cursor = opts.since.getTime();
  let fetched = 0;
  let inserted = 0;
  let rejectedTotal = 0;

  while (cursor < untilMs) {
    const batch = (await exchange.fetchOHLCV(opts.symbol, opts.timeframe, cursor, 1000)) as RawOhlcv[];
    if (batch.length === 0) break;
    fetched += batch.length;

    const { valid, rejected } = sanitizeCandles(batch);
    rejectedTotal += rejected.length;
    for (const r of rejected) {
      log(`VERWORFEN ${opts.symbol} ${opts.timeframe} @${r.candle.ts.toISOString()}: ${r.errors.join(', ')}`);
    }

    if (valid.length > 0) {
      const rows = valid.map((c) => ({
        venue,
        symbol: opts.symbol,
        timeframe: opts.timeframe,
        ts: c.ts,
        open: String(c.open),
        high: String(c.high),
        low: String(c.low),
        close: String(c.close),
        volume: String(c.volume),
      }));
      // Batches, damit Parameterlimits nicht reißen
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const res = await db.insert(ohlcv).values(chunk).onConflictDoNothing();
        inserted += res.rowCount ?? 0;
      }
    }

    const last = batch[batch.length - 1]![0];
    const next = last + tfMs;
    if (next <= cursor) break; // Schutz gegen Endlosschleife
    cursor = next;
  }

  return { venue, symbol: opts.symbol, timeframe: opts.timeframe, fetched, inserted, rejected: rejectedTotal };
}

/** Kerzen aus der DB lesen (neueste zuerst → chronologisch zurückgegeben). */
export async function getOhlcv(
  db: Db,
  opts: { venue?: string; symbol: string; timeframe: string; limit?: number },
): Promise<{ ts: Date; open: number; high: number; low: number; close: number; volume: number }[]> {
  const rows = await db
    .select()
    .from(ohlcv)
    .where(
      and(
        eq(ohlcv.venue, opts.venue ?? 'binance'),
        eq(ohlcv.symbol, opts.symbol),
        eq(ohlcv.timeframe, opts.timeframe),
      ),
    )
    .orderBy(desc(ohlcv.ts))
    .limit(Math.min(opts.limit ?? 200, 1000));

  return rows.reverse().map((r) => ({
    ts: r.ts,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}
