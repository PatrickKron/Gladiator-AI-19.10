import { and, asc, desc, eq, gt, lte } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { getOhlcv, BARS_PER_YEAR, TIMEFRAME_MS, type SupportedTimeframe } from '@gladiator/market-data';
import { detectStructure, evaluateDslAt, evaluateSmcCoreAt, parseInstructionDsl, SMC_CORE_DEFAULTS, type InstructionDsl, type SmcCoreParams } from '@gladiator/strategy-engine';
import { DEFAULT_COSTS, runBacktest, type BacktestResult, type CostModel } from './engine.js';
import { runWalkForward, type WalkForwardResult } from './walkforward.js';
import { explainRapsChoice, rapsGrid, type RapsResult } from './raps.js';
import { analyzeTrades, type TradeAnalysis } from './analysis.js';
import { holdoutMetrics } from './validity.js';
import { assertDataQuality, assessDataQuality, fundingSettlements, type DataQualityReport, type FundingPoint } from './data-quality.js';

const { backtests, walkforwardRuns, strategies, strategyVersions, studyTrades, studyClusters, fundingRates } = schema;

/**
 * Labor-Läufe: verbinden Engine ↔ echte DB-Kerzen ↔ Persistenz.
 * Jeder Lauf speichert Config + PFLICHT-Kostenmodell + Netto-Kennzahlen in
 * `backtests`; Trades fließen als VDB1-Zeilen in `study_trades`, das
 * RAPS-Ergebnis als VDB2-Upsert in `study_clusters` (13_).
 */

/** Bars/Jahr je Timeframe (Annualisierung) — kanonisch aus @gladiator/market-data. */
export { BARS_PER_YEAR };

export type LabRunInput = {
  /** Optional: registrierte Strategie (kind 'dsl') statt SMC Core backtesten. */
  strategyId?: string;
  symbol: string;
  timeframe: SupportedTimeframe;
  setupType: 'scalp' | 'swing' | 'position';
  from: Date;
  to: Date;
  /** Parameter-Overrides (Experimente) ODER via versionId eine gespeicherte Version. */
  params?: Partial<SmcCoreParams>;
  versionId?: string;
  riskPctPerTrade?: number;
  costModel?: CostModel;
  /** Trailing-Stop in % für alle Trades (DSL-Strategien mit eigenem trailingStop behalten ihren Wert). */
  trailPct?: number;
};

export type TurningPoint = { ts: string; kind: 'BOS' | 'CHoCH'; direction: 'bullish' | 'bearish'; level: number };

export type LabRunOutput = {
  backtestId: string;
  candles: number;
  params: SmcCoreParams;
  costModel: CostModel;
  result: BacktestResult;
  raps: RapsResult & { explanation: string; clusterKey: string };
  /** Rundum-Analyse: Session/Regime/Phase/Confluence-Statistiken. */
  analysis: TradeAnalysis;
  /** Letzte Struktur-Trendwenden (CHoCH) und Fortsetzungen (BOS) im Zeitraum. */
  turningPoints: TurningPoint[];
  /** Woher das Funding stammt: echte Settlements aus `funding_rates` oder flaches Modell. */
  fundingSource: 'historical' | 'model';
  /** Datenqualität der Kerzen (08_ §3b) inkl. deutscher Warnungen fürs UI. */
  dataQuality: DataQualityReport;
};

/** Mindest-Abdeckung der 8h-Settlements, damit historisches Funding verwendet wird. */
const MIN_FUNDING_COVERAGE = 0.95;

/**
 * Historische Funding-Settlements für den Kerzen-Zeitraum laden (Binance-Perps,
 * App-Symbol). Unvollständige Historie → null (dann flaches Modell, ehrlich markiert)
 * plus Warnung — fehlende Settlements werden NICHT aufgefüllt.
 */
