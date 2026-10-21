/**
 * Indikator-Bibliothek gegen die ECHTE DB (Server-CI; lokal ohne DATABASE_URL
 * übersprungen): Katalog, Rechnung auf DB-Kerzen (+ Live-Kerze), CRUD der
 * Chart-Indikatoren mit Nutzer-Scoping, Bereinigung der Eingaben, Limit.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { appRouter } from './index.js';
import { applyLiveBar, MAX_INDICATORS_PER_SYMBOL, tickerIdOf } from './indicators.js';
import { buildContext, createCallerFactory } from '../trpc.js';
import { register } from '../auth/service.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  console.warn('[indicators.test] DATABASE_URL nicht gesetzt — übersprungen (Server-CI maßgeblich).');
}
if (hasDb && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;
}

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}-${Date.now()}`;
const EMAIL_A = `indicators-a-${RUN}@test.invalid`;
const EMAIL_B = `indicators-b-${RUN}@test.invalid`;
const SYMBOL = `IND${process.pid}/USDT`;
const { users, ohlcv } = schema;
const T0 = 1_760_000_000;
const H = 3600;

describe('reine Helfer', () => {
  it('tickerIdOf und applyLiveBar', () => {
    expect(tickerIdOf('binance', 'BTC/USDT')).toBe('BINANCE:BTCUSDT');
    const bars = [
      { time: 10, open: 1, high: 2, low: 0.5, close: 1.5 },
      { time: 20, open: 1.5, high: 2.5, low: 1, close: 2 },
    ];
    expect(applyLiveBar(bars, undefined)).toBe(bars);
    // gleiche Zeit → ersetzt die letzte Kerze
    expect(applyLiveBar(bars, { time: 20, open: 1.5, high: 3, low: 1, close: 2.9 }).at(-1)?.close).toBe(2.9);
    // neuere Zeit → hängt an
    expect(applyLiveBar(bars, { time: 30, open: 2, high: 2, low: 2, close: 2 })).toHaveLength(3);
    // ältere Zeit → ignoriert (Browser hinkt)
    expect(applyLiveBar(bars, { time: 5, open: 2, high: 2, low: 2, close: 2 })).toBe(bars);
  });
});

describe.skipIf(!hasDb)('indicators-Router: Katalog, Rechnung, CRUD, Scoping', () => {
  let db: Db;
  let pool: pg.Pool;
  let a: ReturnType<typeof createCaller>;
  let b: ReturnType<typeof createCaller>;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const ra = await register(db, { email: EMAIL_A, password: 'sehr-sicheres-passwort-123', name: 'A' });
    const rb = await register(db, { email: EMAIL_B, password: 'sehr-sicheres-passwort-123', name: 'B' });
    a = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${ra.accessToken}` }));
    b = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${rb.accessToken}` }));
    // 300 deterministische Stundenkerzen (kein Zufall) für das Testsymbol
    const rows = [];
    for (let i = 0; i < 300; i++) {
      const open = 100 + Math.sin(i / 9) * 6 + i * 0.02;
      const close = 100 + Math.sin((i + 1) / 9) * 6 + i * 0.02;
      rows.push({
        venue: 'binance',
        symbol: SYMBOL,
        timeframe: '1h',
        ts: new Date((T0 + i * H) * 1000),
        open: String(open),
        high: String(Math.max(open, close) + 1),
        low: String(Math.min(open, close) - 1),
        close: String(close),
        volume: String(1000 + (i % 13) * 10),
      });
    }
    await db.insert(ohlcv).values(rows).onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(ohlcv).where(and(eq(ohlcv.symbol, SYMBOL), eq(ohlcv.venue, 'binance')));
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email IN (${EMAIL_A}, ${EMAIL_B}))`);
    await db.delete(users).where(inArray(users.email, [EMAIL_A, EMAIL_B]));
    await pool.end();
  });

  it('ohne Token → UNAUTHORIZED; Katalog mit Standard + Kerzenmustern', async () => {
    const anon = createCaller(await buildContext({ db }));
    await expect(anon.indicators.catalog()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const cat = await a.indicators.catalog();
    expect(cat.length).toBeGreaterThan(150);
    expect(cat.find((e) => e.id === 'rsi')?.overlay).toBe(false);
    expect(cat.find((e) => e.id === 'ema')?.overlay).toBe(true);
  });

  it('compute: Werte auf DB-Kerzen, Live-Kerze hängt an, Fehler je Indikator', async () => {
    const r = await a.indicators.compute({
      symbol: SYMBOL,
      timeframe: '1h',
      items: [
        { key: 'r', id: 'rsi', inputs: { length: 21 } },
        { key: 'e', id: 'ema', inputs: { length: '50', unsinn: 1 } },
        { key: 'x', id: 'gibt-es-nicht' },
      ],
    });
    expect(r.lastTime).toBe(T0 + 299 * H);
    const rsi = r.items.find((i) => i.key === 'r')!;
    expect(rsi.error).toBeNull();
    expect(rsi.inputs.length).toBe(21);
    const pts = rsi.result!.plots.plot0!;
    expect(pts.length).toBe(300 - 21);
    for (const p of pts) expect(p.value).toBeGreaterThanOrEqual(0);
    const ema = r.items.find((i) => i.key === 'e')!;
    expect(ema.inputs.length).toBe(50);
    expect(ema.inputs).not.toHaveProperty('unsinn');
    expect(ema.result!.plots.plot0!.length).toBe(300 - 49);
    const bad = r.items.find((i) => i.key === 'x')!;
    expect(bad.result).toBeNull();
    expect(bad.error).toMatch(/Unbekannter Indikator/);

    // Live-Kerze (neuer als die DB) → ein Punkt mehr, Wert folgt der Live-Kerze
    const live = { time: T0 + 300 * H, open: 100, high: 120, low: 99, close: 119 };
    const r2 = await a.indicators.compute({ symbol: SYMBOL, timeframe: '1h', items: [{ id: 'rsi' }], liveBar: live });
    expect(r2.lastTime).toBe(live.time);
    const last = r2.items[0]!.result!.plots.plot0!.at(-1)!;
    expect(last.time).toBe(live.time);
    expect(last.value).toBeGreaterThan(rsi.result!.plots.plot0!.at(-1)!.value);

    // unbekanntes Symbol → ehrlich „keine Kerzen“, kein Absturz
    const r3 = await a.indicators.compute({ symbol: 'NIX/USDT', timeframe: '1h', items: [{ id: 'rsi' }] });
    expect(r3.items[0]!.error).toMatch(/Keine Kerzen/);
  });

  it('CRUD mit Scoping, Bereinigung, Limit', async () => {
    const row = await a.indicators.add({ symbol: SYMBOL, indicatorId: 'rsi', inputs: { length: 0, src: 'hl2', fremd: true } });
    expect(row.inputs.length).toBe(1); // min 1
    expect(row.inputs.src).toBe('hl2');
    expect(row.inputs).not.toHaveProperty('fremd');
    await expect(a.indicators.add({ symbol: SYMBOL, indicatorId: 'nope' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const upd = await a.indicators.update({ id: row.id, inputs: { length: 30 }, style: { plots: { plot0: { color: '#ff0000', lineWidth: 2 } } } });
    expect(upd.inputs.length).toBe(30);
    expect(upd.style?.plots?.plot0?.color).toBe('#ff0000');

    // fremder Nutzer sieht/ändert/löscht nichts
    expect(await b.indicators.list({ symbol: SYMBOL })).toEqual([]);
    await expect(b.indicators.update({ id: row.id, inputs: { length: 5 } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(b.indicators.remove({ id: row.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await a.indicators.list({ symbol: SYMBOL })).map((x) => x.id)).toEqual([row.id]);

    // Limit je Symbol
    for (let i = 1; i < MAX_INDICATORS_PER_SYMBOL; i++) await a.indicators.add({ symbol: SYMBOL, indicatorId: 'sma', inputs: { len: 10 + i } });
    await expect(a.indicators.add({ symbol: SYMBOL, indicatorId: 'sma' })).rejects.toThrow(/Höchstens/);
    expect(await a.indicators.list({ symbol: SYMBOL })).toHaveLength(MAX_INDICATORS_PER_SYMBOL);

    await a.indicators.remove({ id: row.id });
    expect(await a.indicators.clear({ symbol: SYMBOL })).toEqual({ deleted: MAX_INDICATORS_PER_SYMBOL - 1 });
    expect(await a.indicators.list({ symbol: SYMBOL })).toEqual([]);
  });
});
