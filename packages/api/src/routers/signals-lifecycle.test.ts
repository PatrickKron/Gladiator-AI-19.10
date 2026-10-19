/**
 * signals.list liefert die 05_-§9-Informationen für die Signal-Karte
 * (Reentry-Plan, Hebel-Vorschlag, Auto-Kill-Grund aus dem Audit-Log) —
 * gegen die ECHTE DB (Server-CI; lokal ohne DATABASE_URL übersprungen).
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
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
const EMAIL = `lifecycle-api-${RUN}@test.invalid`;
const SYMBOL = `LCA${process.pid}/USDT`;
const { users, strategies, signals, auditLog } = schema;

describe.skipIf(!hasDb)('signals.list: Reentry / Hebel-Vorschlag / Auto-Kill-Grund', () => {
  let db: Db;
  let pool: pg.Pool;
  let caller: ReturnType<typeof createCaller>;
  let strategyId: string;
  let killedId: string;
  let filledId: string;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const res = await register(db, { email: EMAIL, password: 'sehr-sicheres-passwort-123', name: 'Lifecycle' });
    caller = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${res.accessToken}` }));
    const [s] = await db.insert(strategies).values({ slug: `lifecycle-api-${RUN}`, name: 'Lifecycle API', kind: 'builtin' }).returning();
    strategyId = s!.id;
    const base = {
      source: 'engine' as const, strategyId, symbol: SYMBOL, timeframe: '1h', assetClass: 'crypto' as const, venueType: 'cex' as const,
      direction: 'long' as const, setupType: 'swing' as const, entry: '100', stopLoss: '90', takeProfits: ['110'], score: '8',
      riskClass: 'low' as const, confluence: ['Test'], session: 'london' as const,
      reentry: { enabled: true, minPullbackPct: 1.5, maxPullbackPct: 2.5, zoneLow: 97.5, zoneHigh: 98.5, maxReentries: 1, generation: 0 },
    };
    const [k] = await db.insert(signals).values({ ...base, status: 'expired' }).returning();
    killedId = k!.id;
    await db.insert(auditLog).values({
      actor: 'signal-lifecycle', action: 'signal.auto_killed', entityType: 'signal', entityId: killedId,
      details: { reason: 'stop_breached', score: 8, rescored: null, threshold: 6.5 },
    });
    const [f] = await db
      .insert(signals)
      .values({
        ...base,
        status: 'filled',
        leverageUpgrade: {
          triggerPct: 5, multiplier: 1.5, maxLeverage: 10,
          suggestion: { suggested: 1.5, from: 1, movePct: 11, reason: 'x', at: new Date().toISOString(), positionId: 'p', price: 111 },
        },
      })
      .returning();
    filledId = f!.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM audit_log WHERE entity_id IN (${killedId}, ${filledId})`);
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email = ${EMAIL})`);
    await db.execute(sql`DELETE FROM signals WHERE strategy_id = ${strategyId}`);
    await db.execute(sql`DELETE FROM strategies WHERE id = ${strategyId}`);
    await db.delete(users).where(eq(users.email, EMAIL));
    await pool.end();
  });

  it('liefert Plan, Vorschlag und Kill-Grund je Signal', async () => {
    const rows = await caller.signals.list({ status: ['expired', 'filled'], symbol: SYMBOL });
    const killed = rows.find((r) => r.id === killedId)!;
    const filled = rows.find((r) => r.id === filledId)!;
    expect(killed.autoKill).toMatchObject({ reason: 'stop_breached' });
    expect(killed.reentry).toMatchObject({ enabled: true, zoneLow: 97.5, zoneHigh: 98.5 });
    expect(filled.autoKill).toBeNull();
    expect(filled.leverageUpgrade?.suggestion).toMatchObject({ suggested: 1.5, from: 1 });
  });
});
