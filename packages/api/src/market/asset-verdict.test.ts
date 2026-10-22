/**
 * KI-Urteil je Asset: Gate (nur mit verbundener Datenquelle) rein; gegen die echte DB mit
 * Fake-Provider — unbekanntes Symbol ⇒ beide Agenten „nicht verbunden“, Provider wird NICHT gerufen.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, schema, type Db } from '@gladiator/db';
import type { LlmProvider } from '@gladiator/agents';
import type pg from 'pg';
import { register } from '../auth/service.js';
import type { AssetAnalysis } from './asset-analysis.js';
import { assetVerdicts, verdictGate } from './asset-verdict.js';

const base: AssetAnalysis = {
  symbol: 'X/USDT',
  asOf: new Date().toISOString(),
  macro: { connected: false, grs: null, vix: null, dxy: null, us10y: null, asOf: null },
  cot: { applicable: false, connected: false, market: null, status: null, netRatio: null, percentile: null, weekChange: null, reportDate: null },
  derivatives: { connected: false, fundingRate: null, openInterest: null, oiChangePct24h: null, asOf: null },
  noTrade: { calendarConnected: false, active: false, reason: null, nextHigh: null },
  risk: { killSwitchActive: false, mode: 'paper', riskPctPerTrade: 1, maxLeverage: 3, maxExposurePctPerAsset: 25, dailyLossLimitPct: 3, exposureNotional: 0, openPositions: 0 },
  llmConfigured: false,
};

describe('verdictGate', () => {
  it('Makro nur mit Makro-Serien, Shadow mit Funding/OI ODER COT', () => {
    expect(verdictGate(base)).toEqual({ makro: expect.stringMatching(/nicht verbunden/), shadow: expect.stringMatching(/verbunden/) });
    expect(verdictGate({ ...base, macro: { ...base.macro, connected: true } }).makro).toBeNull();
    expect(verdictGate({ ...base, cot: { ...base.cot, connected: true } }).shadow).toBeNull();
    expect(verdictGate({ ...base, derivatives: { ...base.derivatives, connected: true } }).shadow).toBeNull();
  });
});

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) console.warn('[asset-verdict.test] DATABASE_URL nicht gesetzt — DB-Teil übersprungen (Server-CI maßgeblich).');
if (hasDb && !process.env.JWT_SECRET) process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;

describe.skipIf(!hasDb)('assetVerdicts gegen die echte DB', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  beforeAll(async () => {
    ({ db, pool } = createDb());
    const res = await register(db, { email: `verdict-${process.pid}-${Date.now()}@test.invalid`, password: 'sehr-sicheres-passwort-123', name: 'Verdict' });
    userId = res.user.id;
  });
  afterAll(async () => {
    await db.delete(schema.auditLog).where(eq(schema.auditLog.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end();
  });

  it('unbekanntes Symbol: beide Agenten ehrlich nicht verbunden, kein LLM-Aufruf, keine Kosten', async () => {
    let calls = 0;
    const fake: LlmProvider = {
      id: 'fake',
      configured: true,
      complete: async () => {
        calls++;
        return { text: '{"stance":"neutral","confidence":0.5,"reason":"x"}', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 1 };
      },
    };
    const out = await assetVerdicts(db, userId, `NOPE${Date.now()}/USDT`, fake, null);
    expect(out.agents.map((x) => x.connected)).toEqual([false, false]);
    expect(calls).toBe(0);
    expect(out.costUsd).toBe(0);
  });
});
