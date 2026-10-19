/**
 * Nacht-Optimierung gegen die ECHTE DB (Server-CI maßgeblich; lokal ohne
 * DATABASE_URL übersprungen). Eigene Test-Strategien + eigenes Test-Symbol;
 * der Lauf ist per strategyIds auf sie begrenzt — echte Strategien bleiben unberührt.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@gladiator/db';
import type { OptimizationProposalResults } from '@gladiator/backtest';
import type pg from 'pg';
import { openOptimizationProposals, runStrategyOptimization, OPT_MAX_BARS } from './optimization.js';

/**
 * Deterministischer 1h-Markt mit
 * Tagesmuster — kein Zufall, keine Laufpfad-Nutzung. Ab 07:00 UTC (London)
 * wird gekauft; um 08:00 taucht der Kurs 1,1 % unter den Einstieg, danach
 * steigt er bis 20:00 um 5 %. Ein 1-%-Stop wird also täglich ausgestoppt,
 * ein 1,25-%-Stop überlebt — die Optimierung MUSS den weiteren Stop finden.
 */
function dippingTrendCandles(endTs: Date, count: number): { ts: Date; open: number; high: number; low: number; close: number; volume: number }[] {
  const hourMs = 3_600_000;
  const end = Math.floor(endTs.getTime() / hourMs) * hourMs;
  const out: { ts: Date; open: number; high: number; low: number; close: number; volume: number }[] = [];
  const endDay = Math.floor(end / 86_400_000);
  let prevClose: number | null = null;
  for (let k = count - 1; k >= 0; k--) {
    const ts = new Date(end - k * hourMs);
    const day = Math.floor(ts.getTime() / 86_400_000);
    const h = ts.getUTCHours();
    const s = 100 * Math.pow(1.012, day - endDay); // Tagesstart, +1,2 % je Tag
    const e = s * 1.007; // Schluss 07:00 = Einstieg
    let close: number;
    let low: number | null = null;
    if (h < 7) close = s * (1 + 0.001 * h);
    else if (h === 7) close = e;
    else if (h === 8) {
      close = e * 0.995;
      low = e * 0.989; // Dip 1,1 % unter Einstieg
    } else if (h === 9) {
      close = e * 1.0;
      low = e * 0.993;
    } else if (h <= 20) close = e * (1 + 0.05 * ((h - 9) / 11));
    else close = e * 1.05 - (e * 1.05 - s * 1.012) * ((h - 20) / 4); // Abend: zurück Richtung nächster Tagesstart
    const open: number = prevClose ?? close;
    const high = Math.max(open, close) * 1.0005;
    const lo = low ?? Math.min(open, close) * 0.9995;
    out.push({ ts, open, high, low: Math.min(lo, open, close), close, volume: 100 });
    prevClose = close;
  }
  return out;
}

const hasDb = Boolean(process.env.DATABASE_URL);
if (!hasDb) console.warn('[optimization.test] DATABASE_URL nicht gesetzt — übersprungen (Server-CI maßgeblich).');

const { strategies, strategyVersions, optimizations, ohlcv, auditLog } = schema;
const RUN = `${process.pid}${Date.now()}`.slice(-10);
const SYMBOL = `OPT${RUN}/USDT`;
const EMPTY_SYMBOL = `OPTE${RUN}/USDT`;
const NOW = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);

const dsl = (id: string, symbol: string) => ({
  id,
  symbol,
  timeframe: '1h',
  direction: 'long',
  when: { session: 'london', all: [{ trend: 'EMA200_up' }] },
  stopLoss: { type: 'pct', pct: 1 },
  takeProfits: [{ rr: 1 }, { rr: 2 }],
});

