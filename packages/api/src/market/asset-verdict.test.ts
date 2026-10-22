/**
 * KI-Urteil je Asset: Gate (nur mit verbundener Datenquelle) rein; gegen die echte DB mit
 * Fake-Provider — unbekanntes Symbol ⇒ Shadow „nicht verbunden“ (Funding/OI/COT gibt es nur je
 * Symbol), Provider wird dafür NICHT gerufen. Makro ist bewusst symbolunabhängig (VIX/DXY/US10Y
 * gelten für alle Assets): mit echten Makro-Serien in der DB (Server-CI) urteilt der Makro-Agent
 * auch für ein unbekanntes Symbol, ohne Serien (frische CI-DB) ist er ehrlich nicht verbunden.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, schema, type Db } from '@gladiator/db';
import type { LlmProvider } from '@gladiator/agents';
import type pg from 'pg';
import { register } from '../auth/service.js';
import { buildAssetAnalysis, type AssetAnalysis } from './asset-analysis.js';
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

  it('unbekanntes Symbol: Shadow ehrlich nicht verbunden (kein LLM-Aufruf); Makro genau dann, wenn echte Makro-Serien da sind', async () => {
    let calls = 0;
    const fake: LlmProvider = {
      id: 'fake',
      configured: true,
      complete: async () => {
        calls++;
        return { text: '{"stance":"neutral","confidence":0.5,"reason":"x"}', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 1 };
      },
    };
    const symbol = `NOPE${Date.now()}/USDT`;
    const analysis = await buildAssetAnalysis(db, userId, symbol);
    // Funding/OI und COT gibt es nur je Symbol → für ein unbekanntes nie verbunden
    expect(analysis.derivatives.connected).toBe(false);
    expect(analysis.cot.connected).toBe(false);

    const out = await assetVerdicts(db, userId, symbol, fake, null);
    const shadow = out.agents.find((x) => x.agent === 'shadow');
    const makro = out.agents.find((x) => x.agent === 'makro');
    expect(shadow).toMatchObject({ connected: false, reason: expect.stringMatching(/nicht verbunden|Weder/) });
    // Makro folgt ausschließlich den echten Makro-Serien der DB — derselbe Schalter wie in der Analyse
    expect(makro?.connected).toBe(analysis.macro.connected);
    if (analysis.macro.connected) {
      // Serien da (Server): genau EIN Aufruf (Makro), Shadow bleibt stumm; Kosten = Kosten dieses Aufrufs
      expect(calls).toBe(1);
      expect(out.costUsd).toBe(1);
      expect(makro).toMatchObject({ connected: true, verdict: { stance: 'neutral' } });
    } else {
      // keine Serien (frische CI-DB): kein Aufruf, keine Kosten
      expect(calls).toBe(0);
      expect(out.costUsd).toBe(0);
    }
  });
});
