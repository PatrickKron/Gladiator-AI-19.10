/**
 * SAFE-003…010 (10_ §5a/§5b) — Verdrahtung im Executor gegen die ECHTE DB
 * (Server-CI; lokal ohne DATABASE_URL skip). Geprüft wird, dass der Executor
 * die Eingaben aus echten Tabellen (orders, executed_trades, ohlcv,
 * market_regimes) und dem Live-Preis der Venue erhebt und die Risk-Engine
 * VOR jeder Order blockt bzw. die Größe reduziert.
 * Venue = deterministisches Test-Double (nur in Tests erlaubt); es bepreist
 * NUR die eigenen, prozess-eindeutigen Symbole (Isolation gegen parallel
 * laufende Testdateien — gleiches Muster wie executor-scope.test.ts).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import type { RiskCheck } from '@gladiator/risk';
import type { TradingVenue, VenueOrderRequest, VenueOrderResult } from './venue.js';
import { executeConfirmedSignal, loadIntradayMovePct, loadOrderRiskInputs } from './executor.js';

const { signals, strategies, strategyVersions, users, orders, executedTrades, ohlcv, marketRegimes } = schema;
const hasDb = Boolean(process.env.DATABASE_URL);
const PREFIX = `SAFE${process.pid}`;
let symSeq = 0;
/** Jeder Test bekommt sein eigenes Symbol (Kerzen/Regime sind global je Symbol). */
const nextSymbol = () => `${PREFIX}X${++symSeq}/USDT`;

