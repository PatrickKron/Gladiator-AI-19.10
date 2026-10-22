/**
 * Asset-Analyse gegen die ECHTE DB (lokal mit DATABASE_URL, sonst übersprungen): für ein
 * Symbol ohne Daten stehen alle Quellen ehrlich auf „nicht verbunden“, die Risiko-Limits
 * kommen aus den Trading-Einstellungen, nichts wird geraten.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { register } from '../auth/service.js';
import { buildAssetAnalysis } from './asset-analysis.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) console.warn('[asset-analysis.test] DATABASE_URL nicht gesetzt — übersprungen (Server-CI maßgeblich).');
if (hasDb && !process.env.JWT_SECRET) process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;

describe.skipIf(!hasDb)('buildAssetAnalysis', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  beforeAll(async () => {
    ({ db, pool } = createDb());
    const res = await register(db, { email: `analysis-${process.pid}-${Date.now()}@test.invalid`, password: 'sehr-sicheres-passwort-123', name: 'A' });
    userId = res.user.id;
  });
  afterAll(async () => {
    await db.delete(schema.auditLog).where(eq(schema.auditLog.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end();
  });

  it('unbekanntes Symbol: Derivate nicht verbunden, COT nicht anwendbar, Risiko aus den Einstellungen, keine Positionen', async () => {
    const a = await buildAssetAnalysis(db, userId, 'nix-nicht-da/USDT');
    expect(a.symbol).toBe('NIX-NICHT-DA/USDT');
    expect(a.derivatives).toMatchObject({ connected: false, fundingRate: null, openInterest: null });
    expect(a.cot).toMatchObject({ applicable: false, connected: false, status: null });
    expect(a.risk.openPositions).toBe(0);
    expect(a.risk.exposureNotional).toBe(0);
    expect(a.risk.riskPctPerTrade).toBeGreaterThan(0);
    expect(typeof a.risk.killSwitchActive).toBe('boolean');
    expect(typeof a.noTrade.active).toBe('boolean');
    expect(a.macro.grs === null || typeof a.macro.grs.score === 'number').toBe(true);
  });

  it('BTC/USDT: COT-Markt zugeordnet (Bitcoin), Felder konsistent zu „verbunden“', async () => {
    const a = await buildAssetAnalysis(db, userId, 'BTC/USDT');
    expect(a.cot.applicable).toBe(true);
    if (a.cot.connected) {
      expect(a.cot.status).not.toBeNull();
      expect(a.cot.reportDate).not.toBeNull();
    } else {
      expect(a.cot.status).toBeNull();
    }
    if (!a.derivatives.connected) expect(a.derivatives.asOf === null || new Date(a.derivatives.asOf).getTime() < Date.now() - 3 * 3_600_000).toBe(true);
  });
});