describe.skipIf(!hasDb)('Nacht-Optimierung → Vorschlag (08_ §5, Mensch im Loop)', () => {
  let db: Db;
  let pool: pg.Pool;
  let strategyId: string;
  let versionId: string;
  let emptyStrategyId: string;

  beforeAll(async () => {
    ({ db, pool } = createDb());
    const [s] = await db.insert(strategies).values({ slug: `opt-test-${RUN}`, name: 'Opt-Test', kind: 'dsl' }).returning();
    strategyId = s!.id;
    const [v] = await db
      .insert(strategyVersions)
      .values({ strategyId, version: 1, params: dsl(`opt-test-${RUN}`, SYMBOL), status: 'paper' })
      .returning();
    versionId = v!.id;
    const [e] = await db.insert(strategies).values({ slug: `opt-empty-${RUN}`, name: 'Opt-Leer', kind: 'dsl' }).returning();
    emptyStrategyId = e!.id;
    await db.insert(strategyVersions).values({ strategyId: emptyStrategyId, version: 1, params: dsl(`opt-empty-${RUN}`, EMPTY_SYMBOL), status: 'paper' });

    const rows = dippingTrendCandles(NOW, OPT_MAX_BARS).map((c) => ({
      venue: 'binance',
      symbol: SYMBOL,
      timeframe: '1h',
      ts: c.ts,
      open: String(c.open),
      high: String(c.high),
      low: String(c.low),
      close: String(c.close),
      volume: String(c.volume),
    }));
    for (let k = 0; k < rows.length; k += 500) await db.insert(ohlcv).values(rows.slice(k, k + 500));
  });

  afterAll(async () => {
    const ids = (await db.select({ id: optimizations.id }).from(optimizations).where(inArray(optimizations.strategyId, [strategyId, emptyStrategyId]))).map((r) => r.id);
    if (ids.length > 0) {
      await db.delete(auditLog).where(sql`${auditLog.entityType} = 'optimization' AND ${auditLog.entityId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
    }
    await db.delete(strategies).where(inArray(strategies.id, [strategyId, emptyStrategyId])); // cascade: Versionen + Optimierungen
    await db.delete(ohlcv).where(eq(ohlcv.symbol, SYMBOL));
    await pool.end();
  });

  it('klar besserer Kandidat → genau EIN Vorschlag (status done, Review offen) + Audit; laufende Version bleibt unverändert', async () => {
    const res = await runStrategyOptimization(db, { now: NOW, strategyIds: [strategyId, emptyStrategyId] });
    expect(res.errors).toEqual([]);
    expect(res.proposals).toHaveLength(1);
    expect(res.proposals[0]!.strategy).toBe(`opt-test-${RUN}`);

    // Zu wenig Kerzen → ehrlich übersprungen, kein Vorschlag
    expect(res.skipped.some((s) => s.target.includes(`opt-empty-${RUN}`) && /Kerzen/.test(s.reason))).toBe(true);

    const [row] = await db.select().from(optimizations).where(eq(optimizations.id, res.proposals[0]!.optimizationId));
    expect(row!.status).toBe('done');
    expect(row!.baseVersionId).toBe(versionId);
    expect(row!.method).toBe('walk-forward-grid');
    const results = row!.results as OptimizationProposalResults;
    expect(results.review.state).toBe('open');
    expect(results.kind).toBe('dsl');
    expect(results.baseVersion).toBe(1);
    expect(results.checks.every((c) => c.passed)).toBe(true);
    expect(results.after.tradeCount).toBeGreaterThanOrEqual(30);
    expect(results.after.expectancy!).toBeGreaterThan(results.before.expectancy! + 0.05);
    expect(results.window.windows).toBeGreaterThanOrEqual(3);
    expect(results.markets[0]!.fundingSource).toBe('model'); // keine Funding-Historie fürs Test-Symbol
    // Weiterer Stop ist der Kern des Vorteils (1-%-Stop wird täglich vom Dip ausgestoppt)
    const best = row!.bestParams as { stopLoss: { type: string; pct: number } };
    expect(best.stopLoss.pct).toBeGreaterThan(1);
    expect(results.changes.some((c) => c.path === 'stopLoss.pct')).toBe(true);

    const audits = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.action} = 'strategy.optimization.proposed' AND ${auditLog.entityId} = ${row!.id}`);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor).toBe('optimizer');

    // Mensch im Loop: NICHTS wurde automatisch umgestellt oder angelegt
    const versions = await db.select().from(strategyVersions).where(eq(strategyVersions.strategyId, strategyId));
    expect(versions).toHaveLength(1);
    expect(versions[0]!.status).toBe('paper');
    expect(versions[0]!.params).toEqual(dsl(`opt-test-${RUN}`, SYMBOL));
  });

  it('erneuter Lauf mit gleichem Ergebnis → kein doppelter Vorschlag', async () => {
    const res = await runStrategyOptimization(db, { now: NOW, strategyIds: [strategyId] });
    expect(res.proposals).toHaveLength(0);
    expect(res.skipped.some((s) => /bereits offen/.test(s.reason))).toBe(true);
    const rows = await db.select().from(optimizations).where(eq(optimizations.strategyId, strategyId));
    expect(rows).toHaveLength(1);
  });

  it('offene Vorschläge sind fürs Briefing abrufbar', async () => {
    const open = await openOptimizationProposals(db, 50);
    const mine = open.find((p) => p.strategy === `opt-test-${RUN}`);
    expect(mine).toBeDefined();
    expect(mine!.baseVersion).toBe(1);
    expect(mine!.expectancyAfter!).toBeGreaterThan(mine!.expectancyBefore!);
  });
});
