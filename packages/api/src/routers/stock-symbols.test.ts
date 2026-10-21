/**
 * Aktien/ETF/Forex im Chart gegen die ECHTE DB (Server-CI; lokal ohne
 * DATABASE_URL übersprungen): `market.stockSymbols` listet Symbole mit echten
 * Kerzen aus Twelve Data/Yahoo je Quelle; `market.chartData` liefert sie mit
 * `venue`, ohne Krypto-Kerzen zu verwechseln.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { appRouter } from './index.js';
import { buildContext, createCallerFactory } from '../trpc.js';
import { register } from '../auth/service.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  console.warn('[stock-symbols.test] DATABASE_URL nicht gesetzt — übersprungen (Server-CI maßgeblich).');
}
if (hasDb && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;
}

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}-${Date.now()}`;
const EMAIL = `stocks-${RUN}@test.invalid`;
const SYMBOL = `STK${process.pid}`;
const { users, ohlcv } = schema;
const T0 = 1_750_000_000;
const D = 86_400;

describe.skipIf(!hasDb)('Aktien/Forex im Chart: Quellen und Kerzen je Quelle', () => {
  let db: Db;
  let pool: pg.Pool;
  let a: ReturnType<typeof createCaller>;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const ra = await register(db, { email: EMAIL, password: 'sehr-sicheres-passwort-123', name: 'S' });
    a = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${ra.accessToken}` }));
    const rows = [];
    for (let i = 0; i < 120; i++) {
      const open = 150 + Math.sin(i / 7) * 5;
      const close = 150 + Math.sin((i + 1) / 7) * 5;
      rows.push({ venue: 'yahoo', symbol: SYMBOL, timeframe: '1d', ts: new Date((T0 + i * D) * 1000), open: String(open), high: String(Math.max(open, close) + 1), low: String(Math.min(open, close) - 1), close: String(close), volume: String(1_000_000) });
    }
    // dieselbe Symbol-Zeichenkette als Krypto-Kerzen (binance) mit anderem Kurs — darf nie vermischt werden
    for (let i = 0; i < 120; i++) {
      rows.push({ venue: 'binance', symbol: SYMBOL, timeframe: '1d', ts: new Date((T0 + i * D) * 1000), open: '1', high: '1.1', low: '0.9', close: '1', volume: '1' });
    }
    await db.insert(ohlcv).values(rows).onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(ohlcv).where(and(eq(ohlcv.symbol, SYMBOL), inArray(ohlcv.venue, ['yahoo', 'binance'])));
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email = ${EMAIL})`);
    await db.delete(users).where(inArray(users.email, [EMAIL]));
    await pool.end();
  });

  it('stockSymbols listet Yahoo-/Twelve-Data-Symbole mit Zeitrahmen; Key-Status ehrlich', async () => {
    const res = await a.market.stockSymbols();
    const row = res.rows.find((r) => r.symbol === SYMBOL);
    expect(row).toMatchObject({ venue: 'yahoo', candles: 120 });
    expect(row!.timeframes).toEqual(['1d']);
    expect(typeof res.configured.twelvedata).toBe('boolean');
    // Krypto-Kerzen desselben Symbols tauchen hier nicht auf
    expect(res.rows.filter((r) => r.symbol === SYMBOL)).toHaveLength(1);
  });

  it('chartData mit venue=yahoo liefert die Aktien-Kerzen, mit binance die Krypto-Kerzen', async () => {
    const stock = await a.market.chartData({ symbol: SYMBOL, timeframe: '1d', limit: 400, venue: 'yahoo' });
    expect(stock.available).toBe(true);
    if (stock.available) {
      expect(stock.candles).toHaveLength(120);
      expect(stock.candles[0]!.close).toBeGreaterThan(100);
    }
    const crypto = await a.market.chartData({ symbol: SYMBOL, timeframe: '1d', limit: 400, venue: 'binance' });
    expect(crypto.available && crypto.candles[0]!.close).toBe(1);
    const tfs = await a.market.availableTimeframes({ symbol: SYMBOL, venue: 'yahoo' });
    expect(tfs).toEqual(['1d']);
  });
});
