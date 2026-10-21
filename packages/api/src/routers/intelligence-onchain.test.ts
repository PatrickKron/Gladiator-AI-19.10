/**
 * DNA-Quadrant über die API (echte DB für die Anmeldung): vollständige
 * Antwort 1 h gecacht, unvollständige (Quelle down) nie — der nächste Aufruf
 * fragt neu. Quellen injiziert; echte Daten prüft market-data/onchain.test.ts.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@gladiator/db';
import type pg from 'pg';
import { appRouter } from './index.js';
import { setOnchainFetchForTests } from './intelligence.js';
import { buildContext, createCallerFactory } from '../trpc.js';
import { register } from '../auth/service.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (hasDb && !process.env.JWT_SECRET) process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;

const createCaller = createCallerFactory(appRouter);
const EMAIL = `onchain-${process.pid}-${Date.now()}@test.invalid`;
const DAY = 86_400_000;

let calls = 0;
let cmDown = false;
const net = (async (url: string) => {
  calls++;
  const u = String(url);
  if (u.includes('coinmetrics')) {
    if (cmDown) return new Response('weg', { status: 503 });
    const start = Date.now() - 120 * DAY;
    const data = Array.from({ length: 120 }, (_, i) => [
      { asset: 'btc', time: new Date(start + i * DAY).toISOString(), CapMVRVCur: String(1.5 + i / 200), AdrActCnt: String(800_000 + i) },
      { asset: 'eth', time: new Date(start + i * DAY).toISOString(), CapMVRVCur: String(0.9), AdrActCnt: String(450_000) },
    ]).flat();
    return new Response(JSON.stringify({ data }));
  }
  const start = Math.floor((Date.now() - 40 * DAY) / 1000);
  return new Response(JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ date: String(start + i * 86_400), totalCirculatingUSD: { peggedUSD: 200e9 + i * 1e9 } }))));
}) as unknown as typeof fetch;

describe.skipIf(!hasDb)('intelligence.onchain (DNA)', () => {
  let db: Db;
  let pool: pg.Pool;
  let a: ReturnType<typeof createCaller>;

  beforeAll(async () => {
    setOnchainFetchForTests(net);
    ({ db, pool } = createDb());
    const r = await register(db, { email: EMAIL, password: 'sehr-sicheres-passwort-123', name: 'O' });
    a = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${r.accessToken}` }));
  });

  afterAll(async () => {
    setOnchainFetchForTests(null);
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email = ${EMAIL})`);
    await db.execute(sql`DELETE FROM users WHERE email = ${EMAIL}`);
    await pool.end();
  });

  it('echte Felder; vollständige Antwort gecacht', async () => {
    const s = await a.intelligence.onchain();
    expect(s.assets.map((x) => [x.asset, x.zone])).toEqual([
      ['btc', 'overheated'], // steigende Reihe → aktueller Wert ist das Hoch
      ['eth', 'undervalued'], // MVRV < 1
    ]);
    expect(s.stablecoins.totalUsd).toBe(239e9);
    const before = calls;
    await a.intelligence.onchain();
    expect(calls).toBe(before);
  });

  it('Quelle down → ehrlicher Fehler, nicht gecacht', async () => {
    setOnchainFetchForTests(net);
    cmDown = true;
    const s = await a.intelligence.onchain();
    expect(s.assets[0]).toMatchObject({ mvrv: null, error: expect.stringMatching(/Coin Metrics nicht erreichbar/) });
    const before = calls;
    cmDown = false;
    const s2 = await a.intelligence.onchain();
    expect(calls).toBeGreaterThan(before);
    expect(s2.assets[0]!.mvrv).not.toBeNull();
  });
});
