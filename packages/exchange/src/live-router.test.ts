/**
 * Live-Order-Pfad (OFFENER_PLAN §2) — Integrationstest gegen die echte DB
 * mit skriptbarem CCXT-Test-Double (nur in Tests erlaubt):
 * 1. Ohne Trading-Verbindung → Live-Router blockt ehrlich (nie stiller Paper-Fallback).
 * 2. Ohne aktive Freigabe (`venue_approvals`: LIVE-FREIGABE <venue>) → blockt ehrlich.
 * 3. Mit Trading-Verbindung + Freigabe + `trading_settings.mode = 'live'` →
 *    Sizing gegen echtes `equityUsd()`, Entry + 4 Schutz-Orders an der Börse,
 *    `orders.mode = 'live'`, `positions.mode = 'live'`, Monitor-Abfrage über
 *    `fetchOrderState` (Break-Even nach TP1 + Netto-Vollschluss) und grüne Reconciliation.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import type { CcxtLiveClient, CcxtOrder } from './ccxt-live-venue.js';
import {
  connectExchange,
  hasApprovedLiveVenue,
  resolveLiveVenueById,
  resolveLiveVenueForSymbol,
  type CcxtLikeClient,
} from './connections.js';
import {
  buildAccountState,
  closePositionNow,
  executeConfirmedSignal,
  monitorOpenPositions,
  reconcile,
  reconcileAllVenues,
} from './executor.js';
import { PaperVenue } from './paper-venue.js';

const {
  users,
  strategies,
  strategyVersions,
  signals,
  tradingSettings,
  venueApprovals,
  exchangeConnections,
  orders,
  positions,
  executedTrades,
} = schema;

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  console.warn('[live-router.test] DATABASE_URL fehlt — übersprungen (Server-CI maßgeblich).');
}
if (hasDb && !process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
}

class ScriptedLiveClient implements CcxtLiveClient, CcxtLikeClient {
  last = 2000;
  balanceUsdt = 5000;
  open: CcxtOrder[] = [];
  closed: CcxtOrder[] = [];
  livePositions: { symbol: string; side?: string; contracts?: number; contractSize?: number; entryPrice?: number }[] = [];
  markets = {
    'ETH/USDT': { symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, contract: false },
    'ETH/USDT:USDT': {
      symbol: 'ETH/USDT:USDT',
      base: 'ETH',
      quote: 'USDT',
      active: true,
      contract: true,
      linear: true,
      contractSize: 1,
      precision: { amount: 0.001, price: 0.1 },
      limits: { cost: { min: 5 }, leverage: { max: 50 } },
    },
  };

  async loadMarkets() {
    return this.markets;
  }
  market(symbol: string) {
    const m = this.markets[symbol as keyof typeof this.markets];
    if (!m) throw new Error(`unbekanntes Symbol ${symbol}`);
    return m;
  }
  amountToPrecision(_symbol: string, amount: number) {
    return String(Math.floor(amount * 1000 + 1e-9) / 1000);
  }
  priceToPrecision(_symbol: string, price: number) {
    return String(Math.round(price * 10) / 10);
  }
  async fetchTicker() {
    return { last: this.last };
  }
  async fetchBalance() {
    return { total: { USDT: this.balanceUsdt }, free: { USDT: this.balanceUsdt }, used: { USDT: 0 } };
  }
  async createOrder(_symbol: string, _type: string, _side: string, amount: number, _price?: number, params: Record<string, unknown> = {}) {
    const isTrigger = 'stopLossPrice' in params || 'takeProfitPrice' in params;
    const o: CcxtOrder = {
      id: `live-ord-${this.open.length + this.closed.length + 1}`,
      clientOrderId: String(params.clientOrderId ?? ''),
      status: isTrigger ? 'open' : 'closed',
      average: isTrigger ? undefined : this.last,
      filled: isTrigger ? 0 : amount,
      amount,
    };
    if (isTrigger) {
      this.open.push(o);
    } else {
      this.closed.push(o);
    }
    return o;
  }
  async cancelOrder(id: string) {
    this.open = this.open.filter((o) => o.id !== id);
    return {};
  }
  async fetchOrder(id: string) {
    const found = [...this.open, ...this.closed].find((o) => o.id === id);
    if (!found) throw new Error(`Order ${id} nicht gefunden`);
    return found;
  }
  async fetchOpenOrders() {
    return this.open;
  }
  async fetchClosedOrders() {
    return this.closed;
  }
  async fetchPositions() {
    return this.livePositions;
  }
}

describe.skipIf(!hasDb)('Live-Order-Pfad über CCXT-Router + Freigabe-Gate', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  let strategyId: string;
  let versionId: string;
  const RUN = `${process.pid}-${Date.now()}`;
  const NEUTRAL_CTX = { noTrade: null, vix: null };
  const fakeClient = new ScriptedLiveClient();
  class ScriptedPaperVenue extends PaperVenue {
    override async markPrice() {
      return fakeClient.last;
    }
    override async marketRules() {
      return { tickSize: 0.01, lotSize: 0.001, minNotional: 5 };
    }
  }
  const basePaperVenue = new ScriptedPaperVenue();

  async function createConfirmedSignal(symbol = 'ETH/USDT', venue = 'binance') {
    const [sig] = await db
      .insert(signals)
      .values({
        source: 'engine',
        strategyId,
        strategyVersionId: versionId,
        symbol,
        venue,
        timeframe: '1h',
        assetClass: 'crypto',
        venueType: 'cex',
        direction: 'long',
        setupType: 'swing',
        entry: '2000',
        stopLoss: '1900',
        takeProfits: ['2100', '2200', '2300'],
        leverageSuggested: '1',
        score: '8.5',
        riskClass: 'low',
        confluence: ['Live-Router-Test'],
        session: 'london',
        emaRegime: 'above',
        marketPhase: 'bull',
        status: 'confirmed',
      })
      .returning();
    return sig!;
  }

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [u] = await db.insert(users).values({ email: `live-router-${RUN}@test.invalid` }).returning();
    userId = u!.id;

    const [s] = await db
      .insert(strategies)
      .values({ slug: `live-router-${RUN}`, name: 'Live Router Test', kind: 'builtin' })
      .returning();
    strategyId = s!.id;

    const [v] = await db
      .insert(strategyVersions)
      .values({ strategyId, version: 1, params: {}, status: 'paper' })
      .returning();
    versionId = v!.id;

    await db.delete(venueApprovals).where(eq(venueApprovals.venueId, 'bybit'));
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM study_trades WHERE executed_trade_id IN (SELECT id FROM executed_trades WHERE user_id = ${userId})`);
    await db.delete(executedTrades).where(eq(executedTrades.userId, userId));
    await db.delete(positions).where(eq(positions.userId, userId));
    await db.delete(orders).where(eq(orders.userId, userId));
    await db.delete(exchangeConnections).where(eq(exchangeConnections.userId, userId));
    await db.delete(venueApprovals).where(eq(venueApprovals.approvedBy, userId));
    await db.delete(tradingSettings).where(eq(tradingSettings.userId, userId));
    await db.execute(sql`DELETE FROM audit_log WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM signals WHERE strategy_id = ${strategyId}`);
    await db.delete(strategies).where(eq(strategies.id, strategyId));
    await db.delete(users).where(eq(users.id, userId));
    await pool.end();
  });

  it('1. Ohne verbundene Trading-Börse blockt der Live-Router ehrlich', async () => {
    await db.insert(tradingSettings).values({ userId, mode: 'live' });
    const check = await hasApprovedLiveVenue(db, userId);
    expect(check.ok).toBe(false);

    const sig = await createConfirmedSignal();
    const res = await executeConfirmedSignal(db, basePaperVenue, {
      signalId: sig.id,
      userId,
      riskContext: NEUTRAL_CTX,
      createLiveClient: () => fakeClient,
    });
    expect(res.executed).toBe(false);
    expect(res.detail).toMatch(/Keine aktive Trading-Börse/);
  });

  it('2. Mit Trading-Börse, aber OHNE LIVE-FREIGABE blockt der Live-Router weiterhin', async () => {
    await connectExchange(
      db,
      {
        userId,
        exchangeId: 'bybit',
        mode: 'trading',
        credentials: { apiKey: 'bybit-test-key-1234', secret: 'bybit-test-secret-5678' },
      },
      () => fakeClient,
    );

    const check = await hasApprovedLiveVenue(db, userId);
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/fehlt noch die Live-Freigabe/);

    const resolved = await resolveLiveVenueForSymbol(db, userId, 'ETH/USDT', {
      createLiveClient: () => fakeClient,
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toBe('not_approved');

    const sig = await createConfirmedSignal();
    const res = await executeConfirmedSignal(db, basePaperVenue, {
      signalId: sig.id,
      userId,
      riskContext: NEUTRAL_CTX,
      createLiveClient: () => fakeClient,
    });
    expect(res.executed).toBe(false);
    expect(res.detail).toMatch(/LIVE-FREIGABE bybit/);
  });

  it('3. Mit aktiver LIVE-FREIGABE + Live-Modus: E2E Entry + Schutz-Orders + Reconciliation + Monitor-Vollschluss', async () => {
    await db.insert(venueApprovals).values({
      venueId: 'bybit',
      approvedBy: userId,
      note: 'Kleinst-Trade-Probe Freigabe',
    });

    const check = await hasApprovedLiveVenue(db, userId);
    expect(check.ok).toBe(true);
    expect(check.approvedExchanges).toContain('bybit');

    const sig = await createConfirmedSignal();
    const res = await executeConfirmedSignal(db, basePaperVenue, {
      signalId: sig.id,
      userId,
      riskContext: NEUTRAL_CTX,
      createLiveClient: () => fakeClient,
    });

    expect(res.executed).toBe(true);
    expect(res.detail).toMatch(/Live-Order ausgeführt @ 2000/);
    // Live-Equity = 5.000 USDT × 1 % Risiko = 50 USD / 100 Stop-Abstand = 0.5 ETH
    expect(res.qty).toBeCloseTo(0.5, 6);

    const [pos] = await db.select().from(positions).where(eq(positions.userId, userId));
    expect(pos).toBeDefined();
    expect(pos!.mode).toBe('live');
    expect(pos!.venue.startsWith('live:')).toBe(true);

    // Reconciliation: Börse meldet ETH/USDT:USDT Long 0.5 → stimmt mit DB-Position ETH/USDT überein
    fakeClient.livePositions = [
      { symbol: 'ETH/USDT:USDT', side: 'long', contracts: 0.5, contractSize: 1, entryPrice: 2000 },
    ];
    const liveVenue = await resolveLiveVenueById(db, pos!.venue, { createLiveClient: () => fakeClient });
    expect(liveVenue).not.toBeNull();
    const rec = await reconcile(db, liveVenue!);
    expect(rec.ok).toBe(true);
    expect(rec.findings).toHaveLength(0);

    // Monitor: TP1 wird an der Börse gefüllt → Stop zieht auf Break-Even (2000) nach
    const openOrders = await db
      .select()
      .from(orders)
      .where(eq(orders.userId, userId));
    expect(openOrders.every((o) => o.mode === 'live')).toBe(true);

    const tp1Row = openOrders.find((o) => o.clientOrderId.endsWith('-tp1'))!;
    const tp1OnEx = fakeClient.open.find((o) => o.id === tp1Row.exchangeOrderId)!;
    fakeClient.open = fakeClient.open.filter((o) => o.id !== tp1OnEx.id);
    fakeClient.closed.push({ ...tp1OnEx, status: 'closed', average: 2100, filled: tp1OnEx.amount });
    fakeClient.last = 2105;

    const tick1 = await monitorOpenPositions(db, basePaperVenue, {
      userIds: [userId],
      createLiveClient: () => fakeClient,
    });
    expect(tick1.fills).toBe(1);

    const [slAfterTp1] = await db
      .select()
      .from(orders)
      .where(sql`${orders.userId} = ${userId} AND ${orders.type} = 'stop_market' AND ${orders.status} = 'open'`);
    expect(Number(slAfterTp1!.price)).toBeCloseTo(2000, 6);

    // Monitor: TP2 + TP3 füllen an der Börse → Vollschluss netto in executed_trades (mode = 'live')
    for (const suffix of ['-tp2', '-tp3']) {
      const row = openOrders.find((o) => o.clientOrderId.endsWith(suffix))!;
      const ex = fakeClient.open.find((o) => o.id === row.exchangeOrderId)!;
      fakeClient.open = fakeClient.open.filter((o) => o.id !== ex.id);
      fakeClient.closed.push({
        ...ex,
        status: 'closed',
        average: suffix === '-tp2' ? 2200 : 2300,
        filled: ex.amount,
      });
    }
    fakeClient.last = 2305;

    const tick2 = await monitorOpenPositions(db, basePaperVenue, {
      userIds: [userId],
      createLiveClient: () => fakeClient,
    });
    expect(tick2.fills).toBe(2);

    const remainingPos = await db.select().from(positions).where(eq(positions.userId, userId));
    expect(remainingPos).toHaveLength(0);

    const closedTrades = await db.select().from(executedTrades).where(eq(executedTrades.userId, userId));
    expect(closedTrades).toHaveLength(1);
    expect(closedTrades[0]!.mode).toBe('live');
    expect(Number(closedTrades[0]!.netPnl)).toBeGreaterThan(70);

    const liveState = await buildAccountState(db, userId, new Date(), { mode: 'live', liveEquityUsd: 5080 });
    expect(liveState.equity).toBe(5080);

    // 4. modeOverride: 'paper' (Paper-Sub-Agent) führt trotz aktivem Live-Modus strikt auf Paper aus
    fakeClient.open = [];
    fakeClient.last = 2000;
    const paperAgentSig = await createConfirmedSignal();
    const paperRes = await executeConfirmedSignal(db, basePaperVenue, {
      signalId: paperAgentSig.id,
      userId,
      riskContext: NEUTRAL_CTX,
      modeOverride: 'paper',
      createLiveClient: () => fakeClient,
    });
    expect(paperRes.executed).toBe(true);
    expect(paperRes.detail).toMatch(/Paper-Order ausgeführt/);
    expect(fakeClient.open).toHaveLength(0); // keine einzige echte Order an der Börse!
    const [paperPos] = await db.select().from(positions).where(eq(positions.id, paperRes.positionId!));
    expect(paperPos!.mode).toBe('paper');
    expect(paperPos!.venue).toBe('paper-internal');
    await closePositionNow(db, basePaperVenue, paperPos!.id, 'agent');

    // 5. closePositionNow auf einer Live-Position platziert echte reduceOnly-Market-Order + storniert Trigger
    const liveSig2 = await createConfirmedSignal();
    const liveRes2 = await executeConfirmedSignal(db, basePaperVenue, {
      signalId: liveSig2.id,
      userId,
      riskContext: NEUTRAL_CTX,
      createLiveClient: () => fakeClient,
    });
    expect(liveRes2.executed).toBe(true);
    expect(fakeClient.open).toHaveLength(4); // SL + 3 TPs an der Börse offen

    fakeClient.livePositions = [
      { symbol: 'ETH/USDT:USDT', side: 'long', contracts: 0.5, contractSize: 1, entryPrice: 2000 },
    ];
    const recAll = await reconcileAllVenues(db, basePaperVenue, { createLiveClient: () => fakeClient });
    expect(recAll.ok).toBe(true);

    const closedNow = await closePositionNow(db, basePaperVenue, liveRes2.positionId!, 'agent', {
      createLiveClient: () => fakeClient,
    });
    expect(closedNow.closed).toBe(true);
    expect(fakeClient.open).toHaveLength(0); // alle Trigger-Orders an der Börse storniert
  });
});
