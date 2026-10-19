import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { getOhlcv } from '@gladiator/market-data';
import { evaluateDslAt, parseInstructionDsl } from '@gladiator/strategy-engine';

const { strategies, strategyVersions, signals } = schema;

/**
 * DSL-Scan (07_ §3/§4): registrierte Anweisungs-Strategien laufen durch
 * DIESELBE Pipeline wie die eingebauten — letzter abgeschlossener Bar,
 * echte Kerzen, Dedupe, kanonisches Signal (source 'instruction').
 */

const MIN_CANDLES = 220;
const LOAD_LIMIT = 400;

export type DslScanResult = {
  scanned: { slug: string; symbol: string; timeframe: string; candles: number }[];
  inserted: number;
  skippedDuplicates: number;
  errors: string[];
};

export async function runDslScan(db: Db): Promise<DslScanResult> {
  const result: DslScanResult = { scanned: [], inserted: 0, skippedDuplicates: 0, errors: [] };

  const rows = await db
    .select({
      strategyId: strategies.id,
      slug: strategies.slug,
      versionId: strategyVersions.id,
      version: strategyVersions.version,
      params: strategyVersions.params,
    })
    .from(strategies)
    .innerJoin(strategyVersions, eq(strategyVersions.strategyId, strategies.id))
    .where(and(eq(strategies.kind, 'dsl'), eq(strategies.isActive, true), eq(strategyVersions.status, 'paper')))
    .orderBy(desc(strategyVersions.version));

  // Je Strategie nur die NEUESTE Paper-Version auswerten.
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.strategyId)) latest.set(r.strategyId, r);

  for (const row of latest.values()) {
    const parsed = parseInstructionDsl(row.params);
    if (!parsed.ok) {
      result.errors.push(`${row.slug} v${row.version}: DSL ungültig (${parsed.errors.join('; ')})`);
      continue;
    }
    const dsl = parsed.dsl;

    const candles = await getOhlcv(db, { symbol: dsl.symbol, timeframe: dsl.timeframe, limit: LOAD_LIMIT });
    result.scanned.push({ slug: row.slug, symbol: dsl.symbol, timeframe: dsl.timeframe, candles: candles.length });
    if (candles.length < MIN_CANDLES) continue; // ehrlich: zu wenig Historie

    const setup = evaluateDslAt(candles, candles.length - 1, dsl);
    if (!setup) continue;

    const dup = await db.execute(sql`
      SELECT 1 FROM signals
      WHERE strategy_id = ${row.strategyId} AND symbol = ${dsl.symbol} AND timeframe = ${dsl.timeframe}
        AND direction = ${setup.direction} AND setup_type = ${setup.setupType}
        AND status = 'new'
      LIMIT 1
    `);
    if (dup.rows.length > 0) {
      result.skippedDuplicates++;
      continue;
    }

    await db.insert(signals).values({
      source: 'instruction',
      strategyId: row.strategyId,
      strategyVersionId: row.versionId,
      symbol: dsl.symbol,
      timeframe: dsl.timeframe,
      assetClass: 'crypto',
      venueType: dsl.venueType,
      direction: setup.direction,
      setupType: setup.setupType,
      entry: String(setup.entry),
      stopLoss: String(setup.stopLoss),
      takeProfits: setup.takeProfits.map(String),
      // Trailing-Stop der Strategie reist mit dem Signal bis in die Live-Position (Backtest = Live).
      ...(setup.trailPct !== undefined ? { trailPct: String(setup.trailPct) } : {}),
      leverageSuggested: String(setup.leverageSuggested),
      score: String(setup.score),
      riskClass: setup.riskClass,
      confluence: setup.confluence,
      session: setup.session,
      emaRegime: setup.emaRegime,
      marketPhase: setup.marketPhase,
      status: 'new',
    });
    result.inserted++;
  }

  return result;
}
