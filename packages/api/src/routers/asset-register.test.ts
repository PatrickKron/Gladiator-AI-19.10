/**
 * Asset-Register über die API (Patrick 2026-10-25): product.addAsset, Favoriten jeder Quelle
 * (toggleFavoriteBySymbol/favoriteSymbols mit venue) und die bestehenden „Asset wählen“-Wege
 * (market.ensureCandles/ensureStockCandles), die jetzt ebenfalls registrieren — gegen die ECHTE
 * DB (Server-CI; lokal ohne DATABASE_URL übersprungen). Netz-Quellen sind durch Test-Doubles
 * ersetzt, die echte Kerzenzeilen schreiben.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type { RegisterDeps } from '@gladiator/jobs';
import type pg from 'pg';
import { appRouter } from './index.js';
import { buildContext, createCallerFactory } from '../trpc.js';
import { register } from '../auth/service.js';
import { setRegisterDepsForTests } from '../market/register.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) console.warn('[asset-register.test] DATABASE_URL nicht gesetzt — übersprungen (Server-CI maßgeblich).');
if (hasDb && !process.env.JWT_SECRET) process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}${Date.now() % 100000}`;
const EMAIL = `asset-api-${RUN}@test.invalid`;
const PAIR = `AR${RUN}/USDT`;
const STOCK = `ARS${RUN}.DE`;
const PICKED = `ARP${RUN}`;
const NOW = Date.now();
const H = 3_600_000;

const candleRow = (venue: string, symbol: string, timeframe: string, close: string) => ({ venue, symbol, timeframe, ts: new Date(NOW - 2 * H), open: close, high: close, low: close, close, volume: '1' });

const deps: RegisterDeps = {
  listPairs: async () => [{ symbol: PAIR, base: PAIR.split('/')[0]! }],
  searchYahoo: async (q) => (q === STOCK ? [{ symbol: STOCK, name: 'Register-API SE', type: 'EQUITY', exchange: 'XETRA' }] : []),
  ensureBinance: async (db, symbol) => {
    const res = await db.insert(schema.ohlcv).values(candleRow('binance', symbol, '1h', '2')).onConflictDoNothing();
    return { symbol, inserted: res.rowCount ?? 0, errors: [] };
  },
  ingestYahoo: async (db, o) => {
    const res = await db.insert(schema.ohlcv).values(candleRow('yahoo', o.symbol, o.timeframe!, '42')).onConflictDoNothing();
    return { venue: 'yahoo', symbol: o.symbol, timeframe: o.timeframe!, fetched: 1, inserted: res.rowCount ?? 0, rejected: 0, meta: { symbol: o.symbol, instrumentType: 'ETF', name: 'Picked (Chart)', currency: 'USD', exchange: 'NYSE' } };
  },
};

describe.skipIf(!hasDb)('Asset-Register über die API', () => {
  let db: Db;
  let pool: pg.Pool;
  let me: ReturnType<typeof createCaller>;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    setRegisterDepsForTests(deps);
    const r = await register(db, { email: EMAIL, password: 'sehr-sicheres-passwort-123', name: 'Register' });
    me = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${r.accessToken}` }));
  });

  afterAll(async () => {
    setRegisterDepsForTests(null);
    await db.delete(schema.ohlcv).where(inArray(schema.ohlcv.symbol, [PAIR, STOCK, PICKED]));
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email = ${EMAIL})`);
    await db.delete(schema.users).where(eq(schema.users.email, EMAIL)); // Favoriten cascaden
    await db.delete(schema.assets).where(inArray(schema.assets.dataSymbol, [PAIR, STOCK, PICKED]));
    await pool.end();
  });

  it('ohne Token → UNAUTHORIZED', async () => {
    const anon = createCaller(await buildContext({ db }));
    await expect(anon.product.addAsset({ venue: 'yahoo', symbol: STOCK })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('addAsset (Yahoo-Aktie, noch nicht im System): registriert, Stern gesetzt, erscheint mit Quelle in favoriteSymbols und allAssets', async () => {
    const a = await me.product.addAsset({ venue: 'yahoo', symbol: STOCK.toLowerCase(), name: 'vom Client', kind: 'EQUITY' });
    expect(a).toMatchObject({ venue: 'yahoo', symbol: STOCK, assetType: 'STOCK', name: 'Register-API SE', favorite: true });
    expect(a.candles['1d']).toBe(1);
    const favs = await me.product.favoriteSymbols();
    expect(favs).toContainEqual(expect.objectContaining({ symbol: STOCK, venue: 'yahoo', ticker: STOCK, name: 'Register-API SE', newsTicker: STOCK.split('.')[0] }));
    const all = await me.product.allAssets();
    expect(all.find((x) => x.id === a.id)).toMatchObject({ symbol: STOCK, venue: 'yahoo', hasChart: true, isFavorite: true });
  });

  it('toggleFavoriteBySymbol mit venue (und ohne: Register entscheidet) für Nicht-Krypto', async () => {
    expect(await me.product.toggleFavoriteBySymbol({ symbol: STOCK, venue: 'yahoo' })).toEqual({ ok: true, favorite: false });
    expect((await me.product.favoriteSymbols()).some((f) => f.symbol === STOCK)).toBe(false);
    expect(await me.product.toggleFavoriteBySymbol({ symbol: STOCK })).toEqual({ ok: true, favorite: true });
    expect((await me.product.favoriteSymbols()).some((f) => f.symbol === STOCK && f.venue === 'yahoo')).toBe(true);
    // nicht registriert → ehrlich ok:false
    expect(await me.product.toggleFavoriteBySymbol({ symbol: `NIX${RUN}`, venue: 'yahoo' })).toEqual({ ok: false, favorite: false });
  });

  it('addAsset (neues Binance-Paar) + Stern per Symbol; unbekanntes Paar → BAD_REQUEST', async () => {
    const a = await me.product.addAsset({ venue: 'binance', symbol: PAIR });
    expect(a).toMatchObject({ venue: 'binance', symbol: PAIR, assetType: 'CRYPTO', favorite: true, created: true });
    expect((await me.product.favoriteSymbols()).some((f) => f.symbol === PAIR && f.venue === 'binance')).toBe(true);
    expect(await me.product.toggleFavoriteBySymbol({ symbol: PAIR.replace('/', '') })).toEqual({ ok: true, favorite: false });
    await expect(me.product.addAsset({ venue: 'binance', symbol: `NIX${RUN}/USDT` })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('bestehende Wege registrieren ohne Stern und behalten ihre Antwortform', async () => {
    const stock = await me.market.ensureStockCandles({ symbol: PICKED });
    expect(stock).toMatchObject({ symbol: PICKED, venue: 'yahoo' });
    expect(stock.candles['1h']).toBe(1);
    expect(Array.isArray(stock.errors)).toBe(true);
    const [row] = await db.select().from(schema.assets).where(eq(schema.assets.dataSymbol, PICKED));
    expect(row).toMatchObject({ candleVenue: 'yahoo', assetType: 'ETF', name: 'Picked (Chart)' });
    expect((await me.product.favoriteSymbols()).some((f) => f.symbol === PICKED)).toBe(false);

    const crypto = await me.market.ensureCandles({ symbol: PAIR });
    expect(crypto).toMatchObject({ symbol: PAIR, candles1h: 1 });
    expect(Array.isArray(crypto.errors)).toBe(true);
    await expect(me.market.ensureCandles({ symbol: `NIX${RUN}/USDT` })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
