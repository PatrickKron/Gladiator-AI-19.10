/**
 * Demo-Engine-Integrationstest gegen die ECHTE DB (Server-CI; lokal skip).
 * Buch-Quelle ist ein deterministisches Test-Double (nur in Tests erlaubt) —
 * geprüft wird: Konto lazy, Market-Fill (Fees/Spread/Slippage), Limit mit
 * Partial Fills über den Monitor, SL-Trigger, Netto-Trade, Reset — UND der
 * Sicherheits-Beweis: die echten Tabellen orders/positions/executed_trades
 * bleiben vom Demo-Pfad vollständig unberührt.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import type pg from 'pg';
import type { MarketRules } from '../venue.js';
import type { DemoBookSource } from './book-source.js';
import { DEMO_MAKER_FEE, DEMO_TAKER_FEE, type OrderBookSnapshot } from './fill-engine.js';
import {
  closeDemoPositionNow,
  demoAccountOverview,
  getOrCreateDemoAccount,
  monitorDemoTick,
  placeDemoOrder,
  previewDemoOrder,
  resetDemoAccount,
  setDemoProtection,
} from './engine.js';

const { users, demoOrders, demoPositions, demoTrades, orders, positions, executedTrades } = schema;

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) console.warn('[demo-engine.test] DATABASE_URL fehlt — übersprungen (Server-CI maßgeblich).');

/** Deterministische Buch-Quelle: Bid 50_000 / Ask 50_100, je 2 tiefe Level. */
class FakeBookSource implements DemoBookSource {
  book: OrderBookSnapshot = {
    symbol: 'BTC/USDT',
    ts: 0,
    bids: [
      { price: 50_000, qty: 1 },
      { price: 49_900, qty: 5 },
    ],
    asks: [
      { price: 50_100, qty: 1 },
      { price: 50_200, qty: 5 },
    ],
  };
  fetchCount = 0;
  async fetchBook(symbol: string): Promise<OrderBookSnapshot> {
    this.fetchCount++;
    return { ...this.book, symbol };
  }
  async marketRules(): Promise<MarketRules> {
    return { tickSize: 0.01, lotSize: 0.000001, minNotional: 5 };
  }
}

