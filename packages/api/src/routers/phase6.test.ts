/**
 * Phase-6-Router (Settings/Product/Agents/Promotion) gegen die ECHTE DB —
 * Server-CI maßgeblich; lokal ohne DATABASE_URL übersprungen.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { appRouter } from './index.js';
import { buildContext, createCallerFactory } from '../trpc.js';
import { register } from '../auth/service.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  console.warn('[phase6.test] DATABASE_URL nicht gesetzt — übersprungen (Server-CI maßgeblich).');
}
if (hasDb && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;
}

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}-${Date.now()}`;
const EMAIL = `phase6-test-${RUN}@test.invalid`;

const { users, strategies, strategyVersions } = schema;

describe.skipIf(!hasDb)('Phase-6-Router (Settings, Product, Agents, Promotion)', () => {
  let db: Db;
  let pool: pg.Pool;
  let caller: ReturnType<typeof createCaller>;
  let strategyId: string;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const res = await register(db, { email: EMAIL, password: 'sehr-sicheres-passwort-123', name: 'Phase6' });
    caller = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${res.accessToken}` }));
    const [s] = await db
      .insert(strategies)
      .values({ slug: `phase6-test-${RUN}`, name: 'Phase6-Test', kind: 'dsl' })
      .returning();
    strategyId = s!.id;
  });

  afterAll(async () => {
    await db.delete(strategies).where(eq(strategies.id, strategyId));
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email = ${EMAIL})`);
    await db.delete(users).where(eq(users.email, EMAIL));
    await pool.end();
  });

  it('settings: get legt Default-Zeile an, update ändert Werte, Risk-Engine liest dieselben', async () => {
    const initial = await caller.settings.get();
    expect(initial.mode).toBe('paper');
    expect(initial.killSwitchActive).toBe(false);

    await caller.settings.update({
      riskPctPerTrade: 0.5,
      maxLeverage: 3,
      maxOpenPositions: 2,
      maxExposurePctPerAsset: 10,
      dailyLossLimitPct: 2,
      weeklyLossLimitPct: 5,
      maxDrawdownPct: 12,
    });
    const updated = await caller.settings.get();
    expect(updated.riskPctPerTrade).toBe(0.5);
    expect(updated.maxLeverage).toBe(3);
    expect(updated.maxOpenPositions).toBe(2);
  });

  it('settings: Kill-Switch schaltet und wird auditiert', async () => {
    const on = await caller.settings.setKillSwitch({ active: true });
    expect(on.killSwitchActive).toBe(true);
    const off = await caller.settings.setKillSwitch({ active: false });
    expect(off.killSwitchActive).toBe(false);
    const audits = await db.execute(
      sql`SELECT action FROM audit_log WHERE action IN ('risk.kill_switch.on','risk.kill_switch.off') ORDER BY created_at DESC LIMIT 2`,
    );
    expect(audits.rows.length).toBe(2);
  });

  it('settings: ungültige Werte werden abgelehnt (Zod)', async () => {
    await expect(
      caller.settings.update({
        riskPctPerTrade: 99, // > 5 %
        maxLeverage: 3,
        maxOpenPositions: 2,
        maxExposurePctPerAsset: 10,
        dailyLossLimitPct: 2,
        weeklyLossLimitPct: 5,
        maxDrawdownPct: 12,
      }),
    ).rejects.toThrow();
  });

  it('product: echte v1-Pakete + Assets + Artikel aus der DB', async () => {
    const pkgs = await caller.product.packages();
    expect(pkgs.length).toBeGreaterThan(0);
    const withAssets = pkgs.find((p) => p.assetCount > 0);
    if (withAssets) {
      const assets = await caller.product.assets({ packageId: withAssets.id });
      expect(assets.length).toBeGreaterThan(0);
      expect(assets[0]!.ticker.length).toBeGreaterThan(0);
    }
    const articles = await caller.product.articles({ limit: 10 });
    expect(Array.isArray(articles)).toBe(true);
  });

  it('agents.status: aktive + ehrlich deaktivierte Agenten mit Grund', async () => {
    const status = await caller.agents.status();
    expect(status.active.map((a) => a.agent)).toEqual(['technik', 'risk', 'devil', 'portfolio']);
    expect(status.disabled.map((d) => d.agent).sort()).toEqual(['makro', 'shadow']);
    for (const d of status.disabled) expect(d.reason.length).toBeGreaterThan(10);
    expect(status.llm.dailyBudgetUsd).toBeGreaterThan(0);
  });

  it('strategies: versions + promote draft→paper (Mensch im Loop); paper→live gesperrt', async () => {
    const [draft] = await db
      .insert(strategyVersions)
      .values({ strategyId, version: 1, params: { test: true }, status: 'draft' })
      .returning();

    const promoted = await caller.strategies.promote({ versionId: draft!.id });
    expect(promoted.status).toBe('paper');

    // Zweite Promotion (paper → live) ist bewusst NICHT möglich
    await expect(caller.strategies.promote({ versionId: draft!.id })).rejects.toThrow(/draft/);

    const versions = await caller.strategies.versions({ strategyId });
    expect(versions.length).toBe(1);
    expect(versions[0]!.status).toBe('paper');
  });
});
