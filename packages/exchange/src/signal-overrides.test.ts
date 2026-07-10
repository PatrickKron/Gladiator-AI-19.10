/**
 * User-Anpassungen am Signal (Betrag/Hebel/SL/TP) — Integrationstest gegen die
 * ECHTE DB (Server-CI; lokal skip). Prüft: Overrides wirken auf Sizing +
 * Schutz-Orders, der Strategie-Vorschlag bleibt im Audit als Referenz, und
 * die harten Risk-Gates gelten auch für Wunschbeträge.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import type pg from 'pg';
import type { TradingVenue, VenueOrderRequest, VenueOrderResult } from './venue.js';
import { executeConfirmedSignal } from './executor.js';

const { signals, strategies, strategyVersions, users } = schema;

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) console.warn('[signal-overrides.test] DATABASE_URL fehlt — übersprungen (Server-CI maßgeblich).');

class TestVenue implements TradingVenue {
  readonly id = 'paper-internal';
  readonly kind = 'paper' as const;
  price = 100;
  placed: VenueOrderRequest[] = [];
  async validate() {
    return { ok: true, detail: 'test' };
  }
  async marketRules() {
    return { tickSize: 0.1, lotSize: 0.000001, minNotional: 5 };
  }
  async markPrice() {
    return this.price;
  }
  async placeOrder(req: VenueOrderRequest): Promise<VenueOrderResult> {
    this.placed.push(req);
    return {
      clientOrderId: req.clientOrderId,
      exchangeOrderId: `t-${this.placed.length}`,
      status: req.type === 'market' ? 'filled' : 'open',
      fillPrice: req.type === 'market' ? this.price : undefined,
      filledQty: req.qty,
    };
  }
  async cancelOrder() {}
  async fetchPositions() {
    return [];
  }
  async fetchOpenOrders() {
    return [];
  }
}

describe.skipIf(!hasDb)('Signal-Overrides (Betrag/Hebel/SL/TP, echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  const RUN = `${process.pid}-${Date.now()}`;
  const NEUTRAL_CTX = { noTrade: null, vix: null };
  let signalSeq = 0;

  /**
   * Je Test ein eigenes Symbol: positions hat einen Unique-Index
   * (user, venue, symbol, mode) — zwei offene Positionen desselben Symbols
   * wären ein Constraint-Fehler, kein Testziel.
   */
  async function makeSignal(symbol: string): Promise<string> {
    signalSeq++;
    const [s] = await db
      .insert(strategies)
      .values({ slug: `ovr-test-${RUN}-${signalSeq}`, name: 'Override Test', kind: 'builtin' })
      .returning();
    const [v] = await db
      .insert(strategyVersions)
      .values({ strategyId: s!.id, version: 1, params: {}, status: 'paper' })
      .returning();
    const [sig] = await db
      .insert(signals)
      .values({
        source: 'engine',
        strategyId: s!.id,
        strategyVersionId: v!.id,
        symbol,
        timeframe: '1h',
        assetClass: 'crypto',
        venueType: 'cex',
        direction: 'long',
        setupType: 'swing',
        entry: '100',
        stopLoss: '90',
        takeProfits: ['110', '120', '130'],
        leverageSuggested: '1',
        score: '8.5',
        riskClass: 'low',
        confluence: ['Test'],
        session: 'london',
        emaRegime: 'above',
        marketPhase: 'bull',
        status: 'confirmed',
      })
      .returning();
    return sig!.id;
  }

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [u] = await db.insert(users).values({ email: `ovr-test-${RUN}@test.invalid` }).returning();
    userId = u!.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM executed_trades WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM positions WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM orders WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM audit_log WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM signals WHERE symbol LIKE 'OVR%/USDT'`);
    await db.execute(sql`DELETE FROM strategies WHERE slug LIKE ${`ovr-test-${RUN}-%`}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await pool.end();
  });

  it('Betrag + Hebel + SL + TPs des Users ersetzen den Vorschlag; Referenz bleibt im Audit', async () => {
    const signalId = await makeSignal('OVR1/USDT');
    const venue = new TestVenue();
    const res = await executeConfirmedSignal(db, venue, {
      signalId,
      userId,
      riskContext: NEUTRAL_CTX,
      overrides: { notionalUsd: 500, leverage: 2, stopLoss: 92, takeProfits: [111, 122] },
    });

    expect(res.verdict.allowed).toBe(true);
    expect(res.executed).toBe(true);
    // 500 USD @ Entry 100 → qty 5 (statt Default 10 aus Risiko%)
    expect(res.qty).toBeCloseTo(5, 6);

    // Schutz-Orders: SL @ 92 (User), 2 TPs @ 111/122 (User) — nicht 90/110/120/130
    const sl = venue.placed.find((o) => o.type === 'stop_market');
    expect(sl?.triggerPrice).toBe(92);
    const tps = venue.placed.filter((o) => o.type === 'take_profit_market');
    expect(tps.map((o) => o.triggerPrice)).toEqual([111, 122]);

    // Position trägt den User-Hebel
    const pos = await db.execute(
      sql`SELECT leverage::float AS lev FROM positions WHERE user_id = ${userId} AND symbol = 'OVR1/USDT'`,
    );
    expect(Number(pos.rows[0]!.lev)).toBe(2);

    // Audit enthält Overrides UND den ursprünglichen Strategie-Vorschlag
    const audit = await db.execute(
      sql`SELECT details FROM audit_log WHERE user_id = ${userId} AND action = 'order.risk_check.passed' ORDER BY id DESC LIMIT 1`,
    );
    const details = audit.rows[0]!.details as { overrides?: unknown; suggested?: { stopLoss?: string } };
    expect(details.overrides).toMatchObject({ notionalUsd: 500, leverage: 2 });
    expect(Number(details.suggested?.stopLoss)).toBe(90);
  });

  it('überzogener Wunschbetrag wird vom Risk-Gate geblockt (Exposure/Margin)', async () => {
    const signalId = await makeSignal('OVR2/USDT');
    const venue = new TestVenue();
    // Paper-Equity ~10k, Exposure-Limit default 20 % → 100k Wunsch muss fallen
    const res = await executeConfirmedSignal(db, venue, {
      signalId,
      userId,
      riskContext: NEUTRAL_CTX,
      overrides: { notionalUsd: 100_000 },
    });
    expect(res.executed).toBe(false);
    expect(res.verdict.allowed).toBe(false);
    expect(res.verdict.reasons.join(' ')).toMatch(/Exposure|Margin/);
    expect(venue.placed).toHaveLength(0);
  });

  it('Hebel über dem Settings-Cap wird geblockt', async () => {
    const signalId = await makeSignal('OVR3/USDT');
    const venue = new TestVenue();
    const res = await executeConfirmedSignal(db, venue, {
      signalId,
      userId,
      riskContext: NEUTRAL_CTX,
      overrides: { leverage: 50 },
    });
    expect(res.executed).toBe(false);
    expect(res.verdict.reasons.join(' ')).toMatch(/Hebel/);
  });

  it('ohne Overrides bleibt das bisherige Verhalten (Signal-SL/TP, Hebel 1)', async () => {
    const signalId = await makeSignal('OVR4/USDT');
    const venue = new TestVenue();
    const res = await executeConfirmedSignal(db, venue, { signalId, userId, riskContext: NEUTRAL_CTX });
    expect(res.executed).toBe(true);
    const sl = venue.placed.find((o) => o.type === 'stop_market');
    expect(sl?.triggerPrice).toBe(90);
    const tps = venue.placed.filter((o) => o.type === 'take_profit_market');
    expect(tps.map((o) => o.triggerPrice)).toEqual([110, 120, 130]);
    const pos = await db.execute(
      sql`SELECT leverage::float AS lev FROM positions WHERE user_id = ${userId} AND symbol = 'OVR4/USDT'`,
    );
    expect(Number(pos.rows[0]!.lev)).toBe(1);
  });
});