async function loadFundingSeries(
  db: Db,
  symbol: string,
  from: Date,
  to: Date,
): Promise<{ series: FundingPoint[] | null; warning: string | null }> {
  const rows = await db
    .select({ ts: fundingRates.ts, rate: fundingRates.rate })
    .from(fundingRates)
    .where(
      and(
        eq(fundingRates.venue, 'binanceusdm'),
        eq(fundingRates.symbol, symbol),
        gt(fundingRates.ts, new Date(from.getTime() - 8 * 3_600_000)),
        lte(fundingRates.ts, to),
      ),
    )
    .orderBy(asc(fundingRates.ts));
  if (rows.length === 0) return { series: null, warning: null };
  const { series, coverage } = fundingSettlements(
    rows.map((r) => ({ ts: r.ts, rate: Number(r.rate) })),
    from,
    to,
  );
  if (coverage < MIN_FUNDING_COVERAGE) {
    return {
      series: null,
      warning: `Funding-Historie deckt nur ${Math.round(coverage * 100)} % der Settlements im Zeitraum ab — flaches Funding-Modell verwendet.`,
    };
  }
  return { series, warning: null };
}

async function resolveVersion(db: Db, versionId: string): Promise<Partial<SmcCoreParams>> {
  const [v] = await db.select().from(strategyVersions).where(eq(strategyVersions.id, versionId)).limit(1);
  if (!v) throw new Error('Strategie-Version nicht gefunden.');
  return v.params as Partial<SmcCoreParams>;
}

async function smcCoreIds(db: Db): Promise<{ strategyId: string; defaultVersionId: string }> {
  const [s] = await db.select().from(strategies).where(eq(strategies.slug, 'smc-core')).limit(1);
  if (!s) throw new Error('Strategie smc-core ist nicht registriert (Scan einmal laufen lassen).');
  const [v1] = await db
    .select()
    .from(strategyVersions)
    .where(and(eq(strategyVersions.strategyId, s.id), eq(strategyVersions.version, 1)))
    .limit(1);
  if (!v1) throw new Error('SMC-Core-Version 1 fehlt.');
  return { strategyId: s.id, defaultVersionId: v1.id };
}

/** Löst eine registrierte DSL-Strategie in (dsl, versionId) auf — neueste Paper-Version. */
async function resolveDslStrategy(db: Db, strategyId: string): Promise<{ dsl: InstructionDsl; versionId: string; slug: string }> {
  const [strategy] = await db.select().from(strategies).where(eq(strategies.id, strategyId)).limit(1);
  if (!strategy) throw new Error('Strategie nicht gefunden.');
  if (strategy.kind !== 'dsl') throw new Error(`Strategie ${strategy.slug} ist kind '${strategy.kind}' — im Labor sind SMC Core (Standard) und DSL-Strategien backtestbar.`);
  const [version] = await db
    .select()
    .from(strategyVersions)
    .where(eq(strategyVersions.strategyId, strategyId))
    .orderBy(desc(strategyVersions.version))
    .limit(1);
  if (!version) throw new Error('Strategie hat keine Version.');
  const parsed = parseInstructionDsl(version.params);
  if (!parsed.ok) throw new Error(`DSL der Version ungültig: ${parsed.errors.join('; ')}`);
  return { dsl: parsed.dsl, versionId: version.id, slug: strategy.slug };
}

/** Indikator-Historie je Walk-Forward-Fenster (≥ EMA200 der SMC-/DSL-Evaluatoren). */
export const WF_WARMUP_BARS = 250;

export type LabMarketData = {
  candles: Awaited<ReturnType<typeof getOhlcv>>;
  dataQuality: DataQualityReport;
  fundingSeries: FundingPoint[] | null;
  fundingSource: 'historical' | 'model';
};

/**
 * EINE Wahrheit für Labor-Backtest, Labor-Walk-Forward und Nacht-Optimierung:
 * echte Kerzen laden → Mindestmenge prüfen → Datenqualität (08_ §3b, zu viele
 * Lücken → Abbruch) → historisches Funding (sonst flaches Modell, sichtbar markiert).
 */
