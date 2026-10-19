/**
 * Notfallpfad (06_ §5, Freqtrade „emergency exit"): lässt sich der Stop-Loss
 * nach dem Entry NICHT platzieren, darf die Position nie ungeschützt offen
 * bleiben → sofort per reduceOnly-Market glattstellen, Kill-Switch an, Audit.
 * Ein fehlgeschlagener TP ist dagegen kein Notfall (der Stop schützt).
 * Gegen die ECHTE DB (Server-CI; lokal skip). Venue = Test-Double.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import type { TradingVenue, VenueOrderRequest, VenueOrderResult } from './venue.js';
import { executeConfirmedSignal } from './executor.js';

const { signals, strategies, strategyVersions, users } = schema;
const hasDb = Boolean(process.env.DATABASE_URL);
const SYMBOL = `PROTFAIL${process.pid}/USDT`;

class FlakyVenue implements TradingVenue {
  readonly id = 'paper-internal';
  readonly kind = 'paper' as const;
  price = 100;
  fail: 'stop' | 'tp' | 'stop+close' | null = null;
  placed: VenueOrderRequest[] = [];
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
    this.placed.push(req);
    if (req.type === 'stop_market' && this.fail?.startsWith('stop')) throw new Error('Börse: Stop-Order abgelehnt (Test)');
    if (req.type === 'take_profit_market' && this.fail === 'tp') return { clientOrderId: req.clientOrderId, exchangeOrderId: '', status: 'rejected' };
    if (req.type === 'market' && req.reduceOnly && this.fail === 'stop+close') throw new Error('Börse nicht erreichbar (Test)');
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

describe.skipIf(!hasDb)('Schutz-Order-Fehler: Notfall-Glattstellung (echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  let strategyId: string;
  const RUN = `${process.pid}-${Date.now()}`;
  const NEUTRAL_CTX = { noTrade: null, vix: null };

  async function newSignal(): Promise<string> {
    const [sig] = await db
      .insert(signals)
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
        takeProfits: ['110', '120'],
        leverageSuggested: '1',
        score: '8',
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

  const killSwitch = async () =>
    (await db.execute(sql`SELECT kill_switch_active AS k FROM trading_settings WHERE user_id = ${userId}`)).rows[0]?.k;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [u] = await db.insert(users).values({ email: `protfail-${RUN}@test.invalid` }).returning();
    userId = u!.id;
    const [s] = await db.insert(strategies).values({ slug: `protfail-${RUN}`, name: 'ProtFail', kind: 'builtin' }).returning();
    strategyId = s!.id;
    await db.insert(strategyVersions).values({ strategyId, version: 1, params: {}, status: 'paper' });
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM study_trades WHERE executed_trade_id IN (SELECT id FROM executed_trades WHERE user_id = ${userId})`);
    await db.execute(sql`DELETE FROM executed_trades WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM positions WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM orders WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM audit_log WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM trading_settings WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM signals WHERE strategy_id = ${strategyId}`);
    await db.execute(sql`DELETE FROM strategy_versions WHERE strategy_id = ${strategyId}`);
    await db.execute(sql`DELETE FROM strategies WHERE id = ${strategyId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await pool.end();
  });

  it('TP lässt sich nicht setzen → Position bleibt (Stop schützt), Warnung im Audit', async () => {
    const venue = new FlakyVenue();
    venue.fail = 'tp';
    const res = await executeConfirmedSignal(db, venue, { signalId: await newSignal(), userId, riskContext: NEUTRAL_CTX });
    expect(res.executed).toBe(true);
    expect(res.emergency).toBeUndefined();
    const warn = await db.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE user_id = ${userId} AND action = 'order.protection.failed'`);
    expect(warn.rows[0]!.n).toBe(2);
    await db.execute(sql`DELETE FROM positions WHERE user_id = ${userId}`); // aufräumen für den nächsten Fall
    await db.execute(sql`UPDATE orders SET status = 'canceled' WHERE user_id = ${userId} AND status = 'open'`);
  });

  it('Stop lässt sich nicht setzen → sofort glattgestellt, Kill-Switch an, Notfall gemeldet', async () => {
    const venue = new FlakyVenue();
    venue.fail = 'stop';
    const res = await executeConfirmedSignal(db, venue, { signalId: await newSignal(), userId, riskContext: NEUTRAL_CTX });
    expect(res.executed).toBe(false);
    expect(res.emergency).toMatchObject({ closed: true });
    const close = venue.placed.find((o) => o.type === 'market' && o.reduceOnly);
    expect(close).toMatchObject({ side: 'sell', symbol: SYMBOL });
    const open = await db.execute(sql`SELECT count(*)::int AS n FROM positions WHERE user_id = ${userId}`);
    expect(open.rows[0]!.n).toBe(0);
    expect(await killSwitch()).toBe(true);
    const audit = await db.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE user_id = ${userId} AND action = 'position.emergency_close'`);
    expect(audit.rows[0]!.n).toBe(1);
    await db.execute(sql`UPDATE trading_settings SET kill_switch_active = false WHERE user_id = ${userId}`);
  });

  it('Stop UND Notfall-Schluss scheitern → Position bleibt sichtbar, Kill-Switch an, als UNGESCHÜTZT gemeldet', async () => {
    const venue = new FlakyVenue();
    venue.fail = 'stop+close';
    const res = await executeConfirmedSignal(db, venue, { signalId: await newSignal(), userId, riskContext: NEUTRAL_CTX });
    expect(res.executed).toBe(false);
    expect(res.emergency).toMatchObject({ closed: false });
    expect(res.detail).toMatch(/UNGESCHÜTZT/);
    expect(await killSwitch()).toBe(true);
    const open = await db.execute(sql`SELECT count(*)::int AS n FROM positions WHERE user_id = ${userId}`);
    expect(open.rows[0]!.n).toBe(1);
  });
});
