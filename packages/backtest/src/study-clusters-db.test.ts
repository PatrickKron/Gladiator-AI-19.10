/**
 * VDB2-Batch + getOptimalParams gegen die ECHTE DB (Server-CI; lokal ohne
 * DATABASE_URL: skip). Die study_trades-Zeilen sind deterministische
 * Test-Fixtures unter einem eigenen Strategie-Präfix (nur in Tests erlaubt).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { getOptimalParams, recomputeStudyClusters } from './study-clusters.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const DAY = 86_400_000;

describe.skipIf(!hasDb)('VDB2-Batch (echte DB)', () => {
  let db: Db;
  let pool: pg.Pool;
  const STRAT = `vdb2-test-${process.pid}-${Date.now()}`;
  const PREFIX = `${STRAT}|BTC/USDT|swing|4h|`;
  const LONDON = `${PREFIX}london|uptrend`;
  const ASIA = `${PREFIX}asia|transition`;
  const NOW = new Date();

  function fixture(key: string, k: number, r: number, mae = 0.01) {
    const exitTs = new Date(NOW.getTime() - (70 - k) * DAY);
    return {
      clusterKey: key,
      direction: 'long' as const,
      entryTs: new Date(exitTs.getTime() - 3_600_000),
      exitTs,
      rMultiple: String(r),
      maeBps: String(mae * 10_000),
      netPnl: String(r * 10),
      pnlRTpA: String(r),
      pnlRTpB: String(r),
      pnlRTpC: String(r),
      pnlRTpD: String(r),
    };
  }

  beforeAll(async () => {
    ({ db, pool } = createDb());
    // London: 60 Trades, +2R/−1R alternierend → belastbar. Asia: nur 10 Trades.
    await db.insert(schema.studyTrades).values([
      ...Array.from({ length: 60 }, (_, k) => fixture(LONDON, k, k % 2 === 0 ? 2 : -1)),
      ...Array.from({ length: 10 }, (_, k) => fixture(ASIA, k, 1)),
      // Außerhalb des 90-Tage-Fensters → zählt nicht
      { ...fixture(LONDON, 0, 5), exitTs: new Date(NOW.getTime() - 200 * DAY), entryTs: new Date(NOW.getTime() - 201 * DAY) },
    ]);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM study_trades WHERE cluster_key LIKE ${STRAT + '|%'}`);
    await db.execute(sql`DELETE FROM study_clusters WHERE cluster_key LIKE ${STRAT + '|%'}`);
    await pool.end();
  });

  it('schreibt exakte + übergeordnete Cluster; nur Batch-Zeilen mit Changelog-Quelle', async () => {
    const res = await recomputeStudyClusters(db, { now: NOW, keyPrefix: PREFIX });
    expect(res.rowsUsed).toBe(70);
    // london|uptrend, london|all, asia|transition, asia|all, all|all
    expect(res.clusters).toBe(5);

    const rows = await db.execute(
      sql`SELECT cluster_key, trade_count, is_low_sample_size, optimal_leverage, changelog FROM study_clusters WHERE cluster_key LIKE ${STRAT + '|%'} ORDER BY cluster_key`,
    );
    const byKey = new Map(rows.rows.map((r) => [r.cluster_key as string, r]));
    expect(byKey.get(LONDON)!.trade_count).toBe(60);
    expect(byKey.get(LONDON)!.is_low_sample_size).toBe(false);
    expect(byKey.get(ASIA)!.trade_count).toBe(10);
    expect(byKey.get(ASIA)!.optimal_leverage).toBeNull();
    expect(byKey.get(`${PREFIX}all|all`)!.trade_count).toBe(70);
    const log = byKey.get(LONDON)!.changelog as { source: string }[];
    expect(log[log.length - 1]!.source).toBe('study-batch');
  });

  it('getOptimalParams: exakter Cluster belastbar → Vorschlag, gedeckelt durch Risk-Settings', async () => {
    const p = await getOptimalParams(db, LONDON, { maxLeverage: 1, riskPctPerTrade: 0.5 });
    expect(p.available).toBe(true);
    if (!p.available) return;
    expect(p.level).toBe('exact');
    expect(p.tradeCount).toBe(60);
    expect(p.leverage).toBe(1);
    expect(p.riskPct).toBeLessThanOrEqual(0.5);
  });

  it('getOptimalParams: Asia zu klein → Fallback auf Basis-Cluster (70 Trades) statt Raten', async () => {
    const p = await getOptimalParams(db, ASIA, { maxLeverage: 10, riskPctPerTrade: 2 });
    expect(p).toMatchObject({ available: true, level: 'base', clusterKey: `${PREFIX}all|all`, tradeCount: 70 });
  });

  it('getOptimalParams: unbekannter Cluster → null mit Grund no_data', async () => {
    const p = await getOptimalParams(db, `${STRAT}|ETH/USDT|swing|4h|london|uptrend`, { maxLeverage: 10, riskPctPerTrade: 2 });
    expect(p).toMatchObject({ available: false, reason: 'no_data' });
  });
});
