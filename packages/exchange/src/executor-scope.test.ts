/**
 * Regressionstests (Audit 2026-10-19) gegen die ECHTE DB (Server-CI; lokal skip):
 *  1. Nach TP1 + Break-Even-Stop darf der Stop nur noch die RESTMENGE schließen
 *     (vorher: volle Menge → Exit-Menge 1,5× → Brutto-PnL zu niedrig).
 *  2. Der zweite Trade auf demselben Symbol darf die Fills des ersten NICHT
 *     mitzählen (vorher: alle je gefüllten reduceOnly-Orders des Symbols).
 * Venue = deterministisches Test-Double (nur in Tests erlaubt).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import type { TradingVenue, VenueOrderRequest, VenueOrderResult } from './venue.js';
import { executeConfirmedSignal, monitorOpenPositions } from './executor.js';

const { signals, strategies, strategyVersions, users } = schema;
const hasDb = Boolean(process.env.DATABASE_URL);
const SYMBOL = `SCOPE${process.pid}/USDT`;

class TestVenue implements TradingVenue {
  readonly id = 'paper-internal';
  readonly kind = 'paper' as const;
  price = 100;
  async validate() {
    return { ok: true, detail: 'test' };
  }
  async marketRules() {
    return { tickSize: 0.1, lotSize: 0.000001, minNotional: 5 };
  }
  // Nur das eigene Symbol bepreisen (Monitor sieht alle Positionen der DB;
  // parallel laufende Testdateien dürfen sich nicht beeinflussen).
  async markPrice(symbol: string) {
    if (symbol !== SYMBOL) throw new Error(`fremdes Test-Symbol ${symbol}`);
    return this.price;
  }
  async placeOrder(req: VenueOrderRequest): Promise<VenueOrderResult> {
    return {
      clientOrderId: req.clientOrderId,
      exchangeOrderId: `t-${req.clientOrderId}`,
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

describe.skipIf(!hasDb)('Positions-Abrechnung je Position (Paper, echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  let strategyId: string;
  let versionId: string;
  const RUN = `${process.pid}-${Date.now()}`;
  const NEUTRAL_CTX = { noTrade: null, vix: null };
  const venue = new TestVenue();

  async function newSignal(): Promise<string> {
    const [sig] = await db
      .insert(signals)
      .values({
        source: 'engine',
        strategyId,
        strategyVersionId: versionId,
        symbol: SYMBOL,
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

  async function trades(): Promise<{ gross: number; exit: number }[]> {
    const r = await db.execute(
      sql`SELECT gross_pnl::float AS gross, exit_price::float AS exit FROM executed_trades WHERE user_id = ${userId} ORDER BY exit_ts`,
    );
    return r.rows as { gross: number; exit: number }[];
  }

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [u] = await db.insert(users).values({ email: `scope-test-${RUN}@test.invalid` }).returning();
    userId = u!.id;
    const [s] = await db.insert(strategies).values({ slug: `scope-test-${RUN}`, name: 'Scope Test', kind: 'builtin' }).returning();
    strategyId = s!.id;
    const [v] = await db.insert(strategyVersions).values({ strategyId, version: 1, params: {}, status: 'paper' }).returning();
    versionId = v!.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM executed_trades WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM positions WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM orders WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM audit_log WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM signals WHERE strategy_id = ${strategyId}`);
    await db.execute(sql`DELETE FROM strategies WHERE id = ${strategyId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await pool.end();
  });

  it('TP1, danach Break-Even-Stop: Stop schließt nur den Rest → Brutto = TP1-Gewinn', async () => {
    venue.price = 100;
    const res = await executeConfirmedSignal(db, venue, { signalId: await newSignal(), userId, riskContext: NEUTRAL_CTX });
    expect(res.executed).toBe(true);
    expect(res.qty).toBeCloseTo(10, 6);

    venue.price = 111; // TP1 (50 %) füllt, Stop → Break-Even
    await monitorOpenPositions(db, venue);
    const sl = await db.execute(
      sql`SELECT qty::float AS qty, price::float AS price FROM orders WHERE user_id = ${userId} AND type = 'stop_market' AND status = 'open'`,
    );
    expect(sl.rows[0]).toMatchObject({ price: 100 });
    expect((sl.rows[0] as { qty: number }).qty).toBeCloseTo(5, 6); // nur noch die Restmenge

    venue.price = 99; // Break-Even-Stop füllt den Rest
    await monitorOpenPositions(db, venue);

    const [t] = await trades();
    // 5 × (110 − 100) + 5 × (100 − 100) = 50
    expect(t!.gross).toBeCloseTo(50, 6);
    expect(t!.exit).toBeCloseTo(105, 6);
  });

  it('zweiter Trade auf demselben Symbol zählt nur seine eigenen Fills', async () => {
    venue.price = 100;
    const res = await executeConfirmedSignal(db, venue, { signalId: await newSignal(), userId, riskContext: NEUTRAL_CTX });
    expect(res.executed).toBe(true);

    venue.price = 131; // alle drei TPs
    await monitorOpenPositions(db, venue);

    const all = await trades();
    expect(all).toHaveLength(2);
    // qty × (0,5×10 + 0,3×20 + 0,2×30) = qty × 17 — unabhängig vom ersten Trade
    // (qty ≈ 10,05: das Konto ist nach Trade 1 etwas größer → 1 % Risiko etwas mehr)
    expect(all[1]!.gross).toBeCloseTo(res.qty! * 17, 6);
  });

  it('offene Position auf dem Symbol: zweites Signal wird VOR jeder Order abgelehnt (keine verwaiste Order)', async () => {
    venue.price = 100;
    const first = await executeConfirmedSignal(db, venue, { signalId: await newSignal(), userId, riskContext: NEUTRAL_CTX });
    expect(first.executed).toBe(true);
    const before = await db.execute(sql`SELECT count(*)::int AS n FROM orders WHERE user_id = ${userId}`);

    const second = await executeConfirmedSignal(db, venue, { signalId: await newSignal(), userId, riskContext: NEUTRAL_CTX });
    expect(second.executed).toBe(false);
    expect(second.detail).toMatch(/bereits eine Position/);
    const after = await db.execute(sql`SELECT count(*)::int AS n FROM orders WHERE user_id = ${userId}`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});
