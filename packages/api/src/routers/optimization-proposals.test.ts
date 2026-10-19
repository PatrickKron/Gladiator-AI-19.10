/**
 * Optimierungs-Vorschläge im Labor-Router gegen die ECHTE DB (Server-CI
 * maßgeblich; lokal ohne DATABASE_URL übersprungen): auflisten, übernehmen
 * (→ NEUE draft-Version, Promotion bleibt beim regulären Gate), verwerfen.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type { OptimizationProposalResults } from '@gladiator/backtest';
import type pg from 'pg';
import { appRouter } from './index.js';
import { buildContext, createCallerFactory } from '../trpc.js';
import { register } from '../auth/service.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) console.warn('[optimization-proposals.test] DATABASE_URL nicht gesetzt — übersprungen (Server-CI maßgeblich).');
if (hasDb && !process.env.JWT_SECRET) process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}-${Date.now()}`;
const EMAIL = `optprop-test-${RUN}@test.invalid`;
const { users, strategies, strategyVersions, optimizations, auditLog } = schema;

const baseDsl = {
  id: `optprop-${RUN}`.slice(0, 60),
  symbol: 'BTC/USDT',
  timeframe: '1h',
  venueType: 'cex',
  direction: 'long',
  setupType: 'swing',
  when: { all: [{ trend: 'EMA200_up' }] },
  entry: 'market',
  stopLoss: { type: 'pct', pct: 1 },
  takeProfits: [{ rr: 1 }, { rr: 2 }],
  risk: { maxLeveragePerTrade: 1, riskPctPerTrade: 1 },
};
const proposedDsl = { ...baseDsl, stopLoss: { type: 'pct', pct: 1.25 } };

const summary = (expectancy: number) => ({
  tradeCount: 40,
  netPnl: 100,
  winRate: 0.5,
  profitFactor: 1.4,
  expectancy,
  maxDrawdownPct: 5,
  netReturnPct: 1,
  sharpe: 1,
});
const results = (): OptimizationProposalResults => ({
  kind: 'dsl',
  strategySlug: `optprop-${RUN}`,
  baseVersion: 1,
  review: { state: 'open', at: null },
  window: { from: '2026-01-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z', oosFrom: null, oosTo: null, windows: 4, isBars: 1000, oosBars: 250 },
  before: summary(0.1),
  after: summary(0.4),
  holdout: { fromTs: '2026-03-01T00:00:00.000Z', tradeCount: 12, expectancy: 0.3, profitFactor: 1.5 },
  wins: 3,
  checks: [{ name: 'validity', passed: true, detail: 'ok' }],
  changes: [{ path: 'stopLoss.pct', from: 1, to: 1.25 }],
  markets: [],
});

describe.skipIf(!hasDb)('lab: Optimierungs-Vorschläge (Mensch im Loop)', () => {
  let db: Db;
  let pool: pg.Pool;
  let caller: ReturnType<typeof createCaller>;
  let strategyId: string;
  let baseVersionId: string;
  let propA: string;
  let propB: string;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const res = await register(db, { email: EMAIL, password: 'sehr-sicheres-passwort-123', name: 'OptProp' });
    caller = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${res.accessToken}` }));
    const [s] = await db.insert(strategies).values({ slug: `optprop-${RUN}`, name: 'OptProp-Test', kind: 'dsl' }).returning();
    strategyId = s!.id;
    const [v] = await db.insert(strategyVersions).values({ strategyId, version: 1, params: baseDsl, status: 'paper' }).returning();
    baseVersionId = v!.id;
    const rows = await db
      .insert(optimizations)
      .values([
        { strategyId, baseVersionId, method: 'walk-forward-grid', paramSpace: {}, results: results(), bestParams: proposedDsl, bestScore: '0.4', status: 'done' },
        { strategyId, baseVersionId, method: 'walk-forward-grid', paramSpace: {}, results: results(), bestParams: proposedDsl, bestScore: '0.4', status: 'done' },
      ])
      .returning();
    propA = rows[0]!.id;
    propB = rows[1]!.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email = ${EMAIL})`);
    await db.delete(auditLog).where(inArray(auditLog.entityId, [propA, propB]));
    await db.delete(strategies).where(eq(strategies.id, strategyId));
    await db.delete(users).where(eq(users.email, EMAIL));
    await pool.end();
  });

  it('proposals listet offene Vorschläge mit Vorher/Nachher und Änderungen', async () => {
    const list = await caller.lab.proposals({ state: 'open' });
    const mine = list.filter((p) => p.strategyId === strategyId);
    expect(mine.map((p) => p.id).sort()).toEqual([propA, propB].sort());
    const a = mine.find((p) => p.id === propA)!;
    expect(a.state).toBe('open');
    expect(a.slug).toBe(`optprop-${RUN}`);
    expect(a.baseVersion).toBe(1);
    expect(a.results.before.expectancy).toBe(0.1);
    expect(a.results.after.expectancy).toBe(0.4);
    expect(a.results.changes).toEqual([{ path: 'stopLoss.pct', from: 1, to: 1.25 }]);
  });

  it('acceptProposal legt eine NEUE draft-Version mit den vorgeschlagenen Parametern an — Basis bleibt paper', async () => {
    const out = await caller.lab.acceptProposal({ id: propA });
    expect(out.version).toBe(2);
    const [created] = await db.select().from(strategyVersions).where(eq(strategyVersions.id, out.versionId));
    expect(created!.status).toBe('draft');
    expect(created!.params).toEqual(proposedDsl);
    const [base] = await db.select().from(strategyVersions).where(eq(strategyVersions.id, baseVersionId));
    expect(base!.status).toBe('paper');

    const [row] = await db.select().from(optimizations).where(eq(optimizations.id, propA));
    const r = row!.results as OptimizationProposalResults;
    expect(r.review.state).toBe('accepted');
    expect(r.review.newVersionId).toBe(out.versionId);
    expect(r.review.newVersion).toBe(2);

    const audits = await db.select().from(auditLog).where(sql`${auditLog.action} = 'strategy.optimization.accepted' AND ${auditLog.entityId} = ${propA}`);
    expect(audits).toHaveLength(1);
  });

  it('zweites Übernehmen desselben Vorschlags → CONFLICT (keine Doppel-Version)', async () => {
    await expect(caller.lab.acceptProposal({ id: propA })).rejects.toThrow(/bereits/);
    const versions = await db.select().from(strategyVersions).where(eq(strategyVersions.strategyId, strategyId));
    expect(versions).toHaveLength(2);
  });

  it('rejectProposal verwirft (auditiert) und taucht nicht mehr unter „offen" auf', async () => {
    await caller.lab.rejectProposal({ id: propB, reason: 'Test' });
    const [row] = await db.select().from(optimizations).where(eq(optimizations.id, propB));
    expect((row!.results as OptimizationProposalResults).review.state).toBe('rejected');
    const open = await caller.lab.proposals({ state: 'open' });
    expect(open.some((p) => p.id === propB)).toBe(false);
    const all = await caller.lab.proposals({ state: 'all' });
    expect(all.find((p) => p.id === propB)?.state).toBe('rejected');
    await expect(caller.lab.acceptProposal({ id: propB })).rejects.toThrow(/bereits/);
  });

  it('unbekannte ID → NOT_FOUND', async () => {
    await expect(caller.lab.acceptProposal({ id: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow(/nicht gefunden/);
  });
});
