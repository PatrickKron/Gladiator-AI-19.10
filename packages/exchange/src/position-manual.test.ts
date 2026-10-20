/**
 * Manuelles Positions-Management im Agenten-Konto (Mensch im Loop) gegen die
 * ECHTE DB (Server-CI; lokal skip): Schließen über eine echte Gegen-Order an
 * der aktiven Venue (nicht nur DB-Buchung — sonst bliebe eine Testnet-Position
 * offen), SL/TP ändern per Storno + Neu-Order, Stop-Weitung nur bestätigt.
 * Venue = deterministisches Test-Double (nur in Tests erlaubt).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import type { TradingVenue, VenueOrderRequest, VenueOrderResult } from './venue.js';
import { closePositionManually, executeConfirmedSignal, monitorOpenPositions, updateProtection } from './executor.js';

const { signals, strategies, strategyVersions, users } = schema;
const hasDb = Boolean(process.env.DATABASE_URL);
const SYMBOL = `MANUAL${process.pid}/USDT`;

class TestVenue implements TradingVenue {
  readonly id = 'paper-internal';
  readonly kind = 'paper' as const;
  price = 100;
  placed: VenueOrderRequest[] = [];
  canceled: string[] = [];
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
  async cancelOrder(_symbol: string, exchangeOrderId: string) {
    this.canceled.push(exchangeOrderId);
  }
  async fetchPositions() {
    return [];
  }
  async fetchOpenOrders() {
    return [];
  }
}

describe.skipIf(!hasDb)('Agenten-Konto: Position schließen & SL/TP ändern (echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  let otherUserId: string;
  let strategyId: string;
  let versionId: string;
  const RUN = `${process.pid}-${Date.now()}`;
  const NEUTRAL_CTX = { noTrade: null, vix: null };

  /** Öffnet eine Long-Position @100 (SL 90, TPs 110/120/130); qty wächst leicht mit dem Konto. */
  async function openPosition(venue: TestVenue): Promise<{ positionId: string; qty: number }> {
    venue.price = 100;
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
    const res = await executeConfirmedSignal(db, venue, { signalId: sig!.id, userId, riskContext: NEUTRAL_CTX });
    expect(res.executed, res.detail).toBe(true);
    return { positionId: res.positionId!, qty: res.qty! };
  }

  async function lastTrade(): Promise<{ gross: number; exit: number }> {
    const r = await db.execute(
      sql`SELECT gross_pnl::float AS gross, exit_price::float AS exit FROM executed_trades WHERE user_id = ${userId} ORDER BY exit_ts DESC LIMIT 1`,
    );
    return r.rows[0] as { gross: number; exit: number };
  }

  async function openProt(): Promise<{ id: string; type: string; price: number; qty: number }[]> {
    const r = await db.execute(
      sql`SELECT id, type, price::float AS price, qty::float AS qty FROM orders
          WHERE user_id = ${userId} AND status = 'open' AND type IN ('stop_market','take_profit_market') ORDER BY price`,
    );
    return r.rows as { id: string; type: string; price: number; qty: number }[];
  }

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [u] = await db.insert(users).values({ email: `manual-test-${RUN}@test.invalid` }).returning();
    userId = u!.id;
    const [o] = await db.insert(users).values({ email: `manual-other-${RUN}@test.invalid` }).returning();
    otherUserId = o!.id;
    const [s] = await db.insert(strategies).values({ slug: `manual-test-${RUN}`, name: 'Manual Test', kind: 'builtin' }).returning();
    strategyId = s!.id;
    const [v] = await db.insert(strategyVersions).values({ strategyId, version: 1, params: {}, status: 'paper' }).returning();
    versionId = v!.id;
  });

  afterAll(async () => {
    for (const id of [userId, otherUserId]) {
      await db.execute(sql`DELETE FROM study_trades WHERE executed_trade_id IN (SELECT id FROM executed_trades WHERE user_id = ${id})`);
      await db.execute(sql`DELETE FROM executed_trades WHERE user_id = ${id}`);
      await db.execute(sql`DELETE FROM positions WHERE user_id = ${id}`);
      await db.execute(sql`DELETE FROM orders WHERE user_id = ${id}`);
      await db.execute(sql`DELETE FROM audit_log WHERE user_id = ${id}`);
    }
    await db.execute(sql`DELETE FROM signals WHERE strategy_id = ${strategyId}`);
    await db.execute(sql`DELETE FROM strategies WHERE id = ${strategyId}`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${userId}, ${otherUserId})`);
    await pool.end();
  });

  it('Schließen: echte Gegen-Order an der Venue, Netto-Trade gebucht, Schutz-Orders storniert', async () => {
    const venue = new TestVenue();
    const { positionId, qty } = await openPosition(venue);
    venue.placed = [];
    venue.price = 105;

    const res = await closePositionManually(db, venue, userId, positionId);
    expect(res).toMatchObject({ closed: true, exitPrice: 105 });

    const market = venue.placed.find((o) => o.type === 'market');
    expect(market).toMatchObject({ side: 'sell', reduceOnly: true, symbol: SYMBOL });
    expect(market!.qty).toBeCloseTo(qty, 6);
    expect(venue.canceled).toHaveLength(4); // SL + 3 TPs auch an der Venue storniert

    expect((await lastTrade()).gross).toBeCloseTo(qty * 5, 6);
    expect(await openProt()).toHaveLength(0);
    const pos = await db.execute(sql`SELECT count(*)::int AS n FROM positions WHERE id = ${positionId}`);
    expect(pos.rows[0]!.n).toBe(0);
    const audit = await db.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = ${positionId} AND action = 'position.close.manual'`);
    expect(audit.rows[0]!.n).toBe(1);
  });

  it('Schließen nach TP1: nur die Restmenge wird verkauft, PnL aus TP1 + Rest', async () => {
    const venue = new TestVenue();
    const { positionId, qty } = await openPosition(venue);
    venue.price = 111; // TP1 (50 %) füllt
    await monitorOpenPositions(db, venue);
    venue.placed = [];
    venue.price = 115;

    const res = await closePositionManually(db, venue, userId, positionId);
    expect(res.closed).toBe(true);
    expect(venue.placed.find((o) => o.type === 'market')!.qty).toBeCloseTo(qty / 2, 6);
    // ½ × (110 − 100) + ½ × (115 − 100) je Einheit = 12,5 × qty
    expect((await lastTrade()).gross).toBeCloseTo(qty * 12.5, 6);
  });

  it('fremde oder unbekannte Position → not_found, nichts platziert', async () => {
    const venue = new TestVenue();
    const { positionId } = await openPosition(venue);
    venue.placed = [];
    expect(await closePositionManually(db, venue, otherUserId, positionId)).toMatchObject({ closed: false, reason: 'not_found' });
    expect(await updateProtection(db, venue, otherUserId, positionId, { stopLoss: 95 })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(venue.placed).toHaveLength(0);
    await closePositionManually(db, venue, userId, positionId); // aufräumen
  });

  it('SL enger setzen: alte Order storniert, neue mit gleicher Menge — der Monitor nutzt den neuen Stop', async () => {
    const venue = new TestVenue();
    const { positionId, qty } = await openPosition(venue);
    venue.price = 105;

    expect(await updateProtection(db, venue, userId, positionId, { stopLoss: 101 })).toEqual({ ok: true });
    const sl = (await openProt()).filter((o) => o.type === 'stop_market');
    expect(sl).toHaveLength(1);
    expect(sl[0]).toMatchObject({ price: 101 });
    expect(sl[0]!.qty).toBeCloseTo(qty, 6);
    expect(venue.canceled).toHaveLength(1);

    venue.price = 100.5; // unter neuem Stop → Monitor schließt
    await monitorOpenPositions(db, venue);
    expect((await lastTrade()).exit).toBeCloseTo(101, 6);
  });

  it('SL weiter weg: nur mit ausdrücklicher Bestätigung; falsche Seite wird abgelehnt', async () => {
    const venue = new TestVenue();
    const { positionId } = await openPosition(venue);
    venue.price = 100;

    expect(await updateProtection(db, venue, userId, positionId, { stopLoss: 85 })).toEqual({ ok: false, reason: 'widen_requires_confirm' });
    expect(await updateProtection(db, venue, userId, positionId, { stopLoss: 100.5 })).toEqual({ ok: false, reason: 'invalid_stop' });
    expect(await updateProtection(db, venue, userId, positionId, { stopLoss: 85, confirmWiden: true })).toEqual({ ok: true });
    expect((await openProt()).find((o) => o.type === 'stop_market')).toMatchObject({ price: 85 });
    const audit = await db.execute(sql`SELECT details FROM audit_log WHERE entity_id = ${positionId} AND action = 'position.protection.updated'`);
    expect(audit.rows[0]!.details).toMatchObject({ stopLoss: { from: 90, to: 85, widened: true } });
    await closePositionManually(db, venue, userId, positionId);
  });

  it('TP ändern: Preis je Order, falsche Seite abgelehnt', async () => {
    const venue = new TestVenue();
    const { positionId } = await openPosition(venue);
    venue.price = 100;
    const tp1 = (await openProt()).find((o) => o.type === 'take_profit_market' && o.price === 110)!;

    expect(await updateProtection(db, venue, userId, positionId, { takeProfits: [{ orderId: tp1.id, price: 99 }] })).toEqual({
      ok: false,
      reason: 'invalid_take_profit',
    });
    expect(await updateProtection(db, venue, userId, positionId, { takeProfits: [{ orderId: tp1.id, price: 112 }] })).toEqual({ ok: true });
    const tps = (await openProt()).filter((o) => o.type === 'take_profit_market').map((o) => o.price);
    expect(tps).toEqual([112, 120, 130]);
    await closePositionManually(db, venue, userId, positionId);
  });

  it('Teil schließen (50 %): halbe Menge an der Venue, Schutz-Orders auf die Restmenge angepasst, Rest bleibt offen', async () => {
    const venue = new TestVenue();
    const { positionId, qty } = await openPosition(venue);
    venue.placed = [];
    venue.price = 105;

    const part = await closePositionManually(db, venue, userId, positionId, null, { qty: qty / 2 });
    expect(part).toMatchObject({ closed: false, partial: true, exitPrice: 105 });
    expect(venue.placed.find((o) => o.type === 'market')!.qty).toBeCloseTo(qty / 2, 6);

    const prot = await openProt();
    const sl = prot.find((o) => o.type === 'stop_market')!;
    expect(sl.qty).toBeCloseTo(qty / 2, 6); // Stop deckt genau die Restmenge
    const tpSum = prot.filter((o) => o.type === 'take_profit_market').reduce((n, o) => n + o.qty, 0);
    expect(tpSum).toBeCloseTo(qty / 2, 6); // TPs proportional auf die Restmenge (Verhältnis 50/30/20 bleibt)
    expect(prot.filter((o) => o.type === 'take_profit_market').map((o) => o.qty / (qty / 2))).toEqual([
      expect.closeTo(0.5, 6),
      expect.closeTo(0.3, 6),
      expect.closeTo(0.2, 6),
    ]);

    venue.price = 110;
    const rest = await closePositionManually(db, venue, userId, positionId);
    expect(rest).toMatchObject({ closed: true });
    // ½ × 5 + ½ × 10 je Einheit = 7,5 × qty
    expect((await lastTrade()).gross).toBeCloseTo(qty * 7.5, 6);
  });

  it('Teilmenge ≥ Restmenge → normaler Vollschluss', async () => {
    const venue = new TestVenue();
    const { positionId, qty } = await openPosition(venue);
    venue.price = 101;
    expect(await closePositionManually(db, venue, userId, positionId, null, { qty: qty * 2 })).toMatchObject({ closed: true });
  });

  it('Trailing-Stop: sofort enger, folgt neuen Hochs, nie zurück — der Monitor schließt am nachgezogenen Stop', async () => {
    const venue = new TestVenue();
    const { positionId } = await openPosition(venue);
    venue.price = 100;

    expect(await updateProtection(db, venue, userId, positionId, { trailPct: 0 })).toEqual({ ok: false, reason: 'invalid_trail' });
    expect(await updateProtection(db, venue, userId, positionId, { trailPct: 5 })).toEqual({ ok: true });
    expect((await openProt()).find((o) => o.type === 'stop_market')!.price).toBeCloseTo(95, 6); // 100 × 0,95 > 90

    venue.price = 108; // TP1 bei 110 noch nicht erreicht
    await monitorOpenPositions(db, venue);
    expect((await openProt()).find((o) => o.type === 'stop_market')!.price).toBeCloseTo(102.6, 6);

    venue.price = 104; // fällt, aber über dem Stop → Stop bleibt
    await monitorOpenPositions(db, venue);
    expect((await openProt()).find((o) => o.type === 'stop_market')!.price).toBeCloseTo(102.6, 6);

    venue.price = 102; // unter Stop → Schluss am Stop
    await monitorOpenPositions(db, venue);
    expect((await lastTrade()).exit).toBeCloseTo(102.6, 6);
  });

  it('Trailing-Stop abschalten: Stop bleibt, wo er ist; Monitor zieht nicht mehr nach', async () => {
    const venue = new TestVenue();
    const { positionId } = await openPosition(venue);
    venue.price = 100;
    await updateProtection(db, venue, userId, positionId, { trailPct: 5 });
    expect(await updateProtection(db, venue, userId, positionId, { trailPct: null })).toEqual({ ok: true });
    venue.price = 108;
    await monitorOpenPositions(db, venue);
    expect((await openProt()).find((o) => o.type === 'stop_market')!.price).toBeCloseTo(95, 6);
    await closePositionManually(db, venue, userId, positionId);
  });

  it('Signal einer Strategie mit Trailing-Stop: die Position übernimmt den Trail (Backtest = Live)', async () => {
    // Diese Datei eröffnet in kurzer Zeit viele Positionen — die echten Orders der
    // Vorgänger-Tests zeitlich zurücksetzen, sonst greift korrekt SAFE-008 (max. 10 Orders/min).
    await db.execute(sql`UPDATE orders SET created_at = created_at - interval '5 minutes' WHERE user_id = ${userId}`);
    const venue = new TestVenue();
    venue.price = 100;
    const [sig] = await db
      .insert(signals)
      .values({
        source: 'instruction',
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
        takeProfits: ['300'],
        trailPct: '5',
        leverageSuggested: '1',
        score: '6',
        riskClass: 'medium',
        confluence: ['dsl:test'],
        session: 'london',
        emaRegime: 'above',
        marketPhase: 'bull',
        status: 'confirmed',
      })
      .returning();
    const res = await executeConfirmedSignal(db, venue, { signalId: sig!.id, userId, riskContext: NEUTRAL_CTX });
    expect(res.executed, res.detail).toBe(true);
    const pos = await db.execute(sql`SELECT trail_pct::float AS pct, trail_peak::float AS peak FROM positions WHERE id = ${res.positionId!}`);
    expect(pos.rows[0]).toEqual({ pct: 5, peak: 100 });

    venue.price = 120; // Monitor zieht nach: 120 × 0,95 = 114
    await monitorOpenPositions(db, venue);
    expect((await openProt()).find((o) => o.type === 'stop_market')!.price).toBeCloseTo(114, 6);
    await closePositionManually(db, venue, userId, res.positionId!);
  });
});

