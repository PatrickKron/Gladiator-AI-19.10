import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { withBinancePublic } from './binance-public.js';
import { sanitizeCandles, type RawOhlcv } from './candles.js';
import { freshCutoff, pickLatestClose, type LatestClose } from './freshness.js';
import { candleRows, upsertCandles } from './candle-store.js';

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
 * Timescale-Hypertable laden. Idempotent (Upsert auf PK: neuester Stand gewinnt,
 * unveränderte Kerzen bleiben unberührt; `inserted` = neu oder geändert).
 * enableRateLimit ist Pflicht (06_ §7a). Bei Binance-Standortsperre (HTTP 451)
 * über den offiziellen Marktdaten-Spiegel (binance-public.ts) — gleiche Kerzen.
 */
export async function backfillOhlcv(
  db: Db,
  opts: { venue?: 'binance'; symbol: string; timeframe: string; since: Date; until?: Date },
  log: (msg: string) => void = () => {},
): Promise<BackfillResult> {
  const venue = opts.venue ?? 'binance';
  // Bei 451 läuft alles noch einmal über den Spiegel — Inserts sind idempotent
  return withBinancePublic((exchange) => runBackfill(db, exchange, venue, opts, log));
}

async function runBackfill(
  db: Db,
  exchange: { parseTimeframe(tf: string): number; fetchOHLCV(...a: unknown[]): Promise<unknown> },
  venue: string,
  opts: { symbol: string; timeframe: string; since: Date; until?: Date },
  log: (msg: string) => void,
): Promise<BackfillResult> {
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
      // Upsert: die zuletzt noch offene Kerze bekommt beim nächsten Lauf ihren endgültigen Stand (candle-store.ts)
      inserted += await upsertCandles(db, candleRows(venue, opts.symbol, opts.timeframe, valid));
    }

    const last = batch[batch.length - 1]![0];
    const next = last + tfMs;
    if (next <= cursor) break; // Schutz gegen Endlosschleife
    cursor = next;
  }

  return { venue, symbol: opts.symbol, timeframe: opts.timeframe, fetched, inserted, rejected: rejectedTotal };
}

/**
 * Kerzen aus der DB lesen, chronologisch. Ohne Zeitraum: die letzten `limit`
 * Kerzen (Cap 1000). Mit `since`/`until` (Backtesting): aufsteigend im
 * Zeitfenster, Cap 100.000.
 */
export async function getOhlcv(
  db: Db,
  opts: { venue?: string; symbol: string; timeframe: string; limit?: number; since?: Date; until?: Date },
): Promise<{ ts: Date; open: number; high: number; low: number; close: number; volume: number }[]> {
  const base = and(
    eq(ohlcv.venue, opts.venue ?? 'binance'),
    eq(ohlcv.symbol, opts.symbol),
    eq(ohlcv.timeframe, opts.timeframe),
  );

  // `since` (ggf. mit `until`): Zeitfenster aufsteigend. Nur `until`: die
  // letzten N Kerzen BIS zum Stichtag (Replay, look-ahead-frei) — wie ohne
  // Stichtag, nur abgeschnitten.
  const ranged = opts.since !== undefined;
  const rows = ranged
    ? await db
        .select()
        .from(ohlcv)
        .where(
          and(
            base,
            gte(ohlcv.ts, opts.since!),
            opts.until ? lte(ohlcv.ts, opts.until) : undefined,
          ),
        )
        .orderBy(asc(ohlcv.ts))
        .limit(Math.min(opts.limit ?? 100_000, 100_000))
    : (
        await db
          .select()
          .from(ohlcv)
          .where(and(base, opts.until ? lte(ohlcv.ts, opts.until) : undefined))
          .orderBy(desc(ohlcv.ts))
          .limit(Math.min(opts.limit ?? 200, 1000))
      ).reverse();

  return rows.map((r) => ({
    ts: r.ts,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}

/**
 * Universum für Screener und Screen-Alarme: Symbole mit mindestens `minCandles`
 * echten Kerzen im Zeitrahmen (ehrlich: nur was in der DB liegt), alphabetisch, begrenzt.
 * Seit dem Asset-Register nur FRISCHE Reihen (neueste Kerze jünger als die Frische-Grenze,
 * freshness.ts) — Screener und Screen-Alarme handeln nie auf eingeschlafenen Kerzen.
 */
export async function candleUniverse(
  db: Db,
  opts: { timeframe: string; venue?: string; minCandles: number; limit: number; now?: Date },
): Promise<{ symbol: string; candles: number; lastTs: string }[]> {
  const venue = opts.venue ?? 'binance';
  const cutoff = freshCutoff(opts.timeframe, venue, opts.now ?? new Date());
  const res = await db.execute(sql`
    SELECT symbol, count(*)::int AS candles, max(ts) AS last_ts
    FROM ohlcv
    WHERE venue = ${venue} AND timeframe = ${opts.timeframe}
    GROUP BY symbol
    HAVING count(*) >= ${opts.minCandles} AND max(ts) >= ${cutoff.toISOString()}::timestamptz
    ORDER BY symbol
    LIMIT ${opts.limit}
  `);
  return (res.rows as { symbol: string; candles: number; last_ts: string | Date }[]).map((r) => ({
    symbol: r.symbol,
    candles: r.candles,
    lastTs: new Date(r.last_ts).toISOString(),
  }));
}

/** Zeitstempel der neuesten Kerze (venue + Symbol + Zeitrahmen) oder null. */
export async function latestCandleTs(db: Db, opts: { venue: string; symbol: string; timeframe: string }): Promise<Date | null> {
  const res = await db.execute(
    sql`SELECT max(ts) AS ts FROM ohlcv WHERE venue = ${opts.venue} AND symbol = ${opts.symbol} AND timeframe = ${opts.timeframe}`,
  );
  const ts = (res.rows[0] as { ts: string | Date | null } | undefined)?.ts;
  return ts ? new Date(ts) : null;
}

/** Zeitrahmen, deren neueste Kerze den letzten Kurs eines Kerzen-Assets trägt (klein → groß). */
export const LATEST_CLOSE_TIMEFRAMES = ['5m', '15m', '1h', '1d'] as const;

/**
 * Letzter echter Kurs eines Kerzen-Assets (Yahoo/Twelve Data — dort gibt es keinen Ticker):
 * Schlusskurs der neuesten FRISCHEN Kerze über 5m/15m/1h/1d. Veraltet oder leer ⇒ ok:false
 * mit Grund — Preis-Alarme und Kurs-Kacheln lösen nie auf altem Kurs aus.
 */
export async function latestFreshClose(db: Db, opts: { venue: string; symbol: string; now?: Date }): Promise<LatestClose> {
  const candidates = [];
  for (const timeframe of LATEST_CLOSE_TIMEFRAMES) {
    const [c] = await getOhlcv(db, { venue: opts.venue, symbol: opts.symbol, timeframe, limit: 1 });
    if (c) candidates.push({ timeframe, ts: c.ts, close: c.close });
  }
  return pickLatestClose(candidates, opts.venue, opts.now ?? new Date());
}
