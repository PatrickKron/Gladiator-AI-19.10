/**
 * Asset-News-Zuordnung (Mängelliste 7): Ticker ODER Asset-Name als ganzes Wort — gegen die
 * ECHTE DB (lokal mit DATABASE_URL, sonst übersprungen; Server-CI maßgeblich).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { assetNews, nameRegex, wordBoundaryRegex } from './asset-news.js';

describe('nameRegex', () => {
  it('lässt Füllwörter weg, hält Mehrwort-Namen zusammen, nichts Signifikantes → null', () => {
    expect(nameRegex('Newscoin Token')).toBe('\\mnewscoin\\M');
    expect(nameRegex('Bitcoin Cash')).toBe('\\mbitcoin[^[:alnum:]]+cash\\M');
    expect(nameRegex('Coca-Cola Company')).toBe('\\mcoca[^[:alnum:]]+cola\\M');
    expect(nameRegex('The Token')).toBeNull();
  });
});

describe('wordBoundaryRegex', () => {
  it('setzt Wortgrenzen und entschärft Regex-Sonderzeichen', () => {
    expect(wordBoundaryRegex('BTC')).toBe('\\mBTC\\M');
    expect(wordBoundaryRegex('EURUSD=X')).toBe('\\mEURUSD=X\\M');
    expect(wordBoundaryRegex('C.A+')).toBe('\\mC\\.A\\+\\M');
  });
});

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) console.warn('[asset-news.test] DATABASE_URL nicht gesetzt — DB-Teil übersprungen (Server-CI maßgeblich).');

describe.skipIf(!hasDb)('assetNews gegen die echte DB', () => {
  let db: Db;
  let pool: pg.Pool;
  const RUN = `${process.pid}-${Date.now()}`;
  const urls = [`https://t.invalid/${RUN}/1`, `https://t.invalid/${RUN}/2`, `https://t.invalid/${RUN}/3`, `https://t.invalid/${RUN}/4`];
  let packageRowId: number;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [pkg] = await db.insert(schema.packages).values({ packageId: `pkg-news-${RUN}`, name: 'News-Test', category: 'crypto' }).returning();
    packageRowId = pkg!.id;
    await db.insert(schema.assets).values({ assetId: `asset-news-${RUN}`, packageId: packageRowId, ticker: `NWS${RUN.slice(-4)}`, name: 'Newscoin Token', assetType: 'crypto', tradingPair: `NWS${RUN.slice(-4)}/USDT` });
    const now = Date.now();
    await db.insert(schema.newsItems).values([
      { source: 'test', title: `Newscoin rallies after upgrade (${RUN})`, url: urls[0]!, publishedAt: new Date(now - 1_000) },
      { source: 'test', title: `NWS${RUN.slice(-4)} listed on exchange (${RUN})`, url: urls[1]!, publishedAt: new Date(now - 2_000) },
      { source: 'test', title: `somethingNWS${RUN.slice(-4)}else is unrelated (${RUN})`, url: urls[2]!, publishedAt: new Date(now - 3_000) },
      { source: 'test', title: `Another coin, nothing to do with it (${RUN})`, url: urls[3]!, publishedAt: new Date(now - 4_000) },
    ]);
  });
  afterAll(async () => {
    await db.delete(schema.newsItems).where(inArray(schema.newsItems.url, urls));
    await db.delete(schema.assets).where(eq(schema.assets.packageId, packageRowId));
    await db.delete(schema.packages).where(eq(schema.packages.id, packageRowId));
    await pool.end();
  });

  it('trifft über Ticker UND Asset-Namen als ganzes Wort, nicht als Teilwort; neueste zuerst; mit Quelle', async () => {
    const ticker = `NWS${RUN.slice(-4)}`;
    const hits = await assetNews(db, `${ticker}/USDT`);
    expect(hits.map((h) => h.url)).toEqual([urls[0], urls[1]]);
    expect(hits[0]).toMatchObject({ source: 'test' });
    expect(typeof hits[0]!.publishedAt).toBe('string');
    // Symbol ohne Asset-Zeile: nur der Ticker zählt
    expect((await assetNews(db, `${ticker}X/USDT`)).length).toBe(0);
  });
});
