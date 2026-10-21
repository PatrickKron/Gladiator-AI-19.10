/**
 * Bar-Replay gegen die ECHTE DB (Server-CI; lokal ohne DATABASE_URL
 * übersprungen): `market.chartData` und `indicators.compute` mit Stichtag
 * liefern nur Kerzen bis dahin — die letzten N vor dem Stichtag, nicht die
 * ersten N der Historie; eine Live-Kerze zählt im Replay nicht.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import { getOhlcv } from '@gladiator/market-data';
import type pg from 'pg';
import { appRouter } from './index.js';
import { buildContext, createCallerFactory } from '../trpc.js';
import { register } from '../auth/service.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  console.warn('[replay.test] DATABASE_URL nicht gesetzt — übersprungen (Server-CI maßgeblich).');
}
if (hasDb && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;
}

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}-${Date.now()}`;
const EMAIL = `replay-${RUN}@test.invalid`;
const SYMBOL = `RPL${process.pid}/USDT`;
const { users, ohlcv } = schema;
const T0 = 1_760_000_000;
const H = 3600;
const N = 300;

describe.skipIf(!hasDb)('Replay: Kerzen bis zum Stichtag', () => {
  let db: Db;
  let pool: pg.Pool;
  let a: ReturnType<typeof createCaller>;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const ra = await register(db, { email: EMAIL, password: 'sehr-sicheres-passwort-123', name: 'R' });
    a = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${ra.accessToken}` }));
    const rows = [];
    for (let i = 0; i < N; i++) {
      const open = 100 + Math.sin(i / 9) * 6;
      const close = 100 + Math.sin((i + 1) / 9) * 6;
      rows.push({ venue: 'binance', symbol: SYMBOL, timeframe: '1h', ts: new Date((T0 + i * H) * 1000), open: String(open), high: String(Math.max(open, close) + 1), low: String(Math.min(open, close) - 1), close: String(close), volume: String(1000) });
    }
    await db.insert(ohlcv).values(rows).onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(ohlcv).where(and(eq(ohlcv.symbol, SYMBOL), eq(ohlcv.venue, 'binance')));
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email = ${EMAIL})`);
    await db.delete(users).where(inArray(users.email, [EMAIL]));
    await pool.end();
  });

  it('getOhlcv mit `until` ohne `since` = die letzten N Kerzen bis zum Stichtag', async () => {
    const until = new Date((T0 + 199 * H) * 1000);
    const rows = await getOhlcv(db, { symbol: SYMBOL, timeframe: '1h', limit: 100, until });
    expect(rows).toHaveLength(100);
    expect(rows[0]!.ts.getTime()).toBe((T0 + 100 * H) * 1000);
    expect(rows[rows.length - 1]!.ts.getTime()).toBe(until.getTime());
    // mit `since` bleibt das Zeitfenster aufsteigend ab since
    const win = await getOhlcv(db, { symbol: SYMBOL, timeframe: '1h', since: new Date((T0 + 10 * H) * 1000), until: new Date((T0 + 19 * H) * 1000) });
    expect(win.map((r) => r.ts.getTime() / 1000 - T0)).toEqual(Array.from({ length: 10 }, (_, k) => (10 + k) * H));
  });

  it('chartData mit Stichtag: letzte Kerze = Stichtag, Struktur/Zonen nur bis dahin', async () => {
    const until = T0 + 199 * H;
    const res = await a.market.chartData({ symbol: SYMBOL, timeframe: '1h', limit: 400, until });
    expect(res.available).toBe(true);
    if (!res.available) return;
    expect(res.candles).toHaveLength(200);
    expect(res.candles[res.candles.length - 1]!.time).toBe(until);
    for (const z of res.zones) expect(z.toTime).toBeLessThanOrEqual(until);
    for (const e of res.structure) expect(e.time).toBeLessThanOrEqual(until);
    for (const sw of res.liquidity.sweeps) expect(sw.time).toBeLessThanOrEqual(until);
    // ohne Stichtag: alle 300
    const full = await a.market.chartData({ symbol: SYMBOL, timeframe: '1h', limit: 400 });
    expect(full.available && full.candles.length).toBe(N);
  });

  it('compute mit Stichtag: Werte enden am Stichtag; Live-Kerze wird ignoriert', async () => {
    const until = T0 + 149 * H;
    const res = await a.indicators.compute({
      symbol: SYMBOL,
      timeframe: '1h',
      items: [{ key: 'rsi', id: 'rsi' }],
      until,
      liveBar: { time: T0 + 299 * H, open: 1, high: 2, low: 0.5, close: 1.5 },
    });
    expect(res.lastTime).toBe(until);
    const rsi = res.items[0]!.result!.plots.plot0!;
    expect(rsi[rsi.length - 1]!.time).toBe(until);
    // Dieselben Werte wie ohne Stichtag bis dahin (RSI blickt nicht in die Zukunft)
    const full = await a.indicators.compute({ symbol: SYMBOL, timeframe: '1h', items: [{ key: 'rsi', id: 'rsi' }] });
    const fullRsi = full.items[0]!.result!.plots.plot0!;
    const at = fullRsi.find((p) => p.time === until)!;
    expect(rsi[rsi.length - 1]!.value).toBeCloseTo(at.value, 9);
  });
  it('Übungs-Trade im Replay: offen ohne Folge-Kerze, Ziel/Stop mit der Engine, manueller Ausstieg, falsche Seite', async () => {
    const entryTime = T0 + 100 * H;
    const entry = 100 + Math.sin(101 / 9) * 6; // Close der Entry-Kerze
    const base = { symbol: SYMBOL, timeframe: '1h' as const, direction: 'long' as const, entryTime, stopLoss: entry * 0.9, takeProfit: entry * 1.02 };
    // Replay steht noch auf der Entry-Kerze → offen, kein Ergebnis
    const fresh = await a.market.replayTrade({ ...base, until: entryTime });
    expect(fresh.status).toBe('open');
    expect(fresh.entry).toBeCloseTo(entry, 9);
    expect(fresh.rMultiple).toBeNull();
    // einige Kerzen später: offen mit Zwischenstand ODER schon am Ziel — nie erfunden
    const mid = await a.market.replayTrade({ ...base, until: entryTime + 2 * H });
    expect(['open', 'closed']).toContain(mid.status);
    expect(typeof mid.rMultiple).toBe('number');
    // bis zum Ende der Daten: die Sinuswelle (+6 %) erreicht das Ziel (+2 %) vor dem Stop (−10 %)
    const done = await a.market.replayTrade({ ...base, until: T0 + 299 * H });
    expect(done.status).toBe('closed');
    expect(done.exitReason).toBe('tp');
    expect(done.rMultiple!).toBeGreaterThan(0);
    expect(done.exitTime!).toBeGreaterThan(entryTime);
    // manueller Ausstieg: offen am Stand → geschlossen zum Schluss dieser Kerze
    const manual = await a.market.replayTrade({ ...base, until: entryTime + 2 * H, closeAtEnd: true });
    expect(manual.status).toBe('closed');
    if (mid.status === 'open') {
      expect(manual.exitReason).toBe('manual');
      expect(manual.exitTime).toBe(entryTime + 2 * H);
    }
    // Stop auf der falschen Seite → ehrlich ungültig, kein Trade
    const bad = await a.market.replayTrade({ ...base, stopLoss: entry * 1.01, until: T0 + 299 * H });
    expect(bad.status).toBe('invalid');
    // unbekannte Entry-Kerze → keine Daten
    const nix = await a.market.replayTrade({ ...base, entryTime: entryTime + 1, until: T0 + 299 * H });
    expect(nix.status).toBe('no_data');
  });

});
