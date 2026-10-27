/**
 * Reentry-/Leverage-Upgrade-/Auto-Kill-Monitor (05_ §9) gegen die ECHTE DB
 * (Server-CI; lokal ohne DATABASE_URL übersprungen). Kerzen/Preise sind hier
 * Test-Fixtures (Mock nur in Tests); der Lauf ist per scope auf die eigenen
 * Test-Strategien/-User begrenzt — echte Signale werden nie angefasst.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import { executeConfirmedSignal, monitorOpenPositions, type TradingVenue, type VenueOrderRequest, type VenueOrderResult } from '@gladiator/exchange';
import { deriveLifecyclePlans } from '@gladiator/strategy-engine';
import type pg from 'pg';
import { runSignalLifecycle } from './signal-lifecycle.js';

const { signals, strategies, strategyVersions, users, ohlcv } = schema;
const hasDb = Boolean(process.env.DATABASE_URL);
const RUN = `${process.pid}-${Date.now()}`;
const SYM_KILL = `LCK${process.pid}/USDT`;
const SYM_RE = `LCR${process.pid}/USDT`;
const SYM_LEV = `LCL${process.pid}/USDT`;
/** A2: Yahoo-Symbole (Schlusskurs statt Live-Preis) — eindeutig je Lauf. */
const SYM_YH = `LCY${process.pid}.TEST`;
const SYM_YH_OLD = `LCO${process.pid}.TEST`;
const SMC_TAGS = ['Trend (EMA)', 'Struktur-Bruch', 'Retest@EMA/Level', 'RSI-Band', 'Volumen', 'Session aktiv', 'RR ≥ 2', 'Higher-TF bestätigt'];
const NEUTRAL_CTX = { noTrade: null, vix: null };