describe.skipIf(!hasDb)('Demo-Engine (echte DB, deterministisches Buch)', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  const RUN = `${process.pid}-${Date.now()}`;
  const source = new FakeBookSource();

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [u] = await db.insert(users).values({ email: `demo-test-${RUN}@test.invalid` }).returning();
    userId = u!.id;
  });

  afterAll(async () => {
    // demo_* hängen per ON DELETE CASCADE am User
    await db.execute(sql`DELETE FROM users WHERE email = ${`demo-test-${RUN}@test.invalid`}`);
    await pool.end();
  });

  it('Konto entsteht lazy mit 100.000 Startguthaben', async () => {
    const account = await getOrCreateDemoAccount(db, userId);
    expect(Number(account.startBalance)).toBe(100_000);
    expect(Number(account.balance)).toBe(100_000);
    const again = await getOrCreateDemoAccount(db, userId);
    expect(again.id).toBe(account.id); // idempotent
  });

  it('Vorschau rechnet mit echter Buchtiefe (Spread sichtbar)', async () => {
    const p = await previewDemoOrder(db, source, userId, {
      symbol: 'BTC/USDT',
      direction: 'long',
      type: 'market',
      qty: 0.5,
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.spread).toBe(100);
    expect(p.estFillPrice).toBe(50_100);
    expect(p.estFee).toBeCloseTo(0.5 * 50_100 * DEMO_TAKER_FEE, 8);
  });

  it('Market-Long füllt gegen die Asks, Fee geht sofort von der Balance ab', async () => {
    const r = await placeDemoOrder(db, source, userId, {
      symbol: 'BTC/USDT',
      direction: 'long',
      type: 'market',
      qty: 0.5,
      stopLoss: 45_000,
    });
    expect(r.placed).toBe(true);
    if (!r.placed) return;
    expect(r.status).toBe('filled');
    expect(r.avgFillPrice).toBe(50_100);
    // Slippage ggü. Mid 50_050: (50_100 − 50_050) × 0.5 = 25
    expect(r.slippage).toBeCloseTo(25, 8);

    const overview = await demoAccountOverview(db, source, userId);
    const fee = 0.5 * 50_100 * DEMO_TAKER_FEE;
    expect(overview.balance).toBeCloseTo(100_000 - fee, 6);
    expect(overview.openPositions).toBe(1);
    // uPnL gegen Mid: (50_050 − 50_100) × 0.5 = −25 → Equity = Balance − 25
    expect(overview.unrealizedPnl).toBeCloseTo(-25, 6);
  });

  it('Ablehnung ehrlich: zu große Order scheitert am verfügbaren Guthaben', async () => {
    const r = await placeDemoOrder(db, source, userId, {
      symbol: 'BTC/USDT',
      direction: 'long',
      type: 'market',
      qty: 5, // ~250k Notional > verfügbar
    });
    expect(r.placed).toBe(false);
    if (r.placed) return;
    expect(r.reason).toBe('insufficient_balance');
  });

  it('SL/TP-Plausibilität: Long-Stop über dem Markt wird abgelehnt', async () => {
    const r = await placeDemoOrder(db, source, userId, {
      symbol: 'BTC/USDT',
      direction: 'long',
      type: 'market',
      qty: 0.1,
      stopLoss: 60_000,
    });
    expect(r.placed).toBe(false);
    if (r.placed) return;
    expect(r.reason).toBe('invalid_stop');
  });

  it('Limit unter dem Markt ruht; Monitor füllt partiell als Maker, wenn das Buch kreuzt', async () => {
    // Verfügbar nach BTC-Long (~74.9k): 1.4 × 49.500 = 69.3k passt hinein
    const r = await placeDemoOrder(db, source, userId, {
      symbol: 'ETH/USDT',
      direction: 'long',
      type: 'limit',
      qty: 1.4,
      limitPrice: 49_500,
    });
    expect(r.placed).toBe(true);
    if (!r.placed) return;
    expect(r.status).toBe('open');
    expect(r.filledQty).toBe(0);

    // Markt fällt: Asks rutschen unter das Limit — aber nur 1.2 sichtbar
    source.book = {
      symbol: 'ETH/USDT',
      ts: 1,
      bids: [{ price: 49_300, qty: 2 }],
      asks: [
        { price: 49_400, qty: 1.2 },
        { price: 49_600, qty: 9 },
      ],
    };
    const account = await getOrCreateDemoAccount(db, userId);
    const tick1 = await monitorDemoTick(db, source, { accountId: account.id });
    expect(tick1.orderFills).toBe(1);

    const [order] = await db.select().from(demoOrders).where(eq(demoOrders.id, r.orderId));
    expect(order!.status).toBe('partially_filled');
    expect(Number(order!.filledQty)).toBeCloseTo(1.2, 8);
    expect(Number(order!.avgFillPrice)).toBe(49_500); // ruhender Fill zum Limitpreis
    expect(Number(order!.feePaid)).toBeCloseTo(1.2 * 49_500 * DEMO_MAKER_FEE, 6);

    // nächster Tick: Rest (0.2) füllt
    source.book.asks = [{ price: 49_400, qty: 10 }];
    const tick2 = await monitorDemoTick(db, source, { accountId: account.id });
    expect(tick2.orderFills).toBe(1);
    const [done] = await db.select().from(demoOrders).where(eq(demoOrders.id, r.orderId));
    expect(done!.status).toBe('filled');
    expect(Number(done!.filledQty)).toBeCloseTo(1.4, 8);
  });

  it('SL-Trigger schließt die Position über den Monitor und schreibt einen Netto-Trade', async () => {
    // ETH-Long (1.4 aus Limit-Fills — Position aggregiert) SL knapp unters Bid setzen
    const [pos] = await db
      .select()
      .from(demoPositions)
      .where(and(eq(demoPositions.userId, userId), eq(demoPositions.symbol, 'ETH/USDT')));
    expect(pos).toBeTruthy();
    const set = await setDemoProtection(db, source, userId, pos!.id, { stopLoss: 49_250 });
    expect(set.ok).toBe(true);

    // Markt fällt unter den Stop
    source.book = {
      symbol: 'ETH/USDT',
      ts: 2,
      bids: [{ price: 49_200, qty: 50 }],
      asks: [{ price: 49_210, qty: 50 }],
    };
    const account = await getOrCreateDemoAccount(db, userId);
    const tick = await monitorDemoTick(db, source, { accountId: account.id });
    expect(tick.triggeredCloses).toBe(1);

    const remaining = await db
      .select()
      .from(demoPositions)
      .where(and(eq(demoPositions.userId, userId), eq(demoPositions.symbol, 'ETH/USDT')));
    expect(remaining).toHaveLength(0);

    const trades = await db.select().from(demoTrades).where(eq(demoTrades.userId, userId));
    expect(trades).toHaveLength(1);
    const trade = trades[0]!;
    expect(trade.reason).toBe('sl');
    expect(trade.rMultiple).not.toBeNull(); // SL war gesetzt → definiertes Risiko
    // Netto = Gross − Fees − Funding (Slippage steckt in den Preisen, kein Doppelabzug)
    const gross = Number(trade.grossPnl);
    const fees = Number(trade.fees);
    const funding = Number(trade.fundingPaid);
    expect(Number(trade.netPnl)).toBeCloseTo(gross - fees - funding, 6);
    expect(gross).toBeLessThan(0); // Entry 49_500, Exit 49_200 → Verlust
  });

  it('manueller Teil-Close realisiert anteilig', async () => {
    // BTC-Long 0.5 aus dem Market-Test: die Hälfte schließen
    const [pos] = await db
      .select()
      .from(demoPositions)
      .where(and(eq(demoPositions.userId, userId), eq(demoPositions.symbol, 'BTC/USDT')));
    expect(pos).toBeTruthy();
    source.book = {
      symbol: 'BTC/USDT',
      ts: 3,
      bids: [{ price: 51_000, qty: 10 }],
      asks: [{ price: 51_100, qty: 10 }],
    };
    const r = await closeDemoPositionNow(db, source, userId, pos!.id, { qty: 0.25 });
    expect(r.closed).toBe(true);
    expect(r.closedQty).toBeCloseTo(0.25, 8);
    expect(r.netPnl).toBeGreaterThan(0); // Entry 50_100 → Exit 51_000

    const [after] = await db
      .select()
      .from(demoPositions)
      .where(and(eq(demoPositions.userId, userId), eq(demoPositions.symbol, 'BTC/USDT')));
    expect(Number(after!.qty)).toBeCloseTo(0.25, 8);
  });

  it('Reset: alles weg, Balance wieder 100.000, resetCount steigt', async () => {
    const account = await resetDemoAccount(db, userId);
    expect(Number(account.balance)).toBe(100_000);
    expect(account.resetCount).toBe(1);
    expect(await db.select().from(demoPositions).where(eq(demoPositions.userId, userId))).toHaveLength(0);
    expect(await db.select().from(demoOrders).where(eq(demoOrders.userId, userId))).toHaveLength(0);
    expect(await db.select().from(demoTrades).where(eq(demoTrades.userId, userId))).toHaveLength(0);
  });

  it('SICHERHEIT: der komplette Demo-Fluss hat orders/positions/executed_trades NICHT berührt', async () => {
    expect(await db.select().from(orders).where(eq(orders.userId, userId))).toHaveLength(0);
    expect(await db.select().from(positions).where(eq(positions.userId, userId))).toHaveLength(0);
    expect(await db.select().from(executedTrades).where(eq(executedTrades.userId, userId))).toHaveLength(0);
  });

  it('SICHERHEIT: demo/engine.ts importiert kein Venue und keinen placeOrder-Pfad', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('./engine.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/TradingVenue|placeOrder\s*\(|paper-venue|binance-venue|hyperliquid/);
  });
});
