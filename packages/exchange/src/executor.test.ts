/**
 * Lifecycle-Integrationstest gegen die ECHTE DB (Server-CI; lokal skip).
 * Venue ist ein deterministisches Test-Double (nur in Tests erlaubt) —
 * geprüft wird der komplette Fluss: Signal → Risk → Order → Position →
 * Monitor-Fill → executed_trades netto → Audit-Spur → Idempotenz.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import type pg from 'pg';
import type { TradingVenue, VenueOrderRequest, VenueOrderResult } from './venue.js';
import { buildAccountState, executeConfirmedSignal, monitorOpenPositions, reconcile } from './executor.js';

const { signals, strategies, strategyVersions, users, riskGates } = schema;

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) console.warn('[executor.test] DATABASE_URL fehlt — übersprungen (Server-CI maßgeblich).');

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

describe.skipIf(!hasDb)('Order-Lifecycle (Paper, echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  let signalId: string;
  const RUN = `${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [u] = await db.insert(users).values({ email: `exec-test-${RUN}@test.invalid` }).returning();
    userId = u!.id;

    const [s] = await db
      .insert(strategies)
      .values({ slug: `exec-test-${RUN}`, name: 'Exec Test', kind: 'builtin' })
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
        symbol: 'TEST/USDT',
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
    signalId = sig!.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM executed_trades WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM positions WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM orders WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM audit_log WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM signals WHERE id = ${signalId}`);
    await db.execute(sql`DELETE FROM strategies WHERE slug LIKE ${'exec-test-%'}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await pool.end();
  });

  it('führt bestätigtes Signal aus: Entry + 4 Schutz-Orders + Position + Audit', async () => {
    const venue = new TestVenue();
    const res = await executeConfirmedSignal(db, venue, { signalId, userId });

    expect(res.verdict.allowed).toBe(true);
    expect(res.executed).toBe(true);
    expect(res.entryFill).toBe(100);
    // Sizing: 10.000 × 1 % = 100 Risiko / Abstand 10 → qty 10
    expect(res.qty).toBeCloseTo(10, 6);
    // 1 Entry + 1 SL + 3 TPs
    expect(venue.placed).toHaveLength(5);
    expect(venue.placed.filter((o) => o.reduceOnly)).toHaveLength(4);

    const audit = await db.execute(
      sql`SELECT action FROM audit_log WHERE user_id = ${userId} ORDER BY id`,
    );
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toContain('order.risk_check.passed');
    expect(actions).toContain('order.executed');
  });

  it('IDEMPOTENZ: zweiter Confirm platziert KEINE zweite Order', async () => {
    const venue = new TestVenue();
    await db.execute(sql`UPDATE signals SET status = 'confirmed' WHERE id = ${signalId}`);
    const res = await executeConfirmedSignal(db, venue, { signalId, userId });
    expect(res.executed).toBe(false);
    expect(res.detail).toMatch(/Idempotenz/);
    expect(venue.placed).toHaveLength(0);
  });

  it('Reconciliation: Position mit Schutz-Orders ist sauber', async () => {
    const venue = new TestVenue();
    const rec = await reconcile(db, venue);
    const own = rec.findings.filter((f) => f.includes('TEST/USDT'));
    expect(own).toHaveLength(0);
  });

  it('Monitor: Preis über TP1 → Teil-Fill + Stop auf Break-Even; über TP3 → Vollschluss netto', async () => {
    const venue = new TestVenue();
    venue.price = 111; // über TP1
    let res = await monitorOpenPositions(db, venue);
    expect(res.fills).toBeGreaterThanOrEqual(1);

    const sl = await db.execute(
      sql`SELECT price FROM orders WHERE user_id = ${userId} AND type = 'stop_market' AND status = 'open'`,
    );
    expect(Number(sl.rows[0]!.price)).toBeCloseTo(100, 6); // Break-Even

    venue.price = 131; // über TP3 → Rest schließt
    res = await monitorOpenPositions(db, venue);
    expect(res.fills).toBeGreaterThanOrEqual(2);

    const pos = await db.execute(sql`SELECT count(*)::int AS n FROM positions WHERE user_id = ${userId}`);
    expect(pos.rows[0]!.n).toBe(0);

    const trades = await db.execute(
      sql`SELECT net_pnl::float AS net, maker_taker_fee::float AS fee FROM executed_trades WHERE user_id = ${userId}`,
    );
    expect(trades.rows).toHaveLength(1);
    const t = trades.rows[0] as { net: number; fee: number };
    expect(t.fee).toBeGreaterThan(0); // Kosten real abgezogen
    // Brutto: 10×(0.5×10 + 0.3×20 + 0.2×30) = 170 → netto etwas darunter
    expect(t.net).toBeGreaterThan(150);
    expect(t.net).toBeLessThan(170);
  });

  it('adaptives Gate blockt die Ausführung mit Evidenz-Begründung', async () => {
    // Neues Signal + Gate, das genau darauf passt
    const [sig2] = await db
      .insert(signals)
      .values({
        source: 'engine',
        strategyId: (await db.execute(sql`SELECT id FROM strategies WHERE slug LIKE ${'exec-test-%'} LIMIT 1`)).rows[0]!.id as string,
        symbol: 'TEST/USDT',
        timeframe: '1h',
        assetClass: 'crypto',
        venueType: 'cex',
        direction: 'long',
        setupType: 'swing',
        entry: '100',
        stopLoss: '90',
        takeProfits: ['110'],
        leverageSuggested: '1',
        score: '8',
        riskClass: 'low',
        confluence: [],
        session: 'asia',
        emaRegime: 'below',
        marketPhase: 'bear',
        status: 'confirmed',
      })
      .returning();
    const [gate] = await db
      .insert(riskGates)
      .values({
        kind: 'block',
        direction: 'long',
        emaRegime: 'below',
        reason: `TEST-Gate ${RUN}: Longs unter EMA200 negativ.`,
        evidence: { trades: 40, expectancyR: -0.3, winRate: 0.3 },
        source: 'test',
      })
      .returning();

    const venue = new TestVenue();
    const res = await executeConfirmedSignal(db, venue, { signalId: sig2!.id, userId });
    expect(res.executed).toBe(false);
    expect(res.verdict.reasons.join(' ')).toMatch(/TEST-Gate/);
    expect(venue.placed).toHaveLength(0);

    await db.execute(sql`DELETE FROM risk_gates WHERE id = ${gate!.id}`);
    await db.execute(sql`DELETE FROM signals WHERE id = ${sig2!.id}`);
  });

  it('buildAccountState: Equity spiegelt geschlossene Paper-Trades', async () => {
    const state = await buildAccountState(db, userId);
    expect(state.equity).toBeGreaterThan(10_000); // der TP-Trade oben war netto positiv
    expect(state.openPositions).toBe(0);
  });
});
