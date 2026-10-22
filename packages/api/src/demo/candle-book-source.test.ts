/** Schlusskurs-Quelle gegen die ECHTE DB (lokal mit DATABASE_URL, sonst übersprungen): letzter Schlusskurs, nie erfunden. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from '@gladiator/db';
import type pg from 'pg';
import { CandleCloseBookSource } from './candle-book-source.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) console.warn('[candle-book-source.test] DATABASE_URL nicht gesetzt — übersprungen (Server-CI maßgeblich).');
const SYM = `DEMOSTK${process.pid}`;

describe.skipIf(!hasDb)('CandleCloseBookSource', () => {
  let db: Db;
  let pool: pg.Pool;
  beforeAll(async () => {
    ({ db, pool } = createDb());
    await db.execute(sql`INSERT INTO ohlcv (venue, symbol, timeframe, ts, open, high, low, close, volume) VALUES
      ('yahoo', ${SYM}, '1d', now() - interval '2 days', 100, 101, 99, 100.5, 1000),
      ('yahoo', ${SYM}, '1h', now() - interval '3 hours', 100.5, 102, 100, 101.75, 50)`);
  });
  afterAll(async () => {
    await db.execute(sql`DELETE FROM ohlcv WHERE symbol = ${SYM}`);
    await pool.end();
  });

  it('nimmt die jüngste Kerze über alle Zeitrahmen (1h vor 1d) und baut ein einstufiges Buch zum Schlusskurs', async () => {
    const src = new CandleCloseBookSource(db, 'yahoo');
    const book = await src.fetchBook(SYM);
    expect(book.bids[0]!.price).toBe(101.75);
    expect(book.asks[0]!.price).toBe(101.75);
    expect(book.bids[0]!.qty).toBeGreaterThan(1e9);
    expect(await src.marketRules()).toEqual({ tickSize: 0.01, lotSize: 0.0001, minNotional: 1 });
  });

  it('ohne Kerzen ein ehrlicher Fehler statt eines erfundenen Kurses', async () => {
    await expect(new CandleCloseBookSource(db, 'twelvedata').fetchBook(SYM)).rejects.toThrow(/Keine echten Kerzen/);
  });
});