export async function loadLabMarketData(
  db: Db,
  opts: { symbol: string; timeframe: SupportedTimeframe; from: Date; to: Date; minCandles: number; minCandlesMessage?: (n: number) => string },
): Promise<LabMarketData> {
  const candles = await getOhlcv(db, {
    symbol: opts.symbol,
    timeframe: opts.timeframe,
    since: opts.from,
    until: opts.to,
  });
  if (candles.length < opts.minCandles) {
    throw new Error(
      opts.minCandlesMessage?.(candles.length) ??
        `Zu wenig echte Kerzen im Zeitraum (${candles.length} < ${opts.minCandles}) für ${opts.symbol}@${opts.timeframe}.`,
    );
  }

  // ── Datenqualität (08_ §3b): zu viele Lücken → Abbruch; sonst Warnungen ans UI ──
  const tfMs = TIMEFRAME_MS[opts.timeframe];
  const dataQuality = assessDataQuality(candles, tfMs);
  assertDataQuality(dataQuality);
  const firstTs = candles[0]!.ts;
  const lastTs = candles[candles.length - 1]!.ts;
  if (firstTs.getTime() - opts.from.getTime() > tfMs) {
    dataQuality.warnings.push(
      `Kerzen beginnen erst am ${firstTs.toISOString().slice(0, 10)} (angefragt ab ${opts.from.toISOString().slice(0, 10)}) — Zeitraum ist kürzer als gewählt.`,
    );
    dataQuality.ok = false;
  }

  // ── Funding: echte Settlements, falls vollständig vorhanden — sonst flaches Modell ──
  const funding = await loadFundingSeries(db, opts.symbol, firstTs, lastTs);
  if (funding.warning) {
    dataQuality.warnings.push(funding.warning);
    dataQuality.ok = false;
  }
  return {
    candles,
    dataQuality,
    fundingSeries: funding.series,
    fundingSource: funding.series ? 'historical' : 'model',
  };
}

