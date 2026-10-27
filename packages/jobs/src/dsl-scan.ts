import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { getOhlcv, isCandleFresh } from '@gladiator/market-data';
import { deriveLifecyclePlans, evaluateDslAt, parseInstructionDsl } from '@gladiator/strategy-engine';
import { registeredAssets, type RegisteredAsset } from './asset-register.js';
import { prepareScanCandles, scanSourceTimeframe, signalAssetClassFor, type ScanTarget } from './scan-targets.js';
import { normalizeTradingPair } from './universe.js';

const { strategies, strategyVersions, signals } = schema;

/**
 * DSL-Scan (07_ §3/§4): registrierte Anweisungs-Strategien laufen durch
 * DIESELBE Pipeline wie die eingebauten — letzter abgeschlossener Bar,
 * echte Kerzen, Dedupe, kanonisches Signal (source 'instruction').
 * Kerzenquelle (A1): das DSL-Symbol wird im Asset-Register nachgeschlagen (Binance, Yahoo,
 * Twelve Data); unbekannt ⇒ ehrlicher Fehler statt geratener Quelle. Nur abgeschlossene, frische
 * Kerzen, 4h für Börsen-Quellen aus 1h — wie der SMC-Scan.
 */

const MIN_CANDLES = 220;
const LOAD_LIMIT = 400;

/**
 * DSL-Symbol → Kerzenquelle + Klasse: Register-Treffer (erste Quelle in Prioritäts-Reihenfolge,
 * ohne Scan-Cap); sonst ein Krypto-Paar → Binance (bisheriges Verhalten); sonst null.
 */
export function resolveDslTarget(symbol: string, registered: readonly RegisteredAsset[]): ScanTarget | null {
  const wanted = symbol.trim().toUpperCase();
  for (const asset of registered) {
    if (asset.symbol.toUpperCase() !== wanted) continue;
    const assetClass = signalAssetClassFor(asset);
    if (assetClass) return { symbol: asset.symbol, venue: asset.venue, assetClass };
  }
  const pair = normalizeTradingPair(wanted);
  return pair ? { symbol: pair, venue: 'binance', assetClass: 'crypto' } : null;
}

export type DslScanResult = {
  scanned: { slug: string; symbol: string; timeframe: string; candles: number }[];
  inserted: number;
  skippedDuplicates: number;
  errors: string[];
};

export async function runDslScan(db: Db, opts: { now?: Date } = {}): Promise<DslScanResult> {
  const now = opts.now ?? new Date();
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

  const registered = latest.size > 0 ? await registeredAssets(db) : [];

  for (const row of latest.values()) {
    const parsed = parseInstructionDsl(row.params);
    if (!parsed.ok) {
      result.errors.push(`${row.slug} v${row.version}: DSL ungültig (${parsed.errors.join('; ')})`);
      continue;
    }
    const dsl = parsed.dsl;

    const target = resolveDslTarget(dsl.symbol, registered);
    if (!target) {
      result.errors.push(`${row.slug} v${row.version}: Quelle für ${dsl.symbol} unbekannt — erst als Markt hinzufügen.`);
      continue;
    }
    const sourceTf = scanSourceTimeframe(target.venue, dsl.timeframe);
    const raw = await getOhlcv(db, {
      venue: target.venue,
      symbol: target.symbol,
      timeframe: sourceTf,
      limit: sourceTf === dsl.timeframe ? LOAD_LIMIT + 1 : LOAD_LIMIT * 4,
    });
    const candles = prepareScanCandles(target.venue, dsl.timeframe, raw, now).slice(-LOAD_LIMIT);
    result.scanned.push({ slug: row.slug, symbol: dsl.symbol, timeframe: dsl.timeframe, candles: candles.length });
    if (candles.length < MIN_CANDLES) continue; // ehrlich: zu wenig Historie
    const lastTs = candles[candles.length - 1]!.ts;
    if (!isCandleFresh(lastTs, dsl.timeframe, target.venue, now)) {
      result.errors.push(`${row.slug}: ${target.venue}:${target.symbol}@${dsl.timeframe} veraltet (letzte Kerze ${lastTs.toISOString()}) — kein Signal auf alten Kerzen.`);
      continue;
    }

    const setup = evaluateDslAt(candles, candles.length - 1, dsl);
    if (!setup) continue;

    const dup = await db.execute(sql`
      SELECT 1 FROM signals
      WHERE strategy_id = ${row.strategyId} AND venue = ${target.venue} AND symbol = ${target.symbol} AND timeframe = ${dsl.timeframe}
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
      // Die Version ist zugleich der Transportweg für TP-Gewichte und den
      // Break-Even-Schalter: der Executor liest sie aus DERSELBEN (unveränderlichen)
      // DSL dieser Version (loadExecutionPlan) — Backtest = Live, ohne Extra-Spalte.
      strategyVersionId: row.versionId,
      symbol: target.symbol,
      venue: target.venue,
      timeframe: dsl.timeframe,
      assetClass: target.assetClass,
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
      // 05_ §9: Reentry-/Leverage-Upgrade-Plan je Setup-Typ (dieselbe Ableitung wie die Engine).
      ...deriveLifecyclePlans(setup),
      emaRegime: setup.emaRegime,
      marketPhase: setup.marketPhase,
      status: 'new',
    });
    result.inserted++;
  }

  return result;
}
