/**
 * Labor-Walk-Forward — Parität zu runLabBacktest gegen die ECHTE DB (Server-CI
 * maßgeblich; lokal ohne DATABASE_URL übersprungen): Datenqualitäts-Gate,
 * historisches Funding, Trailing-Stop und Persistenz der Herkunft.
 * Eigene Test-Symbole, Aufräumen im afterAll.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type pg from 'pg';
import { SMC_CORE_DEFAULTS } from '@gladiator/strategy-engine';
import { runLabWalkForward } from './lab.js';

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) console.warn('[lab-walkforward.test] DATABASE_URL nicht gesetzt — übersprungen (Server-CI maßgeblich).');

const { ohlcv, fundingRates, walkforwardRuns, strategies, strategyVersions } = schema;
const RUN = `${process.pid}${Date.now()}`.slice(-10);
const SYMBOL = `LWF${RUN}/USDT`;
const GAPPY = `LWFG${RUN}/USDT`;
const HOUR = 3_600_000;
const END = Math.floor(Date.UTC(2026, 5, 1) / HOUR) * HOUR;
const BARS = 1600;

/** Deterministische Wellen-Kerzen (kein Zufall). */
function waveRows(symbol: string, skip: (k: number) => boolean = () => false) {
  const rows = [];
  for (let k = 0; k < BARS; k++) {
    if (skip(k)) continue;
    const close = 100 * (1 + 0.08 * Math.sin(k / 37) + 0.03 * Math.sin(k / 7)) * (1 + k / 4000);
    const prev = 100 * (1 + 0.08 * Math.sin((k - 1) / 37) + 0.03 * Math.sin((k - 1) / 7)) * (1 + (k - 1) / 4000);
    rows.push({
      venue: 'binance',
      symbol,
      timeframe: '1h',
      ts: new Date(END - (BARS - 1 - k) * HOUR),
      open: String(prev),
      high: String(Math.max(prev, close) * 1.002),
      low: String(Math.min(prev, close) * 0.998),
      close: String(close),
      volume: String(100 + (k % 13) * 10),
    });
  }
  return rows;
}

describe.skipIf(!hasDb)('runLabWalkForward — gleiche Ehrlichkeit wie der Backtest', () => {
  let db: Db;
  let pool: pg.Pool;
  const runIds: string[] = [];

  beforeAll(async () => {
    ({ db, pool } = createDb());
    // SMC Core wie in Produktion registrieren (idempotent, wie ensureSmcCoreStrategy im Scan) —
    // eine frische CI-DB hat noch keinen Scan-Lauf hinter sich. Bleibt stehen: kanonische Builtin-Zeile.
    await db
      .insert(strategies)
      .values({ slug: 'smc-core', name: 'SMC Core (Pine-Referenz)', kind: 'builtin' })
      .onConflictDoNothing({ target: strategies.slug });
    const [smc] = await db.select().from(strategies).where(eq(strategies.slug, 'smc-core')).limit(1);
    const [v1] = await db
      .select()
      .from(strategyVersions)
      .where(and(eq(strategyVersions.strategyId, smc!.id), eq(strategyVersions.version, 1)))
      .limit(1);
    if (!v1) await db.insert(strategyVersions).values({ strategyId: smc!.id, version: 1, params: SMC_CORE_DEFAULTS, status: 'paper' }).onConflictDoNothing();
    const rows = [...waveRows(SYMBOL), ...waveRows(GAPPY, (k) => k % 10 === 3)]; // GAPPY: 10 % Lücken
    for (let k = 0; k < rows.length; k += 500) await db.insert(ohlcv).values(rows.slice(k, k + 500));
    // Vollständige Funding-Historie (Snapshot je 8h-Settlement) → „historisch"
    const funding = [];
    const firstSettlement = Math.floor((END - BARS * HOUR) / (8 * HOUR)) * 8 * HOUR;
    for (let t = firstSettlement; t <= END; t += 8 * HOUR) funding.push({ venue: 'binanceusdm', symbol: SYMBOL, ts: new Date(t), rate: '0.0003' });
    await db.insert(fundingRates).values(funding);
  });

  afterAll(async () => {
    if (runIds.length > 0) await db.delete(walkforwardRuns).where(inArray(walkforwardRuns.id, runIds));
    await db.delete(ohlcv).where(inArray(ohlcv.symbol, [SYMBOL, GAPPY]));
    await db.delete(fundingRates).where(eq(fundingRates.symbol, SYMBOL));
    await pool.end();
  });

  const input = (symbol: string, extra: { trailPct?: number } = {}) => ({
    symbol,
    timeframe: '1h' as const,
    setupType: 'swing' as const,
    from: new Date(END - BARS * HOUR),
    to: new Date(END),
    isBars: 1000,
    oosBars: 250,
    grid: [{}, { emaProximityPct: 3 }],
    ...extra,
  });

  it('liefert dataQuality + historisches Funding und speichert Trailing/Funding-Herkunft im Lauf', async () => {
    const out = await runLabWalkForward(db, input(SYMBOL, { trailPct: 2 }));
    runIds.push(out.runId);
    expect(out.fundingSource).toBe('historical');
    expect(out.dataQuality.gaps).toBe(0);
    expect(out.dataQuality.expectedBars).toBe(BARS);
    expect(out.wf.windows.length).toBe(2);

    const [row] = await db.select().from(walkforwardRuns).where(eq(walkforwardRuns.id, out.runId));
    const cfg = row!.config as Record<string, unknown>;
    expect(cfg.trailPct).toBe(2);
    expect(cfg.fundingSource).toBe('historical');
    expect(cfg.warmupBars).toBeGreaterThanOrEqual(200);
    expect(Array.isArray(cfg.dataWarnings)).toBe(true);
  });

  it('ohne Funding-Historie → ehrlich „model"; ohne trailPct → null im Lauf', async () => {
    // Eigenes lückenloses Symbol ohne Funding-Zeilen
    const noFunding = `LWFN${RUN}/USDT`;
    const rows = waveRows(noFunding);
    for (let k = 0; k < rows.length; k += 500) await db.insert(ohlcv).values(rows.slice(k, k + 500));
    try {
      const out = await runLabWalkForward(db, input(noFunding));
      runIds.push(out.runId);
      expect(out.fundingSource).toBe('model');
      const [row] = await db.select().from(walkforwardRuns).where(eq(walkforwardRuns.id, out.runId));
      expect((row!.config as Record<string, unknown>).trailPct).toBeNull();
    } finally {
      await db.delete(ohlcv).where(eq(ohlcv.symbol, noFunding));
    }
  });

  it('zu viele Datenlücken → Abbruch wie beim Backtest (kein geschöntes Ergebnis)', async () => {
    await expect(runLabWalkForward(db, input(GAPPY, {}))).rejects.toThrow(/Datenlücken zu groß/);
  });
});
