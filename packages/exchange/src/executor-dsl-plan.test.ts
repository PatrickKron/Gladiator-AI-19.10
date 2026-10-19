/**
 * DSL-Ausführungs-Plan live (echte DB; lokal ohne DATABASE_URL skip):
 * TP-Gewichte (takeProfits[].weight) und der Break-Even-Schalter
 * (breakEvenAfterTp1) kommen aus DERSELBEN Strategie-Version, aus der das
 * Signal stammt (signals.strategy_version_id → strategy_versions.params) —
 * keine Migration, kein zweckentfremdetes Feld, Backtest = Live.
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
const SYMBOL = `DSLPLAN${process.pid}/USDT`;

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
  // Nur das eigene Symbol bepreisen (Monitor sieht alle Positionen der DB).
  async markPrice(symbol: string) {
    if (symbol !== SYMBOL) throw new Error(`fremdes Test-Symbol ${symbol}`);
    return this.price;
  }
  async placeOrder(req: VenueOrderRequest): Promise<VenueOrderResult> {
    this.placed.push(req);
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

/** Valide DSL (Schema-Pflichtfelder); Gewichte/BE je Test. */
function dslParams(slug: string, takeProfits: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: slug,
    symbol: SYMBOL,
    direction: 'long',
    when: { all: [{ trend: 'EMA200_up' }] },
    entry: 'market',
    stopLoss: { type: 'pct', pct: 10 },
    takeProfits,
    risk: { maxLeveragePerTrade: 1, riskPctPerTrade: 1 },
    ...extra,
  };
}

describe.skipIf(!hasDb)('DSL-Ausführungs-Plan live: TP-Gewichte + Break-Even-Schalter (Paper, echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  const strategyIds: string[] = [];
  const RUN = `${process.pid}-${Date.now()}`;
  const NEUTRAL_CTX = { noTrade: null, vix: null };

  /** Registriert eine DSL-Strategie-Version und ein bestätigtes Signal daraus (2 TPs: 110/120, SL 90). */
  async function dslSignal(tag: string, params: Record<string, unknown>): Promise<string> {
    const slug = `dslplan-${tag}-${RUN}`;
    const [s] = await db.insert(strategies).values({ slug, name: `DSL-Plan ${tag}`, kind: 'dsl' }).returning();
    strategyIds.push(s!.id);
    const [v] = await db.insert(strategyVersions).values({ strategyId: s!.id, version: 1, params, status: 'paper' }).returning();
    const [sig] = await db
      .insert(signals)
      .values({
        source: 'instruction',
        strategyId: s!.id,
        strategyVersionId: v!.id,
        symbol: SYMBOL,
        timeframe: '1h',
        assetClass: 'crypto',
        venueType: 'cex',
        direction: 'long',
        setupType: 'swing',
        entry: '100',
        stopLoss: '90',
        takeProfits: ['110', '120'],
        leverageSuggested: '1',
        score: '6',
        riskClass: 'medium',
        confluence: ['dsl:EMA200_up', 'score:rr-basiert'],
        session: 'london',
        emaRegime: 'above',
        marketPhase: 'bull',
        status: 'confirmed',
      })
      .returning();
    return sig!.id;
  }

  async function openStop(): Promise<{ qty: number; price: number } | undefined> {
    const r = await db.execute(
      sql`SELECT qty::float AS qty, price::float AS price FROM orders
          WHERE user_id = ${userId} AND type = 'stop_market' AND status = 'open'`,
    );
    return r.rows[0] as { qty: number; price: number } | undefined;
  }

  async function lastTrade(): Promise<{ gross: number } | undefined> {
    const r = await db.execute(
      sql`SELECT gross_pnl::float AS gross FROM executed_trades WHERE user_id = ${userId} ORDER BY exit_ts DESC LIMIT 1`,
    );
    return r.rows[0] as { gross: number } | undefined;
  }

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [u] = await db.insert(users).values({ email: `dslplan-test-${RUN}@test.invalid` }).returning();
    userId = u!.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM executed_trades WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM positions WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM orders WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM audit_log WHERE user_id = ${userId}`);
    for (const id of strategyIds) {
      await db.execute(sql`DELETE FROM signals WHERE strategy_id = ${id}`);
      await db.execute(sql`DELETE FROM strategies WHERE id = ${id}`);
    }
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await pool.end();
  });

  it('Gewichte 60/40 + BE aus: TP-Orders mit den DSL-Anteilen, Stop bleibt nach TP1 am Original-SL', async () => {
    const venue = new TestVenue();
    venue.price = 100;
    const signalId = await dslSignal(
      'w6040',
      dslParams('w6040', [{ rr: 1, weight: 0.6 }, { rr: 2, weight: 0.4 }], { breakEvenAfterTp1: false }),
    );
    const res = await executeConfirmedSignal(db, venue, { signalId, userId, riskContext: NEUTRAL_CTX });
    expect(res.executed).toBe(true);
    expect(res.qty).toBeCloseTo(10, 6);

    const tps = venue.placed.filter((o) => o.type === 'take_profit_market');
    expect(tps).toHaveLength(2);
    expect(tps[0]!.qty).toBeCloseTo(6, 6);
    expect(tps[1]!.qty).toBeCloseTo(4, 6);

    venue.price = 111; // TP1 füllt (60 %)
    await monitorOpenPositions(db, venue);
    const sl = await openStop();
    expect(sl!.price).toBeCloseTo(90, 6); // KEIN Break-Even
    expect(sl!.qty).toBeCloseTo(4, 6); // nur noch die Restmenge
    const be = await db.execute(
      sql`SELECT 1 FROM audit_log WHERE user_id = ${userId} AND action = 'position.stop_to_breakeven'`,
    );
    expect(be.rows).toHaveLength(0);

    venue.price = 95; // unter Entry: mit BE wäre die Position jetzt zu — ohne BE bleibt sie offen
    await monitorOpenPositions(db, venue);
    expect(await openStop()).toBeDefined();

    venue.price = 89; // Original-Stop füllt den Rest
    await monitorOpenPositions(db, venue);
    // 6 × (110 − 100) + 4 × (90 − 100) = 20 — identisch zum Backtest-Pfad
    expect((await lastTrade())!.gross).toBeCloseTo(20, 6);
  });

  it('DSL ohne Gewichte/BE-Angabe: Default 50/30/20 auf 2 TPs = 50/50 (wie Backtest), BE nach TP1 aktiv', async () => {
    const venue = new TestVenue();
    venue.price = 100;
    const signalId = await dslSignal('default', dslParams('default', [{ rr: 1 }, { rr: 2 }]));
    const res = await executeConfirmedSignal(db, venue, { signalId, userId, riskContext: NEUTRAL_CTX });
    expect(res.executed).toBe(true);
    const qty = res.qty!;

    const tps = venue.placed.filter((o) => o.type === 'take_profit_market');
    expect(tps[0]!.qty).toBeCloseTo(qty * 0.5, 6);
    expect(tps[1]!.qty).toBeCloseTo(qty * 0.5, 6);

    venue.price = 111;
    await monitorOpenPositions(db, venue);
    expect((await openStop())!.price).toBeCloseTo(100, 6); // Break-Even

    venue.price = 99;
    await monitorOpenPositions(db, venue);
    expect((await lastTrade())!.gross).toBeCloseTo(qty * 0.5 * 10, 6);
  });
});
