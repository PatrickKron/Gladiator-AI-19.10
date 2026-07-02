/**
 * DB-Integrationstests — laufen gegen die echte TimescaleDB (DATABASE_URL).
 * Auf dem Server via scripts/ci.sh; lokal ohne DATABASE_URL werden sie übersprungen
 * (dann ist die Server-CI maßgeblich, nicht der lokale Lauf).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import type pg from 'pg';
import {
  assets,
  auditLog,
  executedTrades,
  magazineArticles,
  packages,
  signalReviews,
  signals,
  strategies,
  users,
} from './schema/index.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) {
  console.warn('[schema.test] DATABASE_URL nicht gesetzt — DB-Tests übersprungen (nur auf dem Server maßgeblich).');
}

describe.skipIf(!hasDb)('DB-Schema (TimescaleDB)', () => {
  let db: Db;
  let pool: pg.Pool;
  const testEmail = `schema-test-${process.pid}-${Date.now()}@test.invalid`;

  beforeAll(() => {
    ({ db, pool } = createDb());
  });

  afterAll(async () => {
    if (db) {
      await db.execute(sql`DELETE FROM users WHERE email = ${testEmail}`);
      await pool.end();
    }
  });

  it('ohlcv, funding_rates, open_interest sind Timescale-Hypertables', async () => {
    const res = await db.execute(
      sql`SELECT hypertable_name FROM timescaledb_information.hypertables ORDER BY hypertable_name`,
    );
    const names = res.rows.map((r) => r.hypertable_name);
    expect(names).toContain('ohlcv');
    expect(names).toContain('funding_rates');
    expect(names).toContain('open_interest');
  });

  it('Roundtrip: User → Strategie → kanonisches Signal → Agenten-Review', async () => {
    const [user] = await db.insert(users).values({ email: testEmail, role: 'user' }).returning();
    expect(user).toBeDefined();

    const [strategy] = await db
      .insert(strategies)
      .values({ slug: `smc-core-test-${Date.now()}`, name: 'SMC Core (Test)', kind: 'builtin' })
      .returning();
    expect(strategy).toBeDefined();

    const [signal] = await db
      .insert(signals)
      .values({
        source: 'engine',
        strategyId: strategy!.id,
        symbol: 'BTC/USDT',
        assetClass: 'crypto',
        venueType: 'cex',
        direction: 'long',
        setupType: 'swing',
        entry: '100000',
        stopLoss: '98500',
        takeProfits: ['101500', '103000'],
        leverageSuggested: '3',
        score: '8.2',
        riskClass: 'low',
        confluence: ['BOS', 'Retest@EMA50'],
        session: 'london',
        tier: 'pro',
      })
      .returning();
    expect(signal).toBeDefined();
    expect(signal!.takeProfits).toHaveLength(2);
    expect(signal!.confluence).toContain('BOS');
    expect(signal!.status).toBe('new');

    const [review] = await db
      .insert(signalReviews)
      .values({
        signalId: signal!.id,
        agent: 'devil',
        vote: 'caution',
        confidence: '0.6',
        reason: 'Testlauf — Gegen-Liquidität nahe Entry.',
      })
      .returning();
    expect(review!.vote).toBe('caution');

    // Aufräumen in FK-Reihenfolge: Signal (cascadet Reviews) → Strategie
    await db.execute(sql`DELETE FROM signals WHERE id = ${signal!.id}`);
    await db.execute(sql`DELETE FROM strategies WHERE id = ${strategy!.id}`);
  });

  it('executed_trades trägt Pflicht-Kostenfelder mit Default 0 (netto-Rechnung möglich)', async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `trade-${testEmail}`, role: 'user' })
      .returning();
    const [trade] = await db
      .insert(executedTrades)
      .values({
        userId: user!.id,
        venue: 'binance-testnet',
        symbol: 'BTC/USDT',
        direction: 'long',
        entryTs: new Date(),
        entryPrice: '100000',
        qty: '0.01',
        mode: 'paper',
      })
      .returning();
    expect(trade!.makerTakerFee).toBe('0');
    expect(trade!.slippage).toBe('0');
    expect(trade!.fundingPaid).toBe('0');
    // Aufräumen in FK-Reihenfolge: Trade → User
    await db.execute(sql`DELETE FROM executed_trades WHERE id = ${trade!.id}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${user!.id}`);
  });

  it('ungültige Enum-Werte werden von Postgres abgelehnt', async () => {
    await expect(
      db.execute(sql`INSERT INTO signals (source, strategy_id, symbol, asset_class, venue_type, direction, setup_type, entry, stop_loss, take_profits, score, risk_class, session, tier)
        VALUES ('random', gen_random_uuid(), 'X', 'crypto', 'cex', 'long', 'swing', 1, 1, '{1}', 5, 'low', 'london', 'free')`),
    ).rejects.toThrow();
  });

  it('audit_log nimmt Einträge an (append-only per Konvention)', async () => {
    const res = await db
      .insert(auditLog)
      .values({ actor: 'system', action: 'schema.test', details: { note: 'Phase 0a Abnahme' } })
      .returning();
    expect(res[0]!.id).toBeDefined();
  });
});

describe.skipIf(!hasDb || process.env.EXPECT_SEED !== '1')('Seed (echte v1-Daten)', () => {
  let db: Db;
  let pool: pg.Pool;

  beforeAll(() => {
    ({ db, pool } = createDb());
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('enthält die portierten v1-Bestände (35 Pakete, 221 Assets, 45 Artikel, Admin-User)', async () => {
    const [pkgCount] = await db.select({ n: sql<number>`count(*)::int` }).from(packages);
    const [assetCount] = await db.select({ n: sql<number>`count(*)::int` }).from(assets);
    const [articleCount] = await db.select({ n: sql<number>`count(*)::int` }).from(magazineArticles);
    const [adminCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(sql`role = 'admin' AND legacy_v1_id IS NOT NULL`);

    expect(pkgCount!.n).toBeGreaterThanOrEqual(35);
    expect(assetCount!.n).toBeGreaterThanOrEqual(221);
    expect(articleCount!.n).toBeGreaterThanOrEqual(45);
    expect(adminCount!.n).toBeGreaterThanOrEqual(1);
  });

  it('Asset→Paket-Fremdschlüssel sind intakt', async () => {
    const orphans = await db.execute(
      sql`SELECT count(*)::int AS n FROM assets a LEFT JOIN packages p ON p.id = a.package_id WHERE p.id IS NULL`,
    );
    expect(orphans.rows[0]!.n).toBe(0);
  });
});
