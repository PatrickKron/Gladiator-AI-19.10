/**
 * Heatmap › Korrelation: Auswahl-Logik (rein) und Berechnung gegen die ECHTE DB
 * (Server-CI; lokal ohne DATABASE_URL übersprungen).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { MIN_COMMON_RETURNS, correlationFromDate, pickDefaultSymbols, type CandleSymbol } from './correlation.js';
import { appRouter } from '../routers/index.js';
import { buildContext, createCallerFactory } from '../trpc.js';
import { register } from '../auth/service.js';

describe('correlationFromDate (Fenster in Kalendertagen, endet mit der letzten abgeschlossenen Tageskerze)', () => {
  it('30 Tage am 2026-10-25 → Renditen mit Enddatum ab 2026-09-25 (genau 30 Tage bis gestern)', () => {
    expect(correlationFromDate(Date.parse('2026-10-25T10:00:00Z'), 30)).toBe('2026-09-25');
    expect(correlationFromDate(Date.parse('2026-10-25T00:00:00Z'), 90)).toBe('2026-07-27');
  });
});

describe('pickDefaultSymbols: Favoriten zuerst, dann Scan-Universum — nur Symbole mit echten Tageskerzen', () => {
  const universe: CandleSymbol[] = [
    { symbol: 'AAPL', venue: 'yahoo', candles: 1200 },
    { symbol: 'AAPL', venue: 'twelvedata', candles: 300 },
    { symbol: 'BTC/USDT', venue: 'binance', candles: 730 },
    { symbol: 'ETH/USDT', venue: 'binance', candles: 730 },
    { symbol: 'LINK/USDT', venue: 'binance', candles: 730 },
    { symbol: 'SOL/USDT', venue: 'binance', candles: 730 },
  ];

  it('Krypto-Favorit über das normalisierte Paar, Aktien-Favorit über den Ticker (Venue mit den meisten Kerzen), dann Scan', () => {
    const picked = pickDefaultSymbols(
      universe,
      [
        { ticker: 'LINK', assetType: 'CRYPTO', tradingPair: 'LINKUSDT' },
        { ticker: 'AAPL', assetType: 'STOCK', tradingPair: null },
        { ticker: 'NVDA', assetType: 'STOCK', tradingPair: null }, // keine Kerzen → fehlt ehrlich
      ],
      ['BTC/USDT', 'ETH/USDT', 'LINK/USDT', 'DOGE/USDT'],
      12,
    );
    expect(picked).toEqual([
      { symbol: 'LINK/USDT', venue: 'binance' },
      { symbol: 'AAPL', venue: 'yahoo' },
      { symbol: 'BTC/USDT', venue: 'binance' },
      { symbol: 'ETH/USDT', venue: 'binance' },
    ]);
  });

  it('Obergrenze greift; ohne Favoriten/Scan wird mit dem Universum aufgefüllt (mindestens zwei, sonst keine Matrix)', () => {
    expect(pickDefaultSymbols(universe, [], ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'], 2)).toHaveLength(2);
    expect(pickDefaultSymbols(universe, [], [], 3)).toEqual([
      { symbol: 'AAPL', venue: 'yahoo' },
      { symbol: 'AAPL', venue: 'twelvedata' },
      { symbol: 'BTC/USDT', venue: 'binance' },
    ]);
    expect(pickDefaultSymbols([], [{ ticker: 'BTC', assetType: 'CRYPTO', tradingPair: 'BTC/USDT' }], ['BTC/USDT'], 12)).toEqual([]);
  });
});

const hasDb = Boolean(process.env.DATABASE_URL);
if (hasDb && !process.env.JWT_SECRET) process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}-${Date.now()}`;
const EMAIL = `corr-${RUN}@test.invalid`;
const UP = `CORRUP${process.pid}/USDT`;
const DOWN = `CORRDN${process.pid}/USDT`;
const STOCK = `CORRSTK${process.pid}`;
const THIN = `CORRTHIN${process.pid}/USDT`;
const { users, ohlcv } = schema;
const DAY = 86_400_000;

describe.skipIf(!hasDb)('market.correlation / market.heatmapUniverse gegen die DB', () => {
  let db: Db;
  let pool: pg.Pool;
  let caller: ReturnType<typeof createCaller>;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const r = await register(db, { email: EMAIL, password: 'sehr-sicheres-passwort-123', name: 'Korrelation' });
    caller = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${r.accessToken}` }));
    // 120 abgeschlossene Tage bis gestern; feste Renditen (deterministisch, keine Zufallsdaten)
    const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    const rets = Array.from({ length: 120 }, (_, i) => [0.012, -0.008, 0.005, -0.015, 0.009, 0.003, -0.004][i % 7]! * (1 + (i % 5) / 10));
    const rows: (typeof ohlcv.$inferInsert)[] = [];
    let up = 100;
    let down = 100;
    for (let i = 0; i < 120; i++) {
      const ts = new Date(today - (120 - i) * DAY);
      up *= Math.exp(rets[i]!);
      down *= Math.exp(-rets[i]!);
      const bar = (venue: string, symbol: string, c: number, t = ts) => ({ venue, symbol, timeframe: '1d', ts: t, open: String(c), high: String(c * 1.01), low: String(c * 0.99), close: String(c), volume: '1' });
      rows.push(bar('binance', UP, up), bar('binance', DOWN, down));
      const wd = ts.getUTCDay();
      // Aktie: nur Werktage, Zeitstempel = US-Börsenöffnung 13:30 UTC (wie Yahoo)
      if (wd !== 0 && wd !== 6) rows.push(bar('yahoo', STOCK, up, new Date(ts.getTime() + 13.5 * 3_600_000)));
    }
    for (let i = 0; i < 25; i++) rows.push({ venue: 'binance', symbol: THIN, timeframe: '1d', ts: new Date(today - (25 - i) * DAY), open: '1', high: '1', low: '1', close: String(1 + i / 100), volume: '1' });
    // laufende Tageskerze (heute) mit absurdem Kurs — darf nie in die Rechnung
    rows.push({ venue: 'binance', symbol: UP, timeframe: '1d', ts: new Date(today), open: '1', high: '1', low: '1', close: '1', volume: '1' });
    await db.insert(ohlcv).values(rows).onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(ohlcv).where(and(inArray(ohlcv.symbol, [UP, DOWN, THIN]), eq(ohlcv.venue, 'binance')));
    await db.delete(ohlcv).where(and(eq(ohlcv.symbol, STOCK), eq(ohlcv.venue, 'yahoo')));
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email = ${EMAIL})`);
    await db.delete(users).where(eq(users.email, EMAIL));
    await pool.end();
  });

  it('ohne Token → UNAUTHORIZED', async () => {
    const anon = createCaller(await buildContext({ db }));
    await expect(anon.market.heatmapUniverse()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(anon.market.correlation({ symbols: [{ symbol: UP, venue: 'binance' }, { symbol: DOWN, venue: 'binance' }], days: 30 })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('Universum: nur Symbole mit genug echten Tageskerzen, je Venue', async () => {
    const uni = await caller.market.heatmapUniverse();
    expect(uni.symbols.find((s) => s.symbol === UP && s.venue === 'binance')?.candles).toBe(121);
    expect(uni.symbols.find((s) => s.symbol === STOCK && s.venue === 'yahoo')).toBeDefined();
    expect(uni.minReturns).toBe(MIN_COMMON_RETURNS);
  });

  it('gleichläufig r = 1, gegenläufig r = −1, Krypto × Aktie über gemeinsame Börsentage, zu dünn → null', async () => {
    const res = await caller.market.correlation({
      symbols: [
        { symbol: UP, venue: 'binance' },
        { symbol: DOWN, venue: 'binance' },
        { symbol: STOCK, venue: 'yahoo' },
        { symbol: THIN, venue: 'binance' },
      ],
      days: 90,
    });
    expect(res.matrix[0]![0]).toBe(1);
    expect(res.matrix[0]![1]).toBeCloseTo(-1, 8);
    expect(res.counts[0]![1]).toBe(90);
    // Aktie hat dieselben Kurse wie UP an Werktagen → r = 1 trotz anderer Uhrzeit; n = gemeinsame Werktage
    expect(res.matrix[0]![2]).toBeCloseTo(1, 8);
    expect(res.counts[0]![2]).toBeLessThan(90);
    expect(res.counts[0]![2]).toBeGreaterThanOrEqual(MIN_COMMON_RETURNS);
    // 25 Kerzen, davon nur ~24 Renditen — im 90-Tage-Fenster genug, aber THIN hat Varianz → Zahl
    expect(res.counts[3]![3]).toBe(24);
    // die laufende Tageskerze (Kurs 1) fließt nicht ein — sonst wäre r ≠ −1
    expect(res.symbols[0]!.lastDate! < new Date().toISOString().slice(0, 10)).toBe(true);
    const thirty = await caller.market.correlation({ symbols: [{ symbol: UP, venue: 'binance' }, { symbol: THIN, venue: 'binance' }], days: 30 });
    expect(thirty.counts[0]![1]).toBe(24);
    const tooThin = await caller.market.correlation({ symbols: [{ symbol: STOCK, venue: 'yahoo' }, { symbol: THIN, venue: 'binance' }], days: 30 });
    expect(tooThin.matrix[0]![1]).toBeNull(); // < 20 gemeinsame Börsentage-Renditen
  });

  it('Symbol ohne Kerzen bleibt sichtbar, mit 0 Schlusskursen und null-Zeile', async () => {
    const res = await caller.market.correlation({ symbols: [{ symbol: UP, venue: 'binance' }, { symbol: `NIX${process.pid}/USDT`, venue: 'binance' }], days: 30 });
    expect(res.symbols[1]).toMatchObject({ closes: 0, lastDate: null });
    expect(res.matrix[1]).toEqual([null, null]);
  });
});