class TestVenue implements TradingVenue {
  readonly id = 'paper-internal';
  readonly kind = 'paper' as const;
  price = 100;
  failPrice = false;
  placed: VenueOrderRequest[] = [];
  async validate() {
    return { ok: true, detail: 'test' };
  }
  async marketRules() {
    return { tickSize: 0.1, lotSize: 0.000001, minNotional: 5 };
  }
  async markPrice(symbol: string) {
    if (!symbol.startsWith(PREFIX)) throw new Error(`fremdes Test-Symbol ${symbol}`);
    if (this.failPrice) throw new Error('Preisquelle down');
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

describe.skipIf(!hasDb)('SAFE-Regeln im Executor (Paper, echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;
  let strategyId: string;
  let versionId: string;
  const userIds: string[] = [];
  const symbols: string[] = [];
  const RUN = `${process.pid}-${Date.now()}`;
  const NEUTRAL_CTX = { noTrade: null, vix: null };

  async function newUser(): Promise<string> {
    const [u] = await db.insert(users).values({ email: `safe-test-${RUN}-${userIds.length}@test.invalid` }).returning();
    userIds.push(u!.id);
    return u!.id;
  }

  async function newSignal(symbol: string, direction: 'long' | 'short' = 'long'): Promise<string> {
    const [sig] = await db
      .insert(signals)
      .values({
        source: 'engine',
        strategyId,
        strategyVersionId: versionId,
        symbol,
        timeframe: '1h',
        assetClass: 'crypto',
        venueType: 'cex',
        direction,
        setupType: 'swing',
        entry: '100',
        stopLoss: direction === 'long' ? '90' : '110',
        takeProfits: direction === 'long' ? ['110', '120', '130'] : ['90', '80', '70'],
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

  function sym(): string {
    const s = nextSymbol();
    symbols.push(s);
    return s;
  }

  const checkOf = (checks: RiskCheck[], name: string) => checks.find((c) => c.name === name);

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [s] = await db.insert(strategies).values({ slug: `safe-test-${RUN}`, name: 'SAFE Test', kind: 'builtin' }).returning();
    strategyId = s!.id;
    const [v] = await db.insert(strategyVersions).values({ strategyId, version: 1, params: {}, status: 'paper' }).returning();
    versionId = v!.id;
  });

  afterAll(async () => {
    for (const userId of userIds) {
      await db.execute(sql`DELETE FROM study_trades WHERE executed_trade_id IN (SELECT id FROM executed_trades WHERE user_id = ${userId})`);
      await db.execute(sql`DELETE FROM executed_trades WHERE user_id = ${userId}`);
      await db.execute(sql`DELETE FROM positions WHERE user_id = ${userId}`);
      await db.execute(sql`DELETE FROM orders WHERE user_id = ${userId}`);
      await db.execute(sql`DELETE FROM audit_log WHERE user_id = ${userId}`);
    }
    await db.execute(sql`DELETE FROM ohlcv WHERE symbol LIKE ${`${PREFIX}%`}`);
    await db.execute(sql`DELETE FROM market_regimes WHERE symbol LIKE ${`${PREFIX}%`}`);
    await db.execute(sql`DELETE FROM signals WHERE strategy_id = ${strategyId}`);
    await db.execute(sql`DELETE FROM strategies WHERE id = ${strategyId}`);
    for (const userId of userIds) await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await pool.end();
  });

  it('grüner Pfad: Live-Mark + Latenz erhoben, Collar geprüft, Entry-Slippage am Order-Datensatz gespeichert', async () => {
    const userId = await newUser();
    const symbol = sym();
    const venue = new TestVenue();
    const res = await executeConfirmedSignal(db, venue, { signalId: await newSignal(symbol), userId, riskContext: NEUTRAL_CTX });
    expect(res.executed, res.detail).toBe(true);
    const collar = checkOf(res.verdict.checks, 'safe-008-collar')!;
    expect(collar.passed).toBe(true);
    expect(collar.skipped).toBeFalsy();
    expect(checkOf(res.verdict.checks, 'safe-004-latency')!.skipped).toBeFalsy();
    expect(checkOf(res.verdict.checks, 'safe-008-rate')!.skipped).toBeFalsy();
    expect(checkOf(res.verdict.checks, 'safe-010-cooldown')!.skipped).toBeFalsy();
    expect(checkOf(res.verdict.checks, 'safe-010-open-orders')!.skipped).toBeFalsy();
    // Keine Kerzen/Regime für das frische Symbol → ehrlich übersprungen, kein Block
    expect(checkOf(res.verdict.checks, 'safe-005-stale')!.skipped).toBe(true);
    expect(checkOf(res.verdict.checks, 'safe-007-regime')!.skipped).toBe(true);

    const r = await db.execute(
      sql`SELECT raw FROM orders WHERE user_id = ${userId} AND type = 'market' AND reduce_only = false`,
    );
    expect(r.rows[0]).toMatchObject({ raw: { expectedPrice: 100, slippagePct: 0 } });
  });

  it('SAFE-008 Price-Collar: Live-Mark 103 vs Entry 100 → Block VOR jeder Order', async () => {
    const userId = await newUser();
    const venue = new TestVenue();
    venue.price = 103;
    const res = await executeConfirmedSignal(db, venue, { signalId: await newSignal(sym()), userId, riskContext: NEUTRAL_CTX });
    expect(res.executed).toBe(false);
    expect(res.detail).toMatch(/SAFE-008.*Collar/);
    expect(venue.placed).toHaveLength(0);
  });

  it('SAFE-008: Live-Preis nicht abrufbar → Block (sicherheitskritisch, nichts geraten)', async () => {
    const userId = await newUser();
    const venue = new TestVenue();
    venue.failPrice = true;
    const res = await executeConfirmedSignal(db, venue, { signalId: await newSignal(sym()), userId, riskContext: NEUTRAL_CTX });
    expect(res.executed).toBe(false);
    expect(res.detail).toMatch(/SAFE-008.*Live-Preis/);
    expect(venue.placed).toHaveLength(0);
  });

  it('SAFE-008: 10 Entry-Orders in der letzten Minute → Block', async () => {
    const userId = await newUser();
    const other = sym();
    await db.insert(orders).values(
      Array.from({ length: 10 }, (_, i) => ({
        userId, venue: 'paper-internal', symbol: other, clientOrderId: `safe-rate-${RUN}-${i}`,
        type: 'market' as const, side: 'buy' as const, qty: '1', price: '100', status: 'filled' as const, mode: 'paper' as const,
      })),
    );
    const venue = new TestVenue();
    const res = await executeConfirmedSignal(db, venue, { signalId: await newSignal(sym()), userId, riskContext: NEUTRAL_CTX });
    expect(res.executed).toBe(false);
    expect(res.detail).toMatch(/SAFE-008.*Orders\/min/);
  });

  it('SAFE-010: Gegenrichtung vor 1 min geschlossen → Cooldown-Block; gleiche Richtung frei', async () => {
    const userId = await newUser();
    const symbol = sym();
    const now = Date.now();
    await db.insert(executedTrades).values({
      userId, venue: 'paper-internal', symbol, direction: 'short',
      entryTs: new Date(now - 3_600_000), exitTs: new Date(now - 60_000),
      entryPrice: '100', exitPrice: '101', qty: '1', netPnl: '-1', mode: 'paper',
    });
    const venue = new TestVenue();
    const blocked = await executeConfirmedSignal(db, venue, { signalId: await newSignal(symbol, 'long'), userId, riskContext: NEUTRAL_CTX });
    expect(blocked.executed).toBe(false);
    expect(blocked.detail).toMatch(/SAFE-010.*Cooldown/);

    const same = await executeConfirmedSignal(db, venue, { signalId: await newSignal(symbol, 'short'), userId, riskContext: NEUTRAL_CTX });
    expect(same.executed, same.detail).toBe(true);
  });

  it('SAFE-010: 3 offene Entry-Orders auf dem Asset → Block (Schutz-Orders zählen nicht)', async () => {
    const userId = await newUser();
    const symbol = sym();
    await db.insert(orders).values(
      Array.from({ length: 3 }, (_, i) => ({
        userId, venue: 'paper-internal', symbol, clientOrderId: `safe-open-${RUN}-${i}`,
        type: 'limit' as const, side: 'buy' as const, qty: '1', price: '95', status: 'open' as const, mode: 'paper' as const,
        // createdAt älter als 60 s → zählt NICHT zur Order-Rate, nur zu den offenen Orders
        createdAt: new Date(Date.now() - 10 * 60_000),
      })),
    );
    const venue = new TestVenue();
    const res = await executeConfirmedSignal(db, venue, { signalId: await newSignal(symbol), userId, riskContext: NEUTRAL_CTX });
    expect(res.executed).toBe(false);
    expect(res.detail).toMatch(/SAFE-010.*offene Orders/);
  });

  it('SAFE-006: Entry-Fill mit 1,5 % Slippage in 24 h → Market-Entry geblockt', async () => {
    const userId = await newUser();
    await db.insert(orders).values({
      userId, venue: 'paper-internal', symbol: sym(), clientOrderId: `safe-slip-${RUN}`,
      type: 'market', side: 'buy', qty: '1', price: '101.5', status: 'filled', mode: 'paper',
      raw: { expectedPrice: 100, slippagePct: 1.5 },
      createdAt: new Date(Date.now() - 3_600_000),
    });
    const venue = new TestVenue();
    const res = await executeConfirmedSignal(db, venue, { signalId: await newSignal(sym()), userId, riskContext: NEUTRAL_CTX });
    expect(res.executed).toBe(false);
    expect(res.detail).toMatch(/SAFE-006/);
  });

  it('SAFE-005: letzte 1h-Kerze 5 h alt (erlaubt 2 h + Scan-Takt + 5 min) → Block', async () => {
    const userId = await newUser();
    const symbol = sym();
    const last = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 5 * 3_600_000);
    await db.insert(ohlcv).values(
      Array.from({ length: 30 }, (_, i) => ({
        venue: 'binance', symbol, timeframe: '1h', ts: new Date(last.getTime() - (29 - i) * 3_600_000),
        open: '100', high: '101', low: '99', close: i % 2 === 0 ? '100' : '100.5', volume: '1',
      })),
    );
    const venue = new TestVenue();
    const res = await executeConfirmedSignal(db, venue, { signalId: await newSignal(symbol), userId, riskContext: NEUTRAL_CTX });
    expect(res.executed).toBe(false);
    expect(res.detail).toMatch(/SAFE-005.*veraltet/);
    // Z-Score wurde aus denselben echten Kerzen berechnet (Mark 100 ≈ Closes) → bestanden
    const z = checkOf(res.verdict.checks, 'safe-005-zscore')!;
    expect(z.passed).toBe(true);
    expect(z.skipped).toBeFalsy();
  });

  it('SAFE-007: 4 Regime-Wechsel in 24 h → Größe −75 % (Order läuft mit 25 %)', async () => {
    const userId = await newUser();
    const symbol = sym();
    const now = Date.now();
    const seq = ['bull', 'bear', 'bull', 'sideways', 'bear'];
    await db.insert(marketRegimes).values(
      seq.map((regime, i) => ({
        symbol, timeframe: '1h', ts: new Date(now - (20 - i * 4) * 3_600_000), regime, confidence: '0.6', components: [],
      })),
    );
    const venue = new TestVenue();
    const res = await executeConfirmedSignal(db, venue, { signalId: await newSignal(symbol), userId, riskContext: NEUTRAL_CTX });
    expect(res.executed, res.detail).toBe(true);
    // Basis: 10.000 × 1 % / 10 = 10 → 25 % = 2,5
    expect(res.qty).toBeCloseTo(2.5, 6);
    expect(checkOf(res.verdict.checks, 'safe-007-regime')!.detail).toMatch(/−75 %/);
  });

  it('loadOrderRiskInputs: liefert die Rohdaten ehrlich (null/[] statt erfundener Werte)', async () => {
    const userId = await newUser();
    const venue = new TestVenue();
    venue.failPrice = true;
    const ctx = await loadOrderRiskInputs(db, venue, { userId, symbol: sym(), timeframe: '1h', direction: 'long' });
    expect(ctx.markPrice).toBeNull();
    expect(ctx.priceLatencyMs).toBeNull();
    expect(ctx.marketData).toBeNull();
    expect(ctx.priceZScore).toBeNull();
    expect(ctx.recentSlippagePct).toEqual([]);
    expect(ctx.regimeChanges24h).toBeNull();
    expect(ctx.entryOrdersLastMinute).toBe(0);
    expect(ctx.openEntryOrdersOnSymbol).toBe(0);
    expect(ctx.lastOppositeCloseAt).toBeNull();
  });

  it('SAFE-003 loadIntradayMovePct: größte Auslenkung seit UTC-Tagesbeginn aus echten 1h-Kerzen; keine Kerzen → null', async () => {
    const symbol = sym();
    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    expect(await loadIntradayMovePct(db, symbol, now)).toBeNull();
    // Tages-Open 100, Tief 88 → 12 % (aktuelle Kerze = jüngste volle Stunde → frisch)
    const lastHour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
    await db.insert(ohlcv).values([
      { venue: 'binance', symbol, timeframe: '1h', ts: dayStart, open: '100', high: '102', low: '97', close: '98', volume: '1' },
      ...(lastHour.getTime() > dayStart.getTime()
        ? [{ venue: 'binance', symbol, timeframe: '1h', ts: lastHour, open: '98', high: '99', low: '88', close: '90', volume: '1' }]
        : []),
    ]);
    const move = await loadIntradayMovePct(db, symbol, now);
    expect(move).toBeCloseTo(lastHour.getTime() > dayStart.getTime() ? 12 : 3, 6);
  });
});
