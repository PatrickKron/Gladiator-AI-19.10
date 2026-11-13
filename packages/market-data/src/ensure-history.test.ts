/**
 * ensureCandleHistory: lädt fehlende Historie NUR nach, wenn die Abdeckung im
 * Zeitraum zu gering ist. Nachlader injiziert (kein Netz in der CI); DB-Teil
 * nur mit DATABASE_URL.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { coverageRatio, ensureCandleHistory, requiredCoverage } from './ensure-history.js';

describe('coverageRatio', () => {
  it('Anteil vorhandener Kerzen am erwarteten Raster, gedeckelt bei 1', () => {
    const H = 3_600_000;
    expect(coverageRatio(50, new Date(0), new Date(100 * H), H)).toBeCloseTo(0.5, 9);
    expect(coverageRatio(150, new Date(0), new Date(100 * H), H)).toBe(1);
    expect(coverageRatio(0, new Date(0), new Date(0), H)).toBe(1);
  });

  it('requiredCoverage unterscheidet 24/7-Krypto und Handelszeiten bei Aktien/Forex', () => {
    expect(requiredCoverage('binance', '1h')).toBe(0.9);
    expect(requiredCoverage('yahoo', '1d')).toBe(0.55);
    expect(requiredCoverage('yahoo', '1h')).toBe(0.12);
    expect(requiredCoverage('twelvedata', '4h')).toBe(0.12);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('ensureCandleHistory (echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;
  const SYMBOL = `EH${process.pid}${Date.now() % 100000}/USDT`;
  const H = 3_600_000;
  const to = new Date(Math.floor(Date.UTC(2026, 6, 1) / H) * H);
  const from = new Date(to.getTime() - 100 * H);

  const insertBars = async (count: number) => {
    const rows = Array.from({ length: count }, (_, k) => ({
      venue: 'binance',
      symbol: SYMBOL,
      timeframe: '1h',
      ts: new Date(from.getTime() + k * H),
      open: '100',
      high: '101',
      low: '99',
      close: '100',
      volume: '1',
    }));
    await db.insert(schema.ohlcv).values(rows).onConflictDoNothing();
  };

  beforeAll(() => {
    ({ db, pool } = createDb());
  });
  afterAll(async () => {
    await db.execute(sql`DELETE FROM ohlcv WHERE symbol = ${SYMBOL}`);
    await pool.end();
  });

  it('zu wenig Kerzen → Nachlader wird für genau den Zeitraum aufgerufen', async () => {
    await insertBars(30);
    const calls: { symbol: string; timeframe: string; since: Date; until?: Date }[] = [];
    const res = await ensureCandleHistory(db, { symbol: SYMBOL, timeframe: '1h', from, to }, async (_db, o) => {
      calls.push(o);
      await insertBars(100);
      return { venue: 'binance', symbol: o.symbol, timeframe: o.timeframe, fetched: 100, inserted: 70, rejected: 0 };
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ symbol: SYMBOL, timeframe: '1h', since: from, until: to });
    expect(res).toMatchObject({ backfilled: true, before: 30, after: 100 });
  });

  it('ausreichende Abdeckung → kein Netzaufruf', async () => {
    let called = false;
    const res = await ensureCandleHistory(db, { symbol: SYMBOL, timeframe: '1h', from, to }, async () => {
      called = true;
      throw new Error('darf nicht passieren');
    });
    expect(called).toBe(false);
    expect(res.backfilled).toBe(false);
  });

  it('Nachladen scheitert → ehrlicher Fehler mit Grund', async () => {
    await db.execute(sql`DELETE FROM ohlcv WHERE symbol = ${SYMBOL}`);
    await expect(
      ensureCandleHistory(db, { symbol: SYMBOL, timeframe: '1h', from, to }, async () => {
        throw new Error('Binance nicht erreichbar');
      }),
    ).rejects.toThrow(/Binance nicht erreichbar/);
  });

  it('Yahoo 4h zählt und lädt die zugrunde liegende 1h-Reihe auf venue=yahoo', async () => {
    const Y_SYM = `EHY${process.pid % 10000}`;
    try {
      const yRows = Array.from({ length: 20 }, (_, k) => ({
        venue: 'yahoo',
        symbol: Y_SYM,
        timeframe: '1h',
        ts: new Date(from.getTime() + k * H),
        open: '150',
        high: '151',
        low: '149',
        close: '150',
        volume: '100',
      }));
      await db.insert(schema.ohlcv).values(yRows).onConflictDoNothing();
      let calledTf = '';
      let calledVenue = '';
      const res = await ensureCandleHistory(
        db,
        { venue: 'yahoo', symbol: Y_SYM, timeframe: '4h', from, to },
        async (_db, o) => {
          calledVenue = o.venue ?? '';
          calledTf = o.timeframe;
        },
      );
      expect(res.backfilled).toBe(false);
      expect(res.before).toBe(20);
      expect(calledTf).toBe('');
      expect(calledVenue).toBe('');

      // Bei 0 Kerzen ruft ensureCandleHistory den Backfiller mit venue='yahoo' und sourceTf='1h'
      await db.execute(sql`DELETE FROM ohlcv WHERE symbol = ${Y_SYM}`);
      const res2 = await ensureCandleHistory(
        db,
        { venue: 'yahoo', symbol: Y_SYM, timeframe: '4h', from, to },
        async (_db, o) => {
          calledVenue = o.venue ?? '';
          calledTf = o.timeframe;
          await db.insert(schema.ohlcv).values(yRows).onConflictDoNothing();
        },
      );
      expect(calledVenue).toBe('yahoo');
      expect(calledTf).toBe('1h');
      expect(res2).toMatchObject({ backfilled: true, before: 0, after: 20 });
    } finally {
      await db.execute(sql`DELETE FROM ohlcv WHERE symbol = ${Y_SYM}`);
    }
  });
});
