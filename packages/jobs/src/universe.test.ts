import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { normalizeTradingPair, buildUniverse, MAX_UNIVERSE, scanUniverse } from './universe.js';
import { alertTriggered } from './alerts.js';

/** Scan-Universum aus Favoriten (Patrick-Lücke 1/5) + Alert-Trigger-Logik (Lücke 7) — pur, TDD. */

describe('normalizeTradingPair', () => {
  it.each([
    ['BTCUSDT', 'BTC/USDT'],
    ['btc/usdt', 'BTC/USDT'],
    ['SOLUSDC', 'SOL/USDC'],
    ['AAPL', null], // kein Krypto-Paar → ehrlich null
    ['', null],
  ])('%s → %s', (input, expected) => {
    expect(normalizeTradingPair(input)).toBe(expected);
  });
});

describe('buildUniverse', () => {
  it('Basis-Symbole immer enthalten; Favoriten-Paare ergänzt, dedupliziert, Cap 40', () => {
    const u = buildUniverse(['BTCUSDT', 'DOGEUSDT', 'DOGEUSDT', 'AAPL', 'LINKUSDT']);
    expect(u.slice(0, 3)).toEqual(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
    expect(u).toContain('DOGE/USDT');
    expect(u).toContain('LINK/USDT');
    expect(new Set(u).size).toBe(u.length); // dedupe
    expect(u.length).toBeLessThanOrEqual(40);
  });

  it('Cap 40: der 41. Favorit fällt weg, nichts stürzt', () => {
    const favs = Array.from({ length: 60 }, (_, i) => `T${i}USDT`);
    const u = buildUniverse(favs);
    expect(u.length).toBe(40);
    expect(u.slice(0, 3)).toEqual(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
  });

  it('nicht-Krypto-Favoriten (Aktien) werden ehrlich ignoriert (kein Binance-Feed)', () => {
    const u = buildUniverse(['AAPL', 'MSFT']);
    expect(u).toEqual(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
  });

  it('Eingabe-Reihenfolge = Priorität (jüngster Stern zuerst), nicht alphabetisch; Cap ist dokumentiert 40', () => {
    expect(MAX_UNIVERSE).toBe(40);
    expect(buildUniverse(['ZECUSDT', 'ADAUSDT', 'MATIC/USDT'])).toEqual(['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'ZEC/USDT', 'ADA/USDT', 'MATIC/USDT']);
    // beim Cap fallen die ÄLTESTEN (hinten) weg
    const favs = Array.from({ length: 50 }, (_, i) => `N${i}USDT`);
    expect(buildUniverse(favs).at(-1)).toBe('N36/USDT');
  });
});

describe.skipIf(!process.env.DATABASE_URL)('scanUniverse gegen die echte DB', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  let pkgId: number;
  const RUN = `${process.pid}${Date.now() % 100000}`;
  const OLD = `UOLD${RUN}USDT`;
  const NEW = `UNEW${RUN}USDT`;
  const YAH = `UYAH${RUN}USDT`;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [u] = await db.insert(schema.users).values({ email: `universe-${RUN}@test.invalid` }).returning();
    userId = u!.id;
    const [p] = await db.insert(schema.packages).values({ packageId: `pkg-uni-${RUN}`, name: 'Universum-Test', category: 'DIGITAL_ASSETS' }).returning();
    pkgId = p!.id;
    const rows = await db
      .insert(schema.assets)
      .values([
        { assetId: `uni-old-${RUN}`, packageId: pkgId, ticker: 'UOLD', name: 'Old', assetType: 'CRYPTO', tradingPair: OLD },
        { assetId: `uni-new-${RUN}`, packageId: pkgId, ticker: 'UNEW', name: 'New', assetType: 'CRYPTO', tradingPair: NEW },
        // gleiches Paar-Muster, aber Kerzenquelle Yahoo → gehört nicht in den Krypto-Scan
        { assetId: `uni-yah-${RUN}`, packageId: pkgId, ticker: 'UYAH', name: 'Yah', assetType: 'STOCK', tradingPair: YAH, candleVenue: 'yahoo', dataSymbol: `UYAH${RUN}` },
      ])
      .returning();
    const id = (t: string) => rows.find((r) => r.tradingPair === t)!.id;
    const now = Date.now();
    await db.insert(schema.assetFavorites).values([
      { userId, assetId: id(OLD), createdAt: new Date(now - 60_000) },
      { userId, assetId: id(NEW), createdAt: new Date(now) },
      { userId, assetId: id(YAH), createdAt: new Date(now) },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId)); // Favoriten cascaden
    await db.delete(schema.assets).where(inArray(schema.assets.packageId, [pkgId]));
    await db.delete(schema.packages).where(eq(schema.packages.id, pkgId));
    await pool.end();
  });

  it('jüngster Stern zuerst, Assets anderer Kerzenquellen bleiben draußen', async () => {
    const u = await scanUniverse(db);
    const iNew = u.indexOf(normalizeTradingPair(NEW)!);
    const iOld = u.indexOf(normalizeTradingPair(OLD)!);
    expect(iNew).toBeGreaterThanOrEqual(3);
    expect(iOld).toBeGreaterThan(iNew);
    expect(u).not.toContain(normalizeTradingPair(YAH));
  });
});

describe('alertTriggered', () => {
  it('above: löst bei Preis ≥ Ziel aus', () => {
    expect(alertTriggered('above', 100, 100)).toBe(true);
    expect(alertTriggered('above', 100, 101.5)).toBe(true);
    expect(alertTriggered('above', 100, 99.99)).toBe(false);
  });
  it('below: löst bei Preis ≤ Ziel aus', () => {
    expect(alertTriggered('below', 100, 100)).toBe(true);
    expect(alertTriggered('below', 100, 98)).toBe(true);
    expect(alertTriggered('below', 100, 100.01)).toBe(false);
  });
});