export async function runLabBacktest(db: Db, input: LabRunInput): Promise<LabRunOutput> {
  const { defaultVersionId } = await smcCoreIds(db);
  const versionParams = input.versionId ? await resolveVersion(db, input.versionId) : {};
  const params: SmcCoreParams = { ...SMC_CORE_DEFAULTS, ...versionParams, ...input.params };
  const costModel = input.costModel ?? DEFAULT_COSTS;
  const riskPct = input.riskPctPerTrade ?? 1;

  // DSL-Strategie? Symbol/Timeframe/Setup kommen aus der DSL (die Strategie definiert sie).
  const dslResolved = input.strategyId ? await resolveDslStrategy(db, input.strategyId) : null;
  const runSymbol = dslResolved ? dslResolved.dsl.symbol : input.symbol;
  const runTimeframe = dslResolved ? dslResolved.dsl.timeframe : input.timeframe;
  const runSetupType = dslResolved ? dslResolved.dsl.setupType : input.setupType;

  const { candles, dataQuality, fundingSeries, fundingSource } = await loadLabMarketData(db, {
    symbol: runSymbol,
    timeframe: runTimeframe,
    from: input.from,
    to: input.to,
    minCandles: 250,
    minCandlesMessage: (n) => `Zu wenig echte Kerzen im Zeitraum (${n}) für ${runSymbol}@${runTimeframe} — Backtest wäre nicht belastbar.`,
  });

  const result = runBacktest(candles, {
    evaluate: dslResolved
      ? (cs, i) => {
          const setup = evaluateDslAt(cs, i, dslResolved.dsl);
          return setup ? [setup] : [];
        }
      : (cs, i) => evaluateSmcCoreAt(cs, i, params, { higherTfTrend: 'neutral' }),
    initialEquity: 10_000,
    riskPctPerTrade: riskPct,
    costModel,
    barsPerYear: BARS_PER_YEAR[runTimeframe]!,
    tpWeights: [0.5, 0.3, 0.2],
    setupType: runSetupType,
    ...(input.trailPct !== undefined ? { trailPct: input.trailPct } : {}),
    ...(fundingSeries ? { fundingSeries } : {}),
  });

  const m = result.metrics;
  const [row] = await db
    .insert(backtests)
    .values({
      strategyVersionId: dslResolved ? dslResolved.versionId : (input.versionId ?? defaultVersionId),
      symbol: runSymbol,
      timeframe: runTimeframe,
      fromTs: input.from,
      toTs: input.to,
      config: dslResolved
        ? { strategy: dslResolved.slug, dsl: dslResolved.dsl, riskPctPerTrade: riskPct, trailPct: input.trailPct ?? null, fundingSource, dataWarnings: dataQuality.warnings }
        : { setupType: input.setupType, riskPctPerTrade: riskPct, params, trailPct: input.trailPct ?? null, fundingSource, dataWarnings: dataQuality.warnings },
      feesModel: { ...costModel, fundingSource },
      sharpe: m.sharpe === null ? null : String(m.sharpe),
      sortino: m.sortino === null ? null : String(m.sortino),
      maxDrawdown: String(m.maxDrawdownPct),
      winRate: m.winRate === null ? null : String(m.winRate),
      profitFactor: m.profitFactor === null ? null : String(m.profitFactor),
      expectancy: m.expectancy === null ? null : String(m.expectancy),
      netReturn: String(m.netReturnPct),
      tradeCount: String(m.tradeCount),
      // Robustheits-Check (08 §4): jüngster Abschnitt separat — das Validitäts-Gate liest ihn.
      metrics: { ...m, holdout: holdoutMetrics(result.trades, input.from, input.to) },
      status: 'done',
      finishedAt: new Date(),
    })
    .returning();

  // ── VDB1: Trades als study_trades (Quelle: echter Backtest, 13_ §3) ──
  const clusterKey = `${dslResolved ? dslResolved.slug : 'smc-core'}|${runSymbol}|${runSetupType}|${runTimeframe}|all|all`;
  for (const t of result.trades) {
    await db.insert(studyTrades).values({
      clusterKey,
      direction: t.direction,
      entryTs: t.entryTs,
      exitTs: t.exitTs,
      mfeBps: String(Math.round(t.mfeR * 10_000) / 100),
      maeBps: String(Math.round(t.maeR * 10_000) / 100),
      rMultiple: String(t.rMultiple),
      session: t.session,
      fees: String(t.fees),
      funding: String(t.funding),
      slippage: String(t.slippage),
      netPnl: String(t.netPnl),
      liquidationFlag: false,
      pnlRTpA: String(t.pnlRTpA),
      pnlRTpB: String(t.pnlRTpB),
      pnlRTpC: String(t.pnlRTpC),
      pnlRTpD: String(t.pnlRTpD),
    });
  }

  // ── VDB2: RAPS-Gitter + Upsert study_clusters ──
  const raps = rapsGrid(result.trades, { now: input.to });
  const explanation = explainRapsChoice(raps, clusterKey);
  await db
    .insert(studyClusters)
    .values({
      clusterKey,
      optimalLeverage: raps.best ? String(raps.best.leverage) : null,
      optimalTpSchemaId: raps.best?.tpSchema ?? null,
      optimalRiskPct: String(riskPct),
      rapsScore: raps.best ? String(raps.best.rapsScore) : null,
      sharpe: m.sharpe === null ? null : String(m.sharpe),
      sortino: m.sortino === null ? null : String(m.sortino),
      winrate: m.winRate === null ? null : String(m.winRate),
      profitFactor: m.profitFactor === null ? null : String(m.profitFactor),
      expectancy: m.expectancy === null ? null : String(m.expectancy),
      tradeCount: raps.tradeCount,
      dataWindowDays: Math.round((input.to.getTime() - input.from.getTime()) / 86_400_000),
      lambdaTimeDecay: String(raps.lambdaTimeDecay),
      isLowSampleSize: raps.isLowSampleSize,
      causalityExplanation: explanation,
      changelog: [{ at: new Date().toISOString(), backtestId: row!.id, note: 'Labor-Backtest' }],
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: studyClusters.clusterKey,
      set: {
        optimalLeverage: raps.best ? String(raps.best.leverage) : null,
        optimalTpSchemaId: raps.best?.tpSchema ?? null,
        rapsScore: raps.best ? String(raps.best.rapsScore) : null,
        tradeCount: raps.tradeCount,
        isLowSampleSize: raps.isLowSampleSize,
        causalityExplanation: explanation,
        updatedAt: new Date(),
      },
    });

  // Rundum-Analyse + Trendwende-Punkte (aus der Marktstruktur des Zeitraums)
  const analysis = analyzeTrades(result.trades);
  const turningPoints: TurningPoint[] = detectStructure(candles, {
    leftBars: params.swingLeftBars,
    rightBars: params.swingRightBars,
  })
    .slice(-15)
    .map((e) => ({
      ts: candles[e.index]!.ts.toISOString(),
      kind: e.kind,
      direction: e.direction,
      level: e.brokenLevel,
    }));

  return {
    backtestId: row!.id,
    candles: candles.length,
    params,
    costModel,
    result,
    raps: { ...raps, explanation, clusterKey },
    analysis,
    turningPoints,
    fundingSource,
    dataQuality,
  };
}

