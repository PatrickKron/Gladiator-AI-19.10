/**
 * VDB1 aus echten Paper-Trades gegen die ECHTE DB (Server-CI; lokal ohne
 * DATABASE_URL: skip). Venue = deterministisches Test-Double (nur in Tests).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import type { TradingVenue, VenueOrderRequest, VenueOrderResult } from './venue.js';
import { closePositionManually, executeConfirmedSignal, monitorOpenPositions } from './executor.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const SYMBOL = `STUDY${process.pid}/USDT`;

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

describe.skipIf(!hasDb)('VDB1: geschlossener Paper-Trade → study_trades (echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  let strategyId: string;
  let slug: string;
  const RUN = `${process.pid}-${Date.now()}`;

  async function open(venue: TestVenue): Promise<void> {
    venue.price = 100;
    const [sig] = await db
      .insert(schema.signals)
      .values({
        source: 'engine',
        strategyId,
        symbol: SYMBOL,
        timeframe: '1h',
        assetClass: 'crypto',
        venueType: 'cex',
        direction: 'long',
        setupType: 'swing',
        entry: '100',
        stopLoss: '90',
        takeProfits: ['110', '120', '130'],
        score: '8',
        riskClass: 'low',
        confluence: ['Test'],
        session: 'london',
        emaRegime: 'above',
        marketPhase: 'bull',
        status: 'confirmed',
      })
      .returning();
    const res = await executeConfirmedSignal(db, venue, { signalId: sig!.id, userId, riskContext: { noTrade: null, vix: null } });
    expect(res.executed, res.detail).toBe(true);
  }

  async function latestStudyRow(): Promise<Record<string, unknown> | undefined> {
    const r = await db.execute(sql`
      SELECT st.cluster_key, st.r_multiple::float AS r, st.pnl_r_tp_a::float AS a, st.pnl_r_tp_b AS b,
             st.mae_bps::float AS mae, st.session, st.market_structure, et.net_pnl::float AS net, et.qty::float AS qty
      FROM study_trades st JOIN executed_trades et ON et.id = st.executed_trade_id
      WHERE et.user_id = ${userId} ORDER BY st.created_at DESC LIMIT 1`);
    return r.rows[0] as Record<string, unknown> | undefined;
  }

  async function countRows(): Promise<number> {
    const r = await db.execute(
      sql`SELECT count(*)::int AS n FROM study_trades st JOIN executed_trades et ON et.id = st.executed_trade_id WHERE et.user_id = ${userId}`,
    );
    return r.rows[0]!.n as number;
  }

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [u] = await db.insert(schema.users).values({ email: `study-test-${RUN}@test.invalid` }).returning();
    userId = u!.id;
    slug = `study-test-${RUN}`;
    const [s] = await db.insert(schema.strategies).values({ slug, name: 'Study Test', kind: 'builtin' }).returning();
    strategyId = s!.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM study_trades WHERE executed_trade_id IN (SELECT id FROM executed_trades WHERE user_id = ${userId})`);
    await db.execute(sql`DELETE FROM executed_trades WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM positions WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM orders WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM audit_log WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM signals WHERE strategy_id = ${strategyId}`);
    await db.execute(sql`DELETE FROM strategies WHERE id = ${strategyId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await pool.end();
  });

  it('Voll-Schluss schreibt GENAU eine Zeile mit vollem Cluster-Key, R netto auf 1R = Stop-Abstand', async () => {
    const venue = new TestVenue();
    await open(venue);
    const [pos] = await db.select().from(schema.positions).where(sql`user_id = ${userId}`);
    venue.price = 105;
    expect((await closePositionManually(db, venue, userId, pos!.id)).closed).toBe(true);

    expect(await countRows()).toBe(1);
    const row = (await latestStudyRow())!;
    expect(row.cluster_key).toBe(`${slug}|${SYMBOL}|swing|1h|london|uptrend`);
    expect(row.session).toBe('london');
    expect(row.market_structure).toBe('uptrend');
    expect(row.r as number).toBeCloseTo((row.net as number) / (10 * (row.qty as number)), 9);
    expect(row.a as number).toBeCloseTo(row.r as number, 9);
    expect(row.b).toBeNull();
    expect(row.mae as number).toBeCloseTo(1000, 6); // 10 % Stop-Abstand
  });

  it('nach TP1 + Break-Even-Stop bleibt 1R der URSPRÜNGLICHE Stop (nicht der verschobene)', async () => {
    const venue = new TestVenue();
    await open(venue);
    venue.price = 111; // TP1 füllt → Stop auf Entry
    await monitorOpenPositions(db, venue);
    venue.price = 99.9; // BE-Stop schließt den Rest
    await monitorOpenPositions(db, venue);

    expect(await countRows()).toBe(2);
    const row = (await latestStudyRow())!;
    expect(row.r as number).toBeGreaterThan(0);
    expect(row.r as number).toBeCloseTo((row.net as number) / (10 * (row.qty as number)), 9);
  });
});
