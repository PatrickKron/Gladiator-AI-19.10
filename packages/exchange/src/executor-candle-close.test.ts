/**
 * A2 Schlusskurs-Ausführung gegen die ECHTE DB (Server-CI; lokal skip): Ein bestätigtes Yahoo-
 * Signal läuft über die Risk-Engine (hartes Gate) und füllt zum letzten frischen Kerzenschluss —
 * Position/Orders mit eigener Venue-Kennung `paper-close:yahoo`, Entry als Schlusskurs-Ausführung
 * beschriftet; der PositionMonitor bewertet die Position gegen denselben Kerzenschluss. Kerzen
 * sind Test-Fixtures (eindeutiges Symbol, werden wieder gelöscht); der Monitor ist auf den
 * Test-User begrenzt — echte Positionen bewertet dieser Test nie.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import type { MarketRules, TradingVenue, VenueOrderRequest, VenueOrderResult } from './venue.js';
import { withCandleClose } from './candle-close-venue.js';
import { executeConfirmedSignal, monitorOpenPositions } from './executor.js';

const { signals, strategies, strategyVersions, users } = schema;

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) console.warn('[executor-candle-close.test] DATABASE_URL fehlt — übersprungen (Server-CI maßgeblich).');

/** Basis-Venue: darf für das Yahoo-Signal NIE angesprochen werden. */
class NeverVenue implements TradingVenue {
  readonly id = 'paper-internal';
  readonly kind = 'paper' as const;
  calls: string[] = [];
  async validate() {
    return { ok: true, detail: 'test' };
  }
  async marketRules(symbol: string): Promise<MarketRules> {
    this.calls.push(`rules:${symbol}`);
    throw new Error('Basis-Venue für Schlusskurs-Signal angesprochen');
  }
  async markPrice(symbol: string): Promise<number> {
    this.calls.push(`mark:${symbol}`);
    throw new Error('Basis-Venue für Schlusskurs-Signal angesprochen');
  }
  async placeOrder(req: VenueOrderRequest): Promise<VenueOrderResult> {
    this.calls.push(`order:${req.symbol}`);
    throw new Error('Basis-Venue für Schlusskurs-Signal angesprochen');
  }
  async cancelOrder() {}
  async fetchPositions() {
    return [];
  }
  async fetchOpenOrders() {
    return [];
  }
}

describe.skipIf(!hasDb)('Schlusskurs-Ausführung (Yahoo-Signal, echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  let signalId: string;
  const RUN = `${process.pid}-${Date.now()}`;
  const SYM = `CC${process.pid}${Date.now() % 1e6}.TEST`;
  const NEUTRAL_CTX = { noTrade: null, vix: null };
  const base = new NeverVenue();

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [u] = await db.insert(users).values({ email: `close-exec-${RUN}@test.invalid` }).returning();
    userId = u!.id;
    const [s] = await db.insert(strategies).values({ slug: `close-exec-${RUN}`, name: 'Close Exec Test', kind: 'builtin' }).returning();
    const [v] = await db.insert(strategyVersions).values({ strategyId: s!.id, version: 1, params: {}, status: 'paper' }).returning();

    // 60 abgeschlossene 1h-Kerzen bis vor einer Stunde, leicht schwankend, letzter Schluss 100.
    const hour = 3_600_000;
    const lastTs = Math.floor(Date.now() / hour) * hour - hour;
    for (let i = 59; i >= 0; i--) {
      const ts = new Date(lastTs - i * hour);
      const close = i === 0 ? 100 : 100 + (i % 2 === 0 ? 0.4 : -0.4);
      await db.execute(sql`INSERT INTO ohlcv (venue, symbol, timeframe, ts, open, high, low, close, volume)
        VALUES ('yahoo', ${SYM}, '1h', ${ts}, ${close}, ${close + 0.5}, ${close - 0.5}, ${close}, 1000)`);
    }

    const [sig] = await db
      .insert(signals)
      .values({
        source: 'engine',
        strategyId: s!.id,
        strategyVersionId: v!.id,
        symbol: SYM,
        venue: 'yahoo',
        timeframe: '1h',
        assetClass: 'stock',
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
    await db.execute(sql`DELETE FROM study_trades WHERE executed_trade_id IN (SELECT id FROM executed_trades WHERE user_id = ${userId})`);
    await db.execute(sql`DELETE FROM executed_trades WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM positions WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM orders WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM audit_log WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM signals WHERE id = ${signalId}`);
    await db.execute(sql`DELETE FROM strategies WHERE slug = ${`close-exec-${RUN}`}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await db.execute(sql`DELETE FROM ohlcv WHERE symbol = ${SYM}`);
    await pool.end();
  });

  it('ohne Schlusskurs-Weiche: ehrlicher Fehler, nichts platziert', async () => {
    await expect(executeConfirmedSignal(db, base, { signalId, userId, riskContext: NEUTRAL_CTX })).rejects.toThrow(/nicht eingerichtet/);
    expect(base.calls).toEqual([]);
  });

  it('füllt zum letzten Kerzenschluss über die Risk-Engine; Position/Orders als paper-close:yahoo', async () => {
    const venue = withCandleClose(db, base);
    const res = await executeConfirmedSignal(db, venue, { signalId, userId, riskContext: NEUTRAL_CTX });
    expect(res.verdict.allowed).toBe(true);
    expect(res.executed).toBe(true);
    expect(res.entryFill).toBe(100);
    expect(res.detail).toMatch(/Schlusskurs-Ausführung/);
    expect(base.calls).toEqual([]);

    const pos = await db.execute(sql`SELECT venue, entry_price::float AS entry FROM positions WHERE user_id = ${userId}`);
    expect(pos.rows).toEqual([{ venue: 'paper-close:yahoo', entry: 100 }]);
    const ords = await db.execute(sql`SELECT venue, type, raw FROM orders WHERE user_id = ${userId} ORDER BY created_at, type`);
    expect(ords.rows.length).toBe(5); // Entry + SL + 3 TPs
    for (const o of ords.rows as { venue: string }[]) expect(o.venue).toBe('paper-close:yahoo');
    const entry = (ords.rows as { type: string; raw: Record<string, unknown> | null }[]).find((o) => o.type === 'market');
    expect(entry?.raw).toMatchObject({ execution: 'candle_close', source: 'yahoo' });
  });

  it('Monitor: neuer Schluss unter dem Stop ⇒ SL-Fill zum Kerzenschluss, Position geschlossen', async () => {
    await db.execute(sql`INSERT INTO ohlcv (venue, symbol, timeframe, ts, open, high, low, close, volume)
      VALUES ('yahoo', ${SYM}, '15m', now() - interval '20 minutes', 95, 95, 88, 89, 500)`);
    const venue = withCandleClose(db, base);
    const tick = await monitorOpenPositions(db, venue, { userIds: [userId] });
    expect(tick.fills).toBeGreaterThanOrEqual(1);
    expect(base.calls).toEqual([]);

    const open = await db.execute(sql`SELECT 1 FROM positions WHERE user_id = ${userId}`);
    expect(open.rows).toHaveLength(0);
    const trades = await db.execute(sql`SELECT exit_price::float AS exit FROM executed_trades WHERE user_id = ${userId}`);
    expect(trades.rows).toHaveLength(1);
    // Paper-Stop füllt am Trigger oder schlechter — nie besser als der echte Schlusskurs-Verlauf erlaubt.
    expect((trades.rows[0] as { exit: number }).exit).toBeLessThanOrEqual(90);
  });
});