export type LabWalkForwardInput = {
  symbol: string;
  timeframe: SupportedTimeframe;
  setupType: 'scalp' | 'swing' | 'position';
  from: Date;
  to: Date;
  isBars: number;
  oosBars: number;
  /** Kleines Parameter-Grid für die IS-Optimierung. */
  grid: Partial<SmcCoreParams>[];
  riskPctPerTrade?: number;
  costModel?: CostModel;
  /** Trailing-Stop in % für alle Trades (wie runLabBacktest). */
  trailPct?: number;
};

export type LabWalkForwardOutput = {
  runId: string;
  wf: WalkForwardResult<Partial<SmcCoreParams>>;
  /** Woher das Funding stammt: echte Settlements aus `funding_rates` oder flaches Modell. */
  fundingSource: 'historical' | 'model';
  /** Datenqualität der Kerzen (08_ §3b) — dieselbe Prüfung wie im Backtest. */
  dataQuality: DataQualityReport;
};

/**
 * Walk-Forward im Labor — Parität zu runLabBacktest: dieselbe Datenqualitäts-
 * Prüfung, historisches Funding, optionaler Trailing-Stop; zusätzlich Warmup je
 * Fenster, damit EMA200 & Co. auch am OOS-Fensteranfang definiert sind.
 */
export async function runLabWalkForward(db: Db, input: LabWalkForwardInput): Promise<LabWalkForwardOutput> {
  const { defaultVersionId } = await smcCoreIds(db);
  const costModel = input.costModel ?? DEFAULT_COSTS;
  if (input.grid.length === 0 || input.grid.length > 64) {
    throw new Error('Parameter-Grid muss 1–64 Kombinationen haben.');
  }
  const { candles, dataQuality, fundingSeries, fundingSource } = await loadLabMarketData(db, {
    symbol: input.symbol,
    timeframe: input.timeframe,
    from: input.from,
    to: input.to,
    minCandles: input.isBars + input.oosBars,
    minCandlesMessage: (n) => `Zu wenig Kerzen (${n}) für IS ${input.isBars} + OOS ${input.oosBars}.`,
  });

  const wf = runWalkForward(candles, {
    paramGrid: input.grid,
    makeEvaluator: (p) => {
      const params = { ...SMC_CORE_DEFAULTS, ...p };
      return (cs, i) => evaluateSmcCoreAt(cs, i, params, { higherTfTrend: 'neutral' });
    },
    isBars: input.isBars,
    oosBars: input.oosBars,
    warmupBars: WF_WARMUP_BARS,
    base: {
      initialEquity: 10_000,
      riskPctPerTrade: input.riskPctPerTrade ?? 1,
      costModel,
      barsPerYear: BARS_PER_YEAR[input.timeframe]!,
      tpWeights: [0.5, 0.3, 0.2],
      setupType: input.setupType,
      ...(input.trailPct !== undefined ? { trailPct: input.trailPct } : {}),
      ...(fundingSeries ? { fundingSeries } : {}),
    },
  });

  const [row] = await db
    .insert(walkforwardRuns)
    .values({
      strategyVersionId: defaultVersionId,
      config: {
        symbol: input.symbol,
        timeframe: input.timeframe,
        setupType: input.setupType,
        from: input.from.toISOString(),
        to: input.to.toISOString(),
        isBars: input.isBars,
        oosBars: input.oosBars,
        warmupBars: WF_WARMUP_BARS,
        grid: input.grid,
        costModel,
        trailPct: input.trailPct ?? null,
        fundingSource,
        dataWarnings: dataQuality.warnings,
      },
      windows: wf.windows.map((w) => ({
        isStart: w.isStart,
        oosStart: w.oosStart,
        oosEnd: w.oosEnd,
        bestParams: w.bestParams,
        isNetPnl: w.isMetrics.netPnl,
        oosNetPnl: w.oosMetrics.netPnl,
        oosTrades: w.oosMetrics.tradeCount,
      })),
      oosMetrics: wf.combinedOos,
      status: 'done',
      finishedAt: new Date(),
    })
    .returning();

  return { runId: row!.id, wf, fundingSource, dataQuality };
}