class TestVenue implements TradingVenue {
  readonly id = 'paper-internal';
  readonly kind = 'paper' as const;
  prices = new Map<string, number>();
  placed: VenueOrderRequest[] = [];
  async validate() {
    return { ok: true, detail: 'test' };
  }
  async marketRules() {
    return { tickSize: 0.01, lotSize: 0.000001, minNotional: 5 };
  }
  async markPrice(symbol: string) {
    const p = this.prices.get(symbol);
    if (p === undefined) throw new Error(`fremdes Test-Symbol ${symbol}`);
    return p;
  }
  async placeOrder(req: VenueOrderRequest): Promise<VenueOrderResult> {
    this.placed.push(req);
    const price = this.prices.get(req.symbol)!;
    return {
      clientOrderId: req.clientOrderId,
      exchangeOrderId: `t-${req.clientOrderId}`,
      status: req.type === 'market' ? 'filled' : 'open',
      fillPrice: req.type === 'market' ? price : undefined,
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

describe.skipIf(!hasDb)('Signal-Lifecycle: Auto-Kill, Reentry, Leverage-Upgrade (echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;
  let userId: string;
  let strategyId: string;
  let versionId: string;
  const venue = new TestVenue();
  const run = () =>
    runSignalLifecycle(db, {
      priceOf: (s) => venue.markPrice(s),
      scope: { strategyIds: [strategyId], userIds: [userId] },
    });

  async function insertSignal(v: {
    symbol: string;
    entry: number;
    stopLoss: number;
    takeProfits: number[];
    score: number;
    confluence: string[];
    status: 'new' | 'confirmed';
    createdAt?: Date;
    venue?: 'binance' | 'yahoo';
  }) {
    const plans = deriveLifecyclePlans({ direction: 'long', setupType: 'swing', entry: v.entry, stopLoss: v.stopLoss });
    const [sig] = await db
      .insert(signals)
      .values({
        source: 'engine',
        strategyId,
        strategyVersionId: versionId,
        symbol: v.symbol,
        venue: v.venue ?? 'binance',
        timeframe: '1h',
        assetClass: v.venue === 'yahoo' ? 'stock' : 'crypto',
        venueType: 'cex',
        direction: 'long',
        setupType: 'swing',
        entry: String(v.entry),
        stopLoss: String(v.stopLoss),
        takeProfits: v.takeProfits.map(String),
        leverageSuggested: '1',
        score: String(v.score),
        riskClass: v.score >= 8 ? 'low' : 'medium',
        confluence: v.confluence,
        session: 'london',
        reentry: plans.reentry,
        leverageUpgrade: plans.leverageUpgrade,
        emaRegime: 'above',
        marketPhase: 'bull',
        status: v.status,
        ...(v.createdAt ? { createdAt: v.createdAt } : {}),
      })
      .returning();
    return sig!;
  }

  async function auditCount(action: string, entityId: string): Promise<number> {
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE action = ${action} AND entity_id = ${entityId}`);
    return (r.rows[0] as { n: number }).n;
  }

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [u] = await db.insert(users).values({ email: `lifecycle-${RUN}@test.invalid` }).returning();
    userId = u!.id;
    const [s] = await db.insert(strategies).values({ slug: `lifecycle-${RUN}`, name: 'Lifecycle Test', kind: 'builtin' }).returning();
    strategyId = s!.id;
    const [v] = await db.insert(strategyVersions).values({ strategyId, version: 1, params: {}, status: 'paper' }).returning();
    versionId = v!.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM study_trades WHERE executed_trade_id IN (SELECT id FROM executed_trades WHERE user_id = ${userId})`);
    await db.execute(sql`DELETE FROM executed_trades WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM positions WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM orders WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM audit_log WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM audit_log WHERE entity_type = 'signal' AND entity_id IN (SELECT id::text FROM signals WHERE strategy_id = ${strategyId})`);
    await db.execute(sql`DELETE FROM signals WHERE strategy_id = ${strategyId}`);
    await db.execute(sql`DELETE FROM strategy_versions WHERE strategy_id = ${strategyId}`);
    await db.execute(sql`DELETE FROM strategies WHERE id = ${strategyId}`);
    await db.execute(sql`DELETE FROM ohlcv WHERE symbol IN (${SYM_KILL}, ${SYM_RE}, ${SYM_LEV}, ${SYM_YH}, ${SYM_YH_OLD})`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await pool.end();
  });

  it('Auto-Kill: Stop vor Entry gerissen → expired + Audit mit Grund, idempotent', async () => {
    const createdAt = new Date(Date.now() - 3 * 3_600_000);
    const sig = await insertSignal({ symbol: SYM_KILL, entry: 100, stopLoss: 90, takeProfits: [110, 120, 130], score: 9.5, confluence: SMC_TAGS, status: 'new', createdAt });
    // Echte Kerze NACH der Erstellung mit Tief unter dem Stop (Fixture)
    const ts = new Date(Math.floor((Date.now() - 3_600_000) / 3_600_000) * 3_600_000);
    await db.insert(ohlcv).values({ venue: 'binance', symbol: SYM_KILL, timeframe: '1h', ts, open: '95', high: '96', low: '89', close: '94', volume: '10' });
    venue.prices.set(SYM_KILL, 94);

    const first = await run();
    expect(first.killed).toBe(1);
    const row = await db.execute(sql`SELECT status FROM signals WHERE id = ${sig.id}`);
    expect((row.rows[0] as { status: string }).status).toBe('expired');
    const audit = await db.execute(sql`SELECT actor, details FROM audit_log WHERE action = 'signal.auto_killed' AND entity_id = ${sig.id}`);
    expect(audit.rows).toHaveLength(1);
    expect((audit.rows[0] as { details: { reason: string } }).details.reason).toBe('stop_breached');

    const second = await run();
    expect(second.killed).toBe(0);
    expect(await auditCount('signal.auto_killed', sig.id)).toBe(1);
  });

  it('A2 Yahoo-Signal: Kerzen und Preis aus der Quelle (frischer Schlusskurs), nie der Live-Preis-Venue', async () => {
    const createdAt = new Date(Date.now() - 3 * 3_600_000);
    const sig = await insertSignal({ symbol: SYM_YH, venue: 'yahoo', entry: 100, stopLoss: 90, takeProfits: [110, 120, 130], score: 9.5, confluence: SMC_TAGS, status: 'new', createdAt });
    // Abgeschlossene Yahoo-1h-Kerze NACH der Erstellung mit Tief/Schluss unter dem Stop (Fixture).
    const ts = new Date(Math.floor((Date.now() - 2 * 3_600_000) / 3_600_000) * 3_600_000);
    await db.insert(ohlcv).values({ venue: 'yahoo', symbol: SYM_YH, timeframe: '1h', ts, open: '95', high: '96', low: '88', close: '89', volume: '10' });
    // Gleiches Symbol auf Binance-Seite unbekannt: TestVenue würde werfen — darf nicht gefragt werden.
    expect(venue.prices.has(SYM_YH)).toBe(false);

    const res = await run();
    expect(res.killed).toBeGreaterThanOrEqual(1);
    const row = await db.execute(sql`SELECT status FROM signals WHERE id = ${sig.id}`);
    expect((row.rows[0] as { status: string }).status).toBe('expired');
    const audit = await db.execute(sql`SELECT details FROM audit_log WHERE action = 'signal.auto_killed' AND entity_id = ${sig.id}`);
    expect((audit.rows[0] as { details: { price: number | null } }).details.price).toBe(89);
  });

  it('A2 Yahoo-Signal mit veralteten Kerzen: kein Schlusskurs als Preis, Signal bleibt offen', async () => {
    const createdAt = new Date(Date.now() - 3 * 3_600_000);
    const sig = await insertSignal({ symbol: SYM_YH_OLD, venue: 'yahoo', entry: 100, stopLoss: 90, takeProfits: [110, 120, 130], score: 9.5, confluence: SMC_TAGS, status: 'new', createdAt });
    await db.insert(ohlcv).values({ venue: 'yahoo', symbol: SYM_YH_OLD, timeframe: '1h', ts: new Date(Date.now() - 30 * 86_400_000), open: '80', high: '81', low: '79', close: '80', volume: '10' });

    await run();
    const row = await db.execute(sql`SELECT status FROM signals WHERE id = ${sig.id}`);
    expect((row.rows[0] as { status: string }).status).toBe('new');
  });

  it('Auto-Kill: Score fällt unter 6,5 (DSL-RR zum Live-Preis) → expired; gesundes Signal bleibt', async () => {
    const weak = await insertSignal({ symbol: SYM_KILL, entry: 100, stopLoss: 98, takeProfits: [104], score: 6, confluence: ['score:rr-basiert'], status: 'new' });
    const healthy = await insertSignal({ symbol: SYM_KILL, entry: 100, stopLoss: 80, takeProfits: [160], score: 9, confluence: ['score:rr-basiert'], status: 'new' });
    venue.prices.set(SYM_KILL, 103); // weak: RR1 = 1/5 → 0,6 · healthy: RR1 = 57/23 → 7,4
    await run();
    const rows = await db.execute(sql`SELECT id, status FROM signals WHERE id IN (${weak.id}, ${healthy.id})`);
    const by = new Map((rows.rows as { id: string; status: string }[]).map((r) => [r.id, r.status]));
    expect(by.get(weak.id)).toBe('expired');
    expect(by.get(healthy.id)).toBe('new');
    const a = await db.execute(sql`SELECT details FROM audit_log WHERE action = 'signal.auto_killed' AND entity_id = ${weak.id}`);
    expect((a.rows[0] as { details: { reason: string } }).details.reason).toBe('score_below_threshold');
  });

  it('Reentry nach SL: neues Signal (status new) im Pullback-Fenster, verknüpft, nie ausgeführt, idempotent', async () => {
    venue.prices.set(SYM_RE, 100);
    const sig = await insertSignal({ symbol: SYM_RE, entry: 100, stopLoss: 90, takeProfits: [110, 120, 130], score: 9.5, confluence: SMC_TAGS, status: 'confirmed' });
    const exec = await executeConfirmedSignal(db, venue, { signalId: sig.id, userId, riskContext: NEUTRAL_CTX });
    expect(exec.executed, exec.detail).toBe(true);

    venue.prices.set(SYM_RE, 89); // SL füllt → Position zu (reason 'sl')
    await monitorOpenPositions(db, venue);
    const open = await db.execute(sql`SELECT count(*)::int AS n FROM positions WHERE user_id = ${userId} AND symbol = ${SYM_RE}`);
    expect((open.rows[0] as { n: number }).n).toBe(0);

    venue.prices.set(SYM_RE, 99); // über der Zone (97,5–98,5) → noch nichts
    expect((await run()).reentries).toBe(0);

    venue.placed = [];
    venue.prices.set(SYM_RE, 98);
    const res = await run();
    expect(res.reentries).toBe(1);
    expect(venue.placed).toHaveLength(0); // Mensch im Loop: KEINE Order

    const re = await db.execute(sql`
      SELECT id, status, source, entry::float AS entry, stop_loss::float AS sl, reentry, confluence
      FROM signals WHERE reentry->>'parentSignalId' = ${sig.id}`);
    expect(re.rows).toHaveLength(1);
    const row = re.rows[0] as { id: string; status: string; source: string; entry: number; sl: number; reentry: { generation: number; rootSignalId: string; enabled: boolean }; confluence: string[] };
    expect(row).toMatchObject({ status: 'new', source: 'engine', entry: 98, sl: 90 });
    expect(row.reentry).toMatchObject({ generation: 1, rootSignalId: sig.id, enabled: false });
    expect(row.confluence).toContain('Reentry');
    expect(await auditCount('signal.reentry_created', row.id)).toBe(1);

    // Zweiter Tick: kein Duplikat
    expect((await run()).reentries).toBe(0);
    const again = await db.execute(sql`SELECT count(*)::int AS n FROM signals WHERE reentry->>'parentSignalId' = ${sig.id}`);
    expect((again.rows[0] as { n: number }).n).toBe(1);
  });

  it('Leverage-Upgrade: erst nach Bestätigung (TP1 → Break-Even) ein sichtbarer Vorschlag — Hebel bleibt unverändert', async () => {
    venue.prices.set(SYM_LEV, 100);
    const sig = await insertSignal({ symbol: SYM_LEV, entry: 100, stopLoss: 90, takeProfits: [110, 120, 130], score: 9.5, confluence: SMC_TAGS, status: 'confirmed' });
    const exec = await executeConfirmedSignal(db, venue, { signalId: sig.id, userId, riskContext: NEUTRAL_CTX });
    expect(exec.executed, exec.detail).toBe(true);

    venue.prices.set(SYM_LEV, 106); // +6 % ≥ Trigger 5 %, aber Stop noch bei 90 → kein Vorschlag
    expect((await run()).upgrades).toBe(0);

    venue.prices.set(SYM_LEV, 111); // TP1 füllt → Stop auf Break-Even
    await monitorOpenPositions(db, venue);
    venue.placed = [];
    const res = await run();
    expect(res.upgrades).toBe(1);
    expect(venue.placed).toHaveLength(0);

    const s = await db.execute(sql`SELECT leverage_upgrade FROM signals WHERE id = ${sig.id}`);
    const lu = (s.rows[0] as { leverage_upgrade: { suggestion: { suggested: number; from: number; positionId: string } } }).leverage_upgrade;
    expect(lu.suggestion).toMatchObject({ suggested: 1.5, from: 1, positionId: exec.positionId });
    const pos = await db.execute(sql`SELECT leverage::float AS lev FROM positions WHERE id = ${exec.positionId!}`);
    expect((pos.rows[0] as { lev: number }).lev).toBe(1); // NIE automatisch geändert
    expect(await auditCount('signal.leverage_upgrade_suggested', sig.id)).toBe(1);

    expect((await run()).upgrades).toBe(0); // idempotent
    expect(await auditCount('signal.leverage_upgrade_suggested', sig.id)).toBe(1);
  });
});
