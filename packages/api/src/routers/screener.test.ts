/**
 * Markt-Screener gegen die ECHTE DB (Server-CI; lokal ohne DATABASE_URL
 * übersprungen): Universum, Lauf mit Treffer/Nicht-Treffer, Fehler je Symbol,
 * gespeicherte Screens mit Nutzer-Trennung, ungültige Bedingungen.
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
  console.warn('[screener.test] DATABASE_URL nicht gesetzt — übersprungen (Server-CI maßgeblich).');
}
if (hasDb && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;
}

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}-${Date.now()}`;
const EMAIL_A = `screener-a-${RUN}@test.invalid`;
const EMAIL_B = `screener-b-${RUN}@test.invalid`;
const SYMBOL = `SCR${process.pid}/USDT`;
const THIN = `SCRTHIN${process.pid}/USDT`;
const { users, ohlcv, screens } = schema;
const T0 = 1_760_000_000;
const H = 3600;

describe.skipIf(!hasDb)('screener-Router: Universum, Lauf, gespeicherte Screens', () => {
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
    // 300 deterministische Stundenkerzen, gleichmäßig steigend (+0,1 je Kerze) — Preis > EMA, Änderung positiv
    const rows = [];
    for (let i = 0; i < 300; i++) {
      const open = 100 + i * 0.1;
      const close = open + 0.1;
      rows.push({ venue: 'binance', symbol: SYMBOL, timeframe: '1h', ts: new Date((T0 + i * H) * 1000), open: String(open), high: String(close + 0.2), low: String(open - 0.2), close: String(close), volume: String(1000 + (i % 7) * 10) });
    }
    // zu dünnes Symbol (10 Kerzen) → gehört nicht ins Universum
    for (let i = 0; i < 10; i++) {
      rows.push({ venue: 'binance', symbol: THIN, timeframe: '1h', ts: new Date((T0 + i * H) * 1000), open: '1', high: '1.1', low: '0.9', close: '1', volume: '1' });
    }
    await db.insert(ohlcv).values(rows).onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(ohlcv).where(and(inArray(ohlcv.symbol, [SYMBOL, THIN]), eq(ohlcv.venue, 'binance')));
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email IN (${EMAIL_A}, ${EMAIL_B}))`);
    await db.delete(users).where(inArray(users.email, [EMAIL_A, EMAIL_B]));
    await pool.end();
  });

  it('ohne Token → UNAUTHORIZED; Vorlagen vorhanden; Universum nur Symbole mit genug Kerzen', async () => {
    const anon = createCaller(await buildContext({ db }));
    await expect(anon.screener.presets()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const presets = await a.screener.presets();
    expect(presets.length).toBeGreaterThanOrEqual(8);
    const uni = await a.screener.universe({ timeframe: '1h' });
    expect(uni.find((u) => u.symbol === SYMBOL)?.candles).toBe(300);
    expect(uni.find((u) => u.symbol === THIN)).toBeUndefined();
  });

  it('Lauf: Treffer bei erfüllter Bedingung, kein Treffer sonst, Fehler je Symbol ohne Abbruch', async () => {
    const hit = await a.screener.run({
      timeframe: '1h',
      symbols: [SYMBOL, THIN, `NIX${process.pid}/USDT`],
      conditions: [
        { kind: 'compare', left: { kind: 'price' }, op: '>', right: { kind: 'indicator', id: 'ema', plot: 'plot0', inputs: { length: 200 } } },
        { kind: 'compare', left: { kind: 'change', bars: 24 }, op: '>', right: { kind: 'number', value: 0 } },
      ],
    });
    expect(hit.scanned).toBe(3);
    expect(hit.matched).toBe(1);
    const row = hit.rows.find((r) => r.symbol === SYMBOL)!;
    expect(row.matches).toBe(true);
    expect(row.close).toBeCloseTo(100 + 299 * 0.1 + 0.1, 9);
    expect(row.results![0]!.ok).toBe(true);
    expect(row.results![1]!.left).toBeGreaterThan(0);
    // Treffer stehen vorn
    expect(hit.rows[0]!.symbol).toBe(SYMBOL);
    const thin = hit.rows.find((r) => r.symbol === THIN)!;
    expect(thin.matches).toBe(false);
    expect(thin.results![0]!.note).toMatch(/Zu wenige Kerzen/);
    const nix = hit.rows.find((r) => r.symbol.startsWith('NIX'))!;
    expect(nix.error).toMatch(/Keine Kerzen/);

    const miss = await a.screener.run({ timeframe: '1h', symbols: [SYMBOL], conditions: [{ kind: 'compare', left: { kind: 'price' }, op: '<', right: { kind: 'number', value: 0 } }] });
    expect(miss.matched).toBe(0);
    expect(miss.rows[0]!.matches).toBe(false);
  });

  it('ungültige Bedingungen lehnt zod ab', async () => {
    await expect(a.screener.run({ timeframe: '1h', symbols: [SYMBOL], conditions: [{ kind: 'range', zone: 'teuer' } as never] })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(a.screener.run({ timeframe: '1h', symbols: [SYMBOL], conditions: [] })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('gespeicherte Screens: anlegen, ändern, auflisten, Nutzer-Trennung, löschen', async () => {
    const conditions = [{ kind: 'range' as const, zone: 'discount' as const }];
    const saved = await a.screener.save({ name: 'Discount-Scan', timeframe: '4h', conditions });
    expect(saved.name).toBe('Discount-Scan');
    expect(saved.venue).toBe('binance');
    expect(saved.alert).toBe(false);
    // Screen-Alarm: nur der Besitzer schaltet; Einschalten setzt den Treffer-Stand zurück
    await expect(b.screener.setAlert({ id: saved.id, alert: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const armed = await a.screener.setAlert({ id: saved.id, alert: true });
    expect(armed.alert).toBe(true);
    expect(armed.lastMatches).toEqual([]);
    expect((await a.screener.list()).find((s) => s.id === saved.id)?.alert).toBe(true);
    expect((await a.screener.setAlert({ id: saved.id, alert: false })).alert).toBe(false);
    expect((await a.screener.list()).map((s) => s.id)).toContain(saved.id);
    expect((await b.screener.list()).map((s) => s.id)).not.toContain(saved.id);
    // B darf A's Screen weder ändern noch löschen
    await expect(b.screener.save({ id: saved.id, name: 'Fremd', timeframe: '1h', conditions })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(b.screener.remove({ id: saved.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const updated = await a.screener.save({ id: saved.id, name: 'Discount-Scan 1h', timeframe: '1h', conditions });
    expect(updated.timeframe).toBe('1h');
    await a.screener.remove({ id: saved.id });
    expect((await a.screener.list()).map((s) => s.id)).not.toContain(saved.id);
    expect((await db.select().from(screens).where(eq(screens.id, saved.id))).length).toBe(0);
  });
});
