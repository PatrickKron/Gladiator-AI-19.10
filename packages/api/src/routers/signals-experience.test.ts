/**
 * signals.executionPreview liefert den „Vorschlag aus Erfahrung" (13_ §7)
 * gegen die ECHTE DB (Server-CI; lokal ohne DATABASE_URL übersprungen).
 * study_trades-Zeilen und Venue sind deterministische Test-Fixtures.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type { TradingVenue } from '@gladiator/exchange';
import { recomputeStudyClusters } from '@gladiator/backtest';
import type pg from 'pg';
import { appRouter } from './index.js';
import { buildContext, createCallerFactory } from '../trpc.js';
import { register } from '../auth/service.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (hasDb && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;
}

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}-${Date.now()}`;
const SLUG = `exp-test-${RUN}`;
const SYMBOL = `EXP${process.pid}/USDT`;
const DAY = 86_400_000;

const venue: TradingVenue = {
  id: 'paper-internal',
  kind: 'paper',
  validate: async () => ({ ok: true, detail: 'test' }),
  marketRules: async () => ({ tickSize: 0.1, lotSize: 0.000001, minNotional: 5 }),
  markPrice: async () => 100,
  placeOrder: async () => {
    throw new Error('Vorschau platziert nie Orders');
  },
  cancelOrder: async () => {},
  fetchPositions: async () => [],
  fetchOpenOrders: async () => [],
};

describe.skipIf(!hasDb)('signals.executionPreview — Vorschlag aus Erfahrung', () => {
  let db: Db;
  let pool: pg.Pool;
  let caller: ReturnType<typeof createCaller>;
  let userId: string;
  let strategyId: string;

  async function signal(session: 'london' | 'asia'): Promise<string> {
    const [s] = await db
      .insert(schema.signals)
      .values({
        source: 'engine',
        strategyId,
        symbol: SYMBOL,
        timeframe: '4h',
        assetClass: 'crypto',
        venueType: 'cex',
        direction: 'long',
        setupType: 'swing',
        entry: '100',
        stopLoss: '95',
        takeProfits: ['105', '110', '115'],
        score: '8',
        riskClass: 'low',
        confluence: ['Test'],
        session,
        emaRegime: 'above',
        marketPhase: 'bull',
      })
      .returning();
    return s!.id;
  }

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const res = await register(db, { email: `exp-test-${RUN}@test.invalid`, password: 'sehr-sicheres-passwort-123' });
    userId = res.user.id;
    caller = createCaller(await buildContext({ db, venue, authorizationHeader: `Bearer ${res.accessToken}` }));
    const [s] = await db.insert(schema.strategies).values({ slug: SLUG, name: 'Exp Test', kind: 'builtin' }).returning();
    strategyId = s!.id;
    await db.insert(schema.tradingSettings).values({ userId, maxLeverage: '3', riskPctPerTrade: '0.5' });

    const key = `${SLUG}|${SYMBOL}|swing|4h|london|uptrend`;
    const now = new Date();
    await db.insert(schema.studyTrades).values(
      Array.from({ length: 60 }, (_, k) => {
        const r = k % 2 === 0 ? 2 : -0.04;
        const exitTs = new Date(now.getTime() - (61 - k) * DAY);
        return {
          clusterKey: key,
          direction: 'long' as const,
          entryTs: new Date(exitTs.getTime() - 3_600_000),
          exitTs,
          rMultiple: String(r),
          maeBps: '50',
          netPnl: String(r * 10),
          pnlRTpA: String(r),
          pnlRTpB: String(r),
          pnlRTpC: String(r),
          pnlRTpD: String(r),
        };
      }),
    );
    await recomputeStudyClusters(db, { keyPrefix: `${SLUG}|` });
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM study_trades WHERE cluster_key LIKE ${SLUG + '|%'}`);
    await db.execute(sql`DELETE FROM study_clusters WHERE cluster_key LIKE ${SLUG + '|%'}`);
    await db.execute(sql`DELETE FROM signals WHERE strategy_id = ${strategyId}`);
    await db.execute(sql`DELETE FROM strategies WHERE id = ${strategyId}`);
    await db.execute(sql`DELETE FROM trading_settings WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM audit_log WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM sessions WHERE user_id = ${userId}`);
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end();
  });

  it('passender Cluster → Vorschlag mit n Trades, gedeckelt auf maxLeverage/Risiko % der Settings', async () => {
    const p = await caller.signals.executionPreview({ id: await signal('london') });
    expect(p.experience.available).toBe(true);
    if (!p.experience.available) return;
    expect(p.experience.tradeCount).toBe(60);
    expect(p.experience.leverage).toBeLessThanOrEqual(3);
    expect(p.experience.riskPct).toBeLessThanOrEqual(0.5);
    expect(p.experience.capped.leverage).toBe(true); // Gitter wollte 10×
  });

  it('Session ohne eigene Historie → Fallback auf den Basis-Cluster derselben Strategie', async () => {
    const p = await caller.signals.executionPreview({ id: await signal('asia') });
    expect(p.experience).toMatchObject({ available: true, level: 'base', tradeCount: 60 });
  });
});
