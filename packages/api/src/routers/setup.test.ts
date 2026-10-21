/**
 * Einrichtungs-Fortschritt gegen die ECHTE DB (Server-CI; lokal ohne DATABASE_URL
 * übersprungen): frischer Nutzer 0/5, dann Schritt für Schritt aus echten
 * Zuständen — Audit, Favorit, Demo-Order (über den Router), Push-Abo, Börse.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type { DemoBookSource, MarketRules, OrderBookSnapshot } from '@gladiator/exchange';
import type pg from 'pg';
import { appRouter } from './index.js';
import { buildContext, createCallerFactory } from '../trpc.js';
import { register } from '../auth/service.js';
import { setDemoBookSourceForTests } from './demo.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  console.warn('[setup.test] DATABASE_URL nicht gesetzt — übersprungen (Server-CI maßgeblich).');
}
if (hasDb && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;
}

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}-${Date.now()}`;
const EMAIL = `setup-test-${RUN}@test.invalid`;
const PKG = `setup-pkg-${RUN}`;
const { users, packages, assets, assetFavorites, pushSubscriptions, exchangeConnections } = schema;

class FakeBookSource implements DemoBookSource {
  async fetchBook(symbol: string): Promise<OrderBookSnapshot> {
    return { symbol, ts: 0, bids: [{ price: 50_000, qty: 10 }], asks: [{ price: 50_100, qty: 10 }] };
  }
  async marketRules(): Promise<MarketRules> {
    return { tickSize: 0.01, lotSize: 0.000001, minNotional: 5 };
  }
}

describe.skipIf(!hasDb)('setup.progress: fünf echte Schritte', () => {
  let db: Db;
  let pool: pg.Pool;
  let caller: ReturnType<typeof createCaller>;
  let userId: string;
  let packageId: number;
  let assetId: number;
  const envTelegram = { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };

  beforeAll(async () => {
    ({ db, pool } = createDb());
    setDemoBookSourceForTests(new FakeBookSource());
    // Telegram aus der Umgebung darf den Test nicht „fertig" machen — die DB-Zeilen bleiben unberührt.
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    const res = await register(db, { email: EMAIL, password: 'sehr-sicheres-passwort-123', name: 'Setup' });
    userId = res.user.id;
    caller = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${res.accessToken}` }));
    const [pkg] = await db.insert(packages).values({ packageId: PKG, name: PKG, description: 'Test', category: 'crypto' }).returning({ id: packages.id });
    packageId = pkg!.id;
    const [asset] = await db
      .insert(assets)
      .values({ assetId: `${PKG}-asset`, packageId, ticker: `SETUP${process.pid}`, name: 'Setup Asset', assetType: 'crypto', tradingPair: 'BTC/USDT' })
      .returning({ id: assets.id });
    assetId = asset!.id;
  });

  afterAll(async () => {
    setDemoBookSourceForTests(null);
    if (envTelegram.token) process.env.TELEGRAM_BOT_TOKEN = envTelegram.token;
    if (envTelegram.chat) process.env.TELEGRAM_CHAT_ID = envTelegram.chat;
    await db.execute(sql`DELETE FROM audit_log WHERE user_id = ${userId}::uuid`);
    await db.delete(users).where(eq(users.email, EMAIL)); // Favoriten, Demo-*, Push, Börsen cascaden
    await db.delete(assets).where(eq(assets.id, assetId));
    await db.delete(packages).where(eq(packages.id, packageId));
    await pool.end();
  });

  it('frischer Nutzer: 0 von 5, Reihenfolge fest', async () => {
    const p = await caller.setup.progress();
    expect(p.total).toBe(5);
    expect(p.steps.map((s) => s.id)).toEqual(['risk', 'watch', 'paperTrade', 'notify', 'exchange']);
    const telegramInDb = p.steps.find((s) => s.id === 'notify')!.done; // DB-Telegram des Hosts zählt ehrlich mit
    expect(p.steps.filter((s) => s.id !== 'notify').every((s) => !s.done)).toBe(true);
    expect(p.done).toBe(telegramInDb ? 1 : 0);
  });

  it('Risiko gespeichert (Audit), Favorit, Demo-Order, Push-Abo, Börse → jeder Schritt wird wahr', async () => {
    await caller.settings.update({
      riskPctPerTrade: 1,
      maxLeverage: 3,
      maxOpenPositions: 3,
      maxExposurePctPerAsset: 20,
      dailyLossLimitPct: 3,
      weeklyLossLimitPct: 7,
      maxDrawdownPct: 15,
    });
    let p = await caller.setup.progress();
    expect(p.steps.find((s) => s.id === 'risk')!.done).toBe(true);

    await db.insert(assetFavorites).values({ userId, assetId });
    p = await caller.setup.progress();
    expect(p.steps.find((s) => s.id === 'watch')!.done).toBe(true);

    const r = await caller.demo.placeOrder({ symbol: 'BTC/USDT', direction: 'long', type: 'market', qty: 0.01 });
    expect(r.placed).toBe(true);
    p = await caller.setup.progress();
    expect(p.steps.find((s) => s.id === 'paperTrade')!.done).toBe(true);

    await db.insert(pushSubscriptions).values({ userId, endpoint: `https://push.invalid/${RUN}`, keys: { p256dh: 'x', auth: 'y' } });
    p = await caller.setup.progress();
    expect(p.steps.find((s) => s.id === 'notify')!.done).toBe(true);

    await db.insert(exchangeConnections).values({ userId, exchangeId: 'kraken', exchangeName: 'Kraken', encryptedPayload: 'test-ciphertext', keyLast4: 'test' });
    p = await caller.setup.progress();
    expect(p.steps.find((s) => s.id === 'exchange')!.done).toBe(true);
    expect(p.done).toBe(5);
  });

  it('widerrufene Börse und widerrufenes Push-Abo zählen nicht mehr', async () => {
    await db.update(exchangeConnections).set({ status: 'revoked' }).where(eq(exchangeConnections.userId, userId));
    await db.update(pushSubscriptions).set({ revokedAt: new Date() }).where(eq(pushSubscriptions.userId, userId));
    const p = await caller.setup.progress();
    expect(p.steps.find((s) => s.id === 'exchange')!.done).toBe(false);
    const telegramInDb = (await db.execute(sql`SELECT count(*)::int AS n FROM app_secrets WHERE key IN ('TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID')`)).rows[0] as { n: number };
    expect(p.steps.find((s) => s.id === 'notify')!.done).toBe(telegramInDb.n === 2);
  });
});
