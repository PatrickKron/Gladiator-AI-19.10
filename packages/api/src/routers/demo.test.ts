/**
 * Demo-Router gegen die ECHTE DB (Server-CI; lokal ohne DATABASE_URL
 * übersprungen): Konto → Vorschau → Order → Position → Close → Performance →
 * Reset über den tRPC-Caller (inkl. Auth). Buch-Quelle ist ein deterministisches
 * Test-Double (setDemoBookSourceForTests) — die Engine-Details deckt
 * exchange/demo/engine.test.ts ab.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type { DemoBookSource, MarketRules, OrderBookSnapshot } from '@gladiator/exchange';
import type pg from 'pg';
import { appRouter } from './index.js';
import { buildContext, createCallerFactory } from '../trpc.js';
import { register } from '../auth/service.js';
import { setDemoBookSourceForTests } from './demo.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  console.warn('[demo.test] DATABASE_URL nicht gesetzt — übersprungen (Server-CI maßgeblich).');
}
if (hasDb && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = `test-secret-${Date.now()}-nicht-fuer-produktion`;
}

const createCaller = createCallerFactory(appRouter);
const RUN = `${process.pid}-${Date.now()}`;
const EMAIL = `demo-router-test-${RUN}@test.invalid`;
const { users, orders, positions, executedTrades } = schema;

class FakeBookSource implements DemoBookSource {
  book: OrderBookSnapshot = {
    symbol: 'BTC/USDT',
    ts: 0,
    bids: [{ price: 50_000, qty: 10 }],
    asks: [{ price: 50_100, qty: 10 }],
  };
  async fetchBook(symbol: string): Promise<OrderBookSnapshot> {
    return { ...this.book, symbol };
  }
  async marketRules(): Promise<MarketRules> {
    return { tickSize: 0.01, lotSize: 0.000001, minNotional: 5 };
  }
}

describe.skipIf(!hasDb)('Demo-Router: Konto, Order, Close, Performance, Reset', () => {
  let db: Db;
  let pool: pg.Pool;
  let caller: ReturnType<typeof createCaller>;
  let userId: string;
  const source = new FakeBookSource();

  beforeAll(async () => {
    ({ db, pool } = createDb());
    setDemoBookSourceForTests(source);
    const res = await register(db, { email: EMAIL, password: 'sehr-sicheres-passwort-123', name: 'Demo' });
    userId = res.user.id;
    caller = createCaller(await buildContext({ db, authorizationHeader: `Bearer ${res.accessToken}` }));
  });

  afterAll(async () => {
    setDemoBookSourceForTests(null);
    await db.execute(sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email = ${EMAIL})`);
    await db.delete(users).where(eq(users.email, EMAIL)); // demo_* cascaden
    await pool.end();
  });

  it('account: entsteht lazy mit 100k, Fee-Sätze sichtbar', async () => {
    const a = await caller.demo.account();
    expect(a.balance).toBe(100_000);
    expect(a.feeRates).toEqual({ maker: 0.001, taker: 0.0015 });
  });

  it('preview: Spread + Fee vor dem Klick', async () => {
    const p = await caller.demo.preview({ symbol: 'BTC/USDT', direction: 'long', type: 'market', qty: 0.1 });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.spread).toBe(100);
    expect(p.estFillPrice).toBe(50_100);
  });

  it('placeOrder market → Position; ungültiger Stop → ehrliche 412', async () => {
    const r = await caller.demo.placeOrder({
      symbol: 'BTC/USDT',
      direction: 'long',
      type: 'market',
      qty: 0.1,
      stopLoss: 48_000,
      takeProfit: 55_000,
    });
    expect(r.placed).toBe(true);
    const pos = await caller.demo.positions();
    expect(pos).toHaveLength(1);
    expect(pos[0]!.stopLoss).toBe(48_000);
    expect(pos[0]!.unrealizedPnl).not.toBeNull();

    await expect(
      caller.demo.placeOrder({ symbol: 'BTC/USDT', direction: 'long', type: 'market', qty: 0.1, stopLoss: 99_000 }),
    ).rejects.toMatchObject({ message: 'demo:invalid_stop' });
  });

  it('closePosition realisiert; history + performance rechnen netto', async () => {
    const pos = await caller.demo.positions();
    source.book = { symbol: 'BTC/USDT', ts: 1, bids: [{ price: 52_000, qty: 10 }], asks: [{ price: 52_100, qty: 10 }] };
    const r = await caller.demo.closePosition({ positionId: pos[0]!.id });
    expect(r.closed).toBe(true);

    const history = await caller.demo.history({ limit: 10 });
    expect(history).toHaveLength(1);
    expect(history[0]!.netPnl).toBeCloseTo(
      history[0]!.grossPnl - history[0]!.fees - history[0]!.fundingPaid,
      6,
    );
    expect(history[0]!.rMultiple).not.toBeNull();

    const perf = await caller.demo.performance();
    expect(perf.trades).toBe(1);
    if (perf.trades === 0) return;
    expect(perf.netPnl).toBeCloseTo(history[0]!.netPnl, 6);
    expect(perf.winRate).toBe(1);
    expect(perf.equityCurve).toHaveLength(1);
  });

  it('reset: Konto wieder bei 100k, Historie leer', async () => {
    const r = await caller.demo.reset();
    expect(r.ok).toBe(true);
    expect(r.balance).toBe(100_000);
    const a = await caller.demo.account();
    expect(a.balance).toBe(100_000);
    expect(a.openPositions).toBe(0);
    const perf = await caller.demo.performance();
    expect(perf.trades).toBe(0);
  });

  it('SICHERHEIT: Demo-Flows haben orders/positions/executed_trades nicht berührt', async () => {
    expect(await db.select().from(orders).where(eq(orders.userId, userId))).toHaveLength(0);
    expect(await db.select().from(positions).where(eq(positions.userId, userId))).toHaveLength(0);
    expect(await db.select().from(executedTrades).where(eq(executedTrades.userId, userId))).toHaveLength(0);
  });
});
