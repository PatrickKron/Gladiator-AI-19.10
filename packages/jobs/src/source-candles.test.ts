/**
 * A3 Kerzen je Kursquelle für Pipelines, gegen die ECHTE DB (Server-CI; lokal skip): Yahoo speichert
 * kein 4h — 4h entsteht aus abgeschlossenen 1h-Kerzen bis `until` (look-ahead-frei). Fixture-Kerzen
 * mit eindeutigem Symbol, werden wieder gelöscht.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@gladiator/db';
import type pg from 'pg';
import { loadSourceCandles } from './source-candles.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) console.warn('[source-candles.test] DATABASE_URL fehlt — übersprungen (Server-CI maßgeblich).');

describe.skipIf(!hasDb)('loadSourceCandles (echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;
  const SYM = `SRC${process.pid}${Date.now() % 1e6}.TEST`;
  const H = 3_600_000;
  // Börsentag: 1h-Kerzen 13:30 … 19:30 UTC an einem festen Tag.
  const day = Date.UTC(2026, 9, 20);
  const hours = [13.5, 14.5, 15.5, 16.5, 17.5, 18.5, 19.5];

  beforeAll(async () => {
    ({ db, pool } = createDb());
    for (const [i, h] of hours.entries()) {
      const ts = new Date(day + h * H);
      await db.execute(sql`INSERT INTO ohlcv (venue, symbol, timeframe, ts, open, high, low, close, volume)
        VALUES ('yahoo', ${SYM}, '1h', ${ts}, ${100 + i}, ${101 + i}, ${99 + i}, ${100.5 + i}, 10)`);
    }
  });
  afterAll(async () => {
    await db.execute(sql`DELETE FROM ohlcv WHERE symbol = ${SYM}`);
    await pool.end();
  });

  it('Yahoo 4h: Buckets aus 1h, nur abgeschlossene bis until', async () => {
    const all = await loadSourceCandles(db, { venue: 'yahoo', symbol: SYM, timeframe: '4h', since: new Date(day), until: new Date(day + 24 * H) });
    expect(all.map((c) => c.ts.toISOString())).toEqual([new Date(day + 12 * H).toISOString(), new Date(day + 16 * H).toISOString()]);
    expect(all[0]).toMatchObject({ open: 100, close: 102.5, high: 103, low: 99, volume: 30 });
    expect(all[1]).toMatchObject({ open: 103, close: 106.5, volume: 40 });

    // Stichtag 18:00: der 16-Uhr-Bucket läuft noch → nur der 12-Uhr-Bucket (kein Blick in die Zukunft).
    const atSix = await loadSourceCandles(db, { venue: 'yahoo', symbol: SYM, timeframe: '4h', since: new Date(day), until: new Date(day + 18 * H) });
    expect(atSix).toHaveLength(1);
  });

  it('gespeicherte Zeitrahmen kommen unverändert', async () => {
    const h1 = await loadSourceCandles(db, { venue: 'yahoo', symbol: SYM, timeframe: '1h', since: new Date(day) });
    expect(h1).toHaveLength(hours.length);
    expect(await loadSourceCandles(db, { venue: 'binance', symbol: SYM, timeframe: '1h', since: new Date(day) })).toHaveLength(0);
  });
});
