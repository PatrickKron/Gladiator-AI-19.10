import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { createApp } from '../app.js';
import { normalizeSymbol, rrBasedScore, verifyPineAuth } from './pine.js';

const { strategies, signals } = schema;

// ── Unit-Tests (ohne DB) ──────────────────────────────────────────────────

describe('Pine-Webhook: Symbol-Normalisierung', () => {
  it.each([
    ['BTCUSDT', 'BTC/USDT'],
    ['BINANCE:SOLUSDT', 'SOL/USDT'],
    ['ETH/USDT', 'ETH/USDT'],
    ['ethusdc', 'ETH/USDC'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeSymbol(input)).toBe(expected);
  });
});

describe('Pine-Webhook: HMAC/Secret-Prüfung (timing-safe)', () => {
  const secret = 'test-secret-123';
  const body = Buffer.from('{"a":1}');

  it('gültige Header-Signatur wird akzeptiert', () => {
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyPineAuth(body, sig, undefined, secret)).toBe(true);
  });

  it('falsche Signatur & falsches Body-Secret werden abgelehnt', () => {
    expect(verifyPineAuth(body, 'deadbeef', undefined, secret)).toBe(false);
    expect(verifyPineAuth(body, undefined, 'falsch', secret)).toBe(false);
    expect(verifyPineAuth(body, undefined, undefined, secret)).toBe(false);
  });

  it('korrektes Body-Secret wird akzeptiert (TradingView kann keine Header setzen)', () => {
    expect(verifyPineAuth(body, undefined, secret, secret)).toBe(true);
  });
});

describe('Pine-Webhook: RR-basierter Score (dokumentierte, echte Berechnung)', () => {
  it('RR 2 → Score 6.0; RR ≥ 3.34 → 10 (Cap)', () => {
    expect(rrBasedScore(100, 95, 110, 'long')).toBe(6); // Risiko 5, Reward 10 → RR 2
    expect(rrBasedScore(100, 99, 110, 'long')).toBe(10); // RR 10 → Cap 10
  });
  it('ungültige Geometrie → 0 (kein erfundener Score)', () => {
    expect(rrBasedScore(100, 105, 110, 'long')).toBe(0);
    expect(rrBasedScore(100, 95, 90, 'long')).toBe(0);
  });
});

// ── Integrationstests (echte DB; Server-CI maßgeblich) ───────────────────

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  console.warn('[pine.test] DATABASE_URL nicht gesetzt — Integrationsteil übersprungen.');
}

describe.skipIf(!hasDb)('Pine-Webhook: Ende-zu-Ende gegen echte DB', () => {
  let db: Db;
  let pool: pg.Pool;
  let strategyId: string;
  const SECRET = `pine-test-${Date.now()}`;
  const createdSignals: string[] = [];

  beforeAll(async () => {
    process.env.PINE_WEBHOOK_SECRET = SECRET;
    ({ db, pool } = createDb());
    const [s] = await db
      .insert(strategies)
      .values({ slug: `pine-test-${Date.now()}`, name: 'Pine-Test', kind: 'pine', description: 'Test' })
      .returning();
    strategyId = s!.id;
  });

  afterAll(async () => {
    delete process.env.PINE_WEBHOOK_SECRET;
    for (const id of createdSignals) {
      await db.execute(sql`DELETE FROM audit_log WHERE entity_id = ${id}`);
      await db.delete(signals).where(eq(signals.id, id));
    }
    await db.delete(strategies).where(eq(strategies.id, strategyId));
    await pool.end();
  });

  const payload = (over: Record<string, unknown> = {}) => ({
    strategyId,
    symbol: 'BTCUSDT',
    timeframe: '1h',
    direction: 'long',
    setupType: 'swing',
    entry: 100000,
    stopLoss: 98000,
    takeProfits: [104000, 108000],
    ...over,
  });

  const post = (body: unknown, sign = true) => {
    const raw = JSON.stringify(body);
    const req = request(createApp(db, { webDistDir: null })).post('/api/webhook/pine').set('Content-Type', 'application/json');
    if (sign) {
      req.set('x-gladiator-signature', createHmac('sha256', SECRET).update(Buffer.from(raw)).digest('hex'));
    }
    return req.send(raw);
  };

  it('ohne gültige Signatur → 401, kein Signal', async () => {
    const res = await post(payload(), false);
    expect(res.status).toBe(401);
  });

  it('unbekannte strategyId → 404', async () => {
    const res = await post(payload({ strategyId: '00000000-0000-0000-0000-000000000000' }));
    expect(res.status).toBe(404);
  });

  it('gültiger Alert → kanonisches Signal (source pine) mit Regime aus echten Kerzen; Duplikat wird erkannt', async () => {
    const res = await post(payload());
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    createdSignals.push(res.body.signalId as string);

    const [row] = await db.select().from(signals).where(eq(signals.id, res.body.signalId as string));
    expect(row!.source).toBe('pine');
    expect(row!.symbol).toBe('BTC/USDT');
    expect(['above', 'below']).toContain(row!.emaRegime);
    expect(['bull', 'bear']).toContain(row!.marketPhase);
    expect(Number(row!.score)).toBeGreaterThan(0);
    expect(row!.confluence).toContain('extern:pine');

    const dup = await post(payload());
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
  });

  it('SL auf falscher Seite → 422 (Plausibilität)', async () => {
    const res = await post(payload({ stopLoss: 101000, direction: 'long', setupType: 'scalp' }));
    expect(res.status).toBe(422);
  });
});
