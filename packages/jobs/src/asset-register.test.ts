/**
 * Asset-Register (Patrick 2026-10-25: „Assets ganz einfach hinzufügen — auch solche, die noch
 * nicht bei uns vertreten sind — und die Logik läuft im Backend"): reine Helfer (Typ, Ticker,
 * Symbol-Normalisierung, Priorität) und der Register-Dienst gegen die ECHTE DB (Server-CI;
 * lokal ohne DATABASE_URL übersprungen). Netz-Quellen sind im DB-Teil durch Test-Doubles
 * ersetzt — Binance-Paarliste, Yahoo-Suche und Kerzen-Ingest; die Kerzen selbst sind echte
 * DB-Zeilen.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import {
  AssetRegisterError,
  assetIdFor,
  assetTypeFor,
  displayTicker,
  isCandleVenue,
  normalizeRegisterSymbol,
  orderRegistered,
  registerAsset,
  registeredAssets,
  USER_MARKETS_PACKAGE,
  type RegisterDeps,
} from './asset-register.js';

describe('assetTypeFor', () => {
  it('Binance-Paar → CRYPTO', () => {
    expect(assetTypeFor('binance', null, 'BTC/USDT')).toBe('CRYPTO');
  });
  it.each([
    ['EQUITY', 'STOCK'],
    ['ETF', 'ETF'],
    ['INDEX', 'INDEX'],
    ['CURRENCY', 'FOREX'],
    ['FUTURE', 'FUTURE'],
    ['MUTUALFUND', 'FUND'],
    ['CRYPTOCURRENCY', 'CRYPTO'],
    ['etf', 'ETF'],
  ])('Yahoo quoteType %s → %s', (quoteType, expected) => {
    expect(assetTypeFor('yahoo', quoteType, 'X')).toBe(expected);
  });
  it('ohne Yahoo-Typ: eindeutige Yahoo-Symbolik (^ Index, =X Forex, =F Future), sonst Aktie', () => {
    expect(assetTypeFor('yahoo', null, '^GSPC')).toBe('INDEX');
    expect(assetTypeFor('yahoo', undefined, 'EURUSD=X')).toBe('FOREX');
    expect(assetTypeFor('yahoo', 'OPTION', 'GC=F')).toBe('FUTURE');
    expect(assetTypeFor('yahoo', null, 'SAP.DE')).toBe('STOCK');
  });
});

describe('displayTicker', () => {
  it.each([
    ['binance', 'BTC/USDT', 'BTC'],
    ['binance', 'pepe/usdt', 'PEPE'],
    ['yahoo', 'EURUSD=X', 'EURUSD'],
    ['yahoo', 'GC=F', 'GC'],
    ['yahoo', '^GSPC', 'GSPC'],
    ['yahoo', 'SAP.DE', 'SAP.DE'], // Börsen-Suffix bleibt: SAP.DE ≠ SAP (NYSE)
    ['yahoo', 'brk-b', 'BRK-B'],
    ['twelvedata', 'AAPL', 'AAPL'],
  ] as const)('%s %s → %s', (venue, symbol, expected) => {
    expect(displayTicker(venue, symbol)).toBe(expected);
  });
});

describe('normalizeRegisterSymbol', () => {
  it('Binance: Paar normalisieren, nackte Basis → /USDT, Unsinn → null', () => {
    expect(normalizeRegisterSymbol('binance', 'btcusdt')).toBe('BTC/USDT');
    expect(normalizeRegisterSymbol('binance', ' eth/usdc ')).toBe('ETH/USDC');
    expect(normalizeRegisterSymbol('binance', 'pepe')).toBe('PEPE/USDT');
    expect(normalizeRegisterSymbol('binance', 'BTC USDT')).toBeNull();
    expect(normalizeRegisterSymbol('binance', '')).toBeNull();
  });
  it('Yahoo: Großschreibung, echte Yahoo-Zeichen (^ . - = &), auch Ein-Buchstaben-Ticker', () => {
    expect(normalizeRegisterSymbol('yahoo', 'f')).toBe('F');
    expect(normalizeRegisterSymbol('yahoo', ' sap.de ')).toBe('SAP.DE');
    expect(normalizeRegisterSymbol('yahoo', 'eurusd=x')).toBe('EURUSD=X');
    expect(normalizeRegisterSymbol('yahoo', '^gspc')).toBe('^GSPC');
    expect(normalizeRegisterSymbol('yahoo', 'M&M.NS')).toBe('M&M.NS');
    expect(normalizeRegisterSymbol('yahoo', 'DROP TABLE')).toBeNull();
    expect(normalizeRegisterSymbol('yahoo', 'X'.repeat(30))).toBeNull();
  });
});

describe('isCandleVenue / assetIdFor / Paket', () => {
  it('nur die drei Kerzenquellen; Register-ID eindeutig je Quelle + Symbol', () => {
    expect(isCandleVenue('binance')).toBe(true);
    expect(isCandleVenue('yahoo')).toBe(true);
    expect(isCandleVenue('twelvedata')).toBe(true);
    expect(isCandleVenue('kraken')).toBe(false);
    expect(isCandleVenue(null)).toBe(false);
    expect(assetIdFor('yahoo', 'BRK-B')).not.toBe(assetIdFor('yahoo', 'BRK.B'));
    expect(assetIdFor('binance', 'BTC/USDT')).toBe('user:binance:BTC/USDT');
    expect(USER_MARKETS_PACKAGE.packageId).toBe('user-markets');
  });
});

describe('orderRegistered', () => {
  const base = { assetType: 'CRYPTO', name: 'x', ticker: 'X', userAdded: false, createdAt: new Date('2026-01-01T00:00:00Z') };
  it('Basis zuerst, dann Favoriten (neueste zuerst), dann nur Hinzugefügte (neueste zuerst); dedupliziert je Quelle+Symbol', () => {
    const out = orderRegistered(
      [
        { ...base, symbol: 'AAPL', venue: 'yahoo', assetType: 'STOCK', favoritedAt: new Date('2026-10-01T00:00:00Z') },
        { ...base, symbol: 'DOGE/USDT', venue: 'binance', favoritedAt: new Date('2026-10-20T00:00:00Z') },
        { ...base, symbol: 'BTC/USDT', venue: 'binance', favoritedAt: new Date('2026-10-21T00:00:00Z') },
        { ...base, symbol: 'GC=F', venue: 'yahoo', assetType: 'FUTURE', favoritedAt: null, userAdded: true, createdAt: new Date('2026-10-02T00:00:00Z') },
        { ...base, symbol: 'SAP.DE', venue: 'yahoo', assetType: 'STOCK', favoritedAt: null, userAdded: true, createdAt: new Date('2026-10-03T00:00:00Z') },
        { ...base, symbol: 'DOGE/USDT', venue: 'binance', favoritedAt: new Date('2026-09-01T00:00:00Z') },
      ],
      ['BTC/USDT', 'ETH/USDT'],
    );
    expect(out.map((r) => `${r.venue}:${r.symbol}`)).toEqual([
      'binance:BTC/USDT',
      'binance:ETH/USDT',
      'binance:DOGE/USDT',
      'yahoo:AAPL',
      'yahoo:SAP.DE',
      'yahoo:GC=F',
    ]);
    // Basis-Symbol ohne Register-Zeile bekommt ehrliche Minimal-Daten (Basis-Ticker)
    expect(out[1]).toMatchObject({ symbol: 'ETH/USDT', venue: 'binance', assetType: 'CRYPTO', ticker: 'ETH' });
    // Doppelte: der jüngste Favorit zählt
    expect(out[2]!.favoritedAt?.toISOString()).toBe('2026-10-20T00:00:00.000Z');
  });
});

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) console.warn('[asset-register.test] DATABASE_URL nicht gesetzt — DB-Teil übersprungen (Server-CI maßgeblich).');

describe.skipIf(!hasDb)('registerAsset gegen die echte DB', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  const RUN = `${process.pid}${Date.now() % 100000}`;
  const PAIR = `RG${RUN}/USDT`;
  const SEED_PAIR = `RGX${RUN}/USDT`;
  let seedPackageId: number;
  let seedAssetId: number;
  const STOCK = `RGS${RUN}.DE`;
  const NOW = Date.now();
  const H = 3_600_000;
  const calls: string[] = [];

  /** Test-Doubles der Netz-Quellen — schreiben ECHTE Kerzenzeilen in die DB wie die Originale. */
  const deps: RegisterDeps = {
    listPairs: async () => [
      { symbol: PAIR, base: PAIR.split('/')[0]! },
      { symbol: SEED_PAIR, base: SEED_PAIR.split('/')[0]! },
    ],
    searchYahoo: async () => [{ symbol: STOCK, name: 'Registertest SE', type: 'EQUITY', exchange: 'XETRA' }],
    ensureBinance: async (d, symbol) => {
      calls.push(`binance:${symbol}`);
      const rows = Array.from({ length: 5 }, (_, i) => ({ venue: 'binance', symbol, timeframe: '1h', ts: new Date(NOW - (5 - i) * H), open: '1', high: '1.2', low: '0.9', close: '1.1', volume: '10' }));
      const res = await d.insert(schema.ohlcv).values(rows).onConflictDoNothing();
      return { symbol, inserted: res.rowCount ?? 0, errors: [] };
    },
    ingestYahoo: async (d, opts) => {
      calls.push(`yahoo:${opts.symbol}@${opts.timeframe}/${opts.range}`);
      if (opts.timeframe === '15m') return { venue: 'yahoo', symbol: opts.symbol, timeframe: '15m', fetched: 0, inserted: 0, rejected: 0, error: 'Yahoo HTTP 422' };
      const res = await d
        .insert(schema.ohlcv)
        .values([{ venue: 'yahoo', symbol: opts.symbol, timeframe: opts.timeframe!, ts: new Date(NOW - 2 * H), open: '50', high: '51', low: '49', close: '50.5', volume: '100' }])
        .onConflictDoNothing();
      return { venue: 'yahoo', symbol: opts.symbol, timeframe: opts.timeframe!, fetched: 1, inserted: res.rowCount ?? 0, rejected: 0, meta: { symbol: opts.symbol, instrumentType: 'EQUITY', name: 'Registertest SE (Chart)', currency: 'EUR', exchange: 'XETRA' } };
    },
  };

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [u] = await db.insert(schema.users).values({ email: `asset-register-${RUN}@test.invalid` }).returning();
    userId = u!.id;
    // Katalog-Asset wie aus dem v1-Seed: Paar ohne Slash, ohne Kerzenquelle
    const [pkg] = await db.insert(schema.packages).values({ packageId: `pkg-rg-${RUN}`, name: 'Seed-Test', category: 'DIGITAL_ASSETS' }).returning();
    seedPackageId = pkg!.id;
    const [seed] = await db
      .insert(schema.assets)
      .values({ assetId: `seed-rg-${RUN}`, packageId: seedPackageId, ticker: SEED_PAIR.split('/')[0]!, name: 'Seedcoin', assetType: 'CRYPTO', tradingPair: SEED_PAIR.replace('/', '') })
      .returning();
    seedAssetId = seed!.id;
  });

  afterAll(async () => {
    await db.delete(schema.ohlcv).where(inArray(schema.ohlcv.symbol, [PAIR, STOCK, SEED_PAIR]));
    await db.delete(schema.assets).where(inArray(schema.assets.dataSymbol, [PAIR, STOCK]));
    await db.delete(schema.assets).where(eq(schema.assets.packageId, seedPackageId));
    await db.delete(schema.packages).where(eq(schema.packages.id, seedPackageId));
    await db.execute(sql`DELETE FROM audit_log WHERE user_id = ${userId}::uuid`);
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end();
  });

  it('neues Binance-Paar: validiert, Kerzen geladen, Register-Zeile im Paket „Eigene Märkte“, Favorit + Audit', async () => {
    const r = await registerAsset(db, { venue: 'binance', symbol: PAIR.toLowerCase().replace('/', ''), userId, favorite: true, via: 'test' }, deps);
    expect(r.asset).toMatchObject({ venue: 'binance', symbol: PAIR, assetType: 'CRYPTO', ticker: PAIR.split('/')[0] });
    expect(r.favorite).toBe(true);
    expect(r.candles['1h']).toBe(5);
    const [row] = await db.select().from(schema.assets).where(eq(schema.assets.id, r.asset.id));
    expect(row!.candleVenue).toBe('binance');
    expect(row!.tradingPair).toBe(PAIR);
    const [pkg] = await db.select().from(schema.packages).where(eq(schema.packages.id, row!.packageId));
    expect(pkg!.packageId).toBe('user-markets');
    const fav = await db.select().from(schema.assetFavorites).where(and(eq(schema.assetFavorites.userId, userId), eq(schema.assetFavorites.assetId, r.asset.id)));
    expect(fav).toHaveLength(1);
    const audit = await db.execute(sql`SELECT action, details FROM audit_log WHERE user_id = ${userId}::uuid AND action = 'asset.register'`);
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('idempotent: dieselbe Quelle + dasselbe Symbol → dieselbe Zeile; ohne favorite bleibt der Stern unberührt', async () => {
    const a = await registerAsset(db, { venue: 'binance', symbol: PAIR, userId, favorite: false }, deps);
    const b = await registerAsset(db, { venue: 'binance', symbol: PAIR, userId, favorite: true }, deps);
    expect(a.asset.id).toBe(b.asset.id);
    const rows = await db.select().from(schema.assets).where(and(eq(schema.assets.candleVenue, 'binance'), eq(schema.assets.dataSymbol, PAIR)));
    expect(rows).toHaveLength(1);
  });

  it('unbekanntes Paar → UNKNOWN_SYMBOL, nichts angelegt; Binance tot ohne Kerzen → UNREACHABLE', async () => {
    const unknown = registerAsset(db, { venue: 'binance', symbol: `NIX${RUN}/USDT`, userId }, deps);
    await expect(unknown).rejects.toBeInstanceOf(AssetRegisterError);
    await expect(unknown).rejects.toMatchObject({ code: 'UNKNOWN_SYMBOL' });
    await expect(
      registerAsset(db, { venue: 'binance', symbol: `NIX${RUN}/USDT`, userId }, { ...deps, listPairs: async () => { throw new Error('offline'); } }),
    ).rejects.toMatchObject({ code: 'UNREACHABLE' });
    const none = await db.select().from(schema.assets).where(eq(schema.assets.dataSymbol, `NIX${RUN}/USDT`));
    expect(none).toHaveLength(0);
  });

  it('vorhandenes Katalog-Asset mit demselben Paar wird wiederverwendet (Name bleibt), bekommt Quelle + Symbol', async () => {
    const r = await registerAsset(db, { venue: 'binance', symbol: SEED_PAIR, userId, favorite: false }, deps);
    expect(r.asset.id).toBe(seedAssetId);
    expect(r.created).toBe(false);
    expect(r.asset.name).toBe('Seedcoin');
    const [row] = await db.select().from(schema.assets).where(eq(schema.assets.id, seedAssetId));
    expect(row).toMatchObject({ candleVenue: 'binance', dataSymbol: SEED_PAIR, packageId: seedPackageId });
  });

  it('Yahoo-Aktie: Name/Typ aus der Suche, 1d+1h geladen, 15m-Fehler ehrlich gemeldet (Fallback-Fenster versucht)', async () => {
    const r = await registerAsset(db, { venue: 'yahoo', symbol: STOCK.toLowerCase(), userId, favorite: true }, deps);
    expect(r.asset).toMatchObject({ venue: 'yahoo', symbol: STOCK, assetType: 'STOCK', name: 'Registertest SE', ticker: STOCK });
    expect(r.candles).toMatchObject({ '1d': 1, '1h': 1 });
    expect(r.errors.some((e) => e.startsWith('15m'))).toBe(true);
    expect(calls).toContain(`yahoo:${STOCK}@15m/60d`);
    expect(calls).toContain(`yahoo:${STOCK}@15m/1mo`);
  });

  it('Yahoo ohne Kerzen und ohne Treffer → NO_CANDLES, keine Zeile', async () => {
    const ghost = `GHOST${RUN}`;
    await expect(
      registerAsset(db, { venue: 'yahoo', symbol: ghost, userId }, { ...deps, searchYahoo: async () => [], ingestYahoo: async (_d, o) => ({ venue: 'yahoo', symbol: o.symbol, timeframe: o.timeframe!, fetched: 0, inserted: 0, rejected: 0, error: 'No data found' }) }),
    ).rejects.toMatchObject({ code: 'NO_CANDLES' });
    expect(await db.select().from(schema.assets).where(eq(schema.assets.dataSymbol, ghost))).toHaveLength(0);
  });

  it('registeredAssets: hinzugefügte und favorisierte Assets mit Quelle, Basis-Symbole vorn', async () => {
    const list = await registeredAssets(db);
    expect(list.slice(0, 3).map((r) => r.symbol)).toEqual(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
    expect(list.find((r) => r.symbol === PAIR)).toMatchObject({ venue: 'binance', assetType: 'CRYPTO' });
    expect(list.find((r) => r.symbol === STOCK)).toMatchObject({ venue: 'yahoo', assetType: 'STOCK', name: 'Registertest SE' });
  });
});
