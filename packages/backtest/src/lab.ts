import { and, eq } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { getOhlcv } from '@gladiator/market-data';
import { evaluateSmcCoreAt, SMC_CORE_DEFAULTS, type SmcCoreParams } from '@gladiator/strategy-engine';
import { DEFAULT_COSTS, runBacktest, type BacktestResult, type CostModel } from './engine.js';
import { runWalkForward, type WalkForwardResult } from './walkforward.js';
import { explainRapsChoice, rapsGrid, type RapsResult } from './raps.js';

const { backtests, walkforwardRuns, strategies, strategyVersions, studyTrades, studyClusters } = schema;

/**
 * Labor-Läufe: verbinden Engine ↔ echte DB-Kerzen ↔ Persistenz.
 * Jeder Lauf speichert Config + PFLICHT-Kostenmodell + Netto-Kennzahlen in
 * `backtests`; Trades fließen als VDB1-Zeilen in `study_trades`, das
 * RAPS-Ergebnis als VDB2-Upsert in `study_clusters` (13_).
 */

export const BARS_PER_YEAR: Record<string, number> = {
  '15m': 35_040,
  '1h': 8_760,
  '4h': 2_190,
  '1d': 365,
};

export type LabRunInput = {
  symbol: string;
  timeframe: '15m' | '1h' | '4h' | '1d';
  setupType: 'scalp' | 'swing' | 'position';
  from: Date;
  to: Date;
  /** Parameter-Overrides (Experimente) ODER via versionId eine gespeicherte Version. */
  params?: Partial<SmcCoreParams>;
  versionId?: string;
  riskPctPerTrade?: number;
  costModel?: CostModel;
};

export type LabRunOutput = {
  backtestId: string;
  candles: number;
  params: SmcCoreParams;
  costModel: CostModel;
  result: BacktestResult;
  raps: RapsResult & { explanation: string; clusterKey: string };
};

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

export async function runLabBacktest(db: Db, input: LabRunInput): Promise<LabRunOutput> {
  const { defaultVersionId } = await smcCoreIds(db);
  const versionParams = input.versionId ? await resolveVersion(db, input.versionId) : {};
  const params: SmcCoreParams = { ...SMC_CORE_DEFAULTS, ...versionParams, ...input.params };
  const costModel = input.costModel ?? DEFAULT_COSTS;
  const riskPct = input.riskPctPerTrade ?? 1;

  const candles = await getOhlcv(db, {
    symbol: input.symbol,
    timeframe: input.timeframe,
    since: input.from,
    until: input.to,
  });
  if (candles.length < 250) {
    throw new Error(`Zu wenig echte Kerzen im Zeitraum (${candles.length}) — Backtest wäre nicht belastbar.`);
  }

  const result = runBacktest(candles, {
    evaluate: (cs, i) => evaluateSmcCoreAt(cs, i, params, { higherTfTrend: 'neutral' }),
    initialEquity: 10_000,
    riskPctPerTrade: riskPct,
    costModel,
    barsPerYear: BARS_PER_YEAR[input.timeframe]!,
    tpWeights: [0.5, 0.3, 0.2],
    setupType: input.setupType,
  });

  const m = result.metrics;
  const [row] = await db
    .insert(backtests)
    .values({
      strategyVersionId: input.versionId ?? defaultVersionId,
      symbol: input.symbol,
      timeframe: input.timeframe,
      fromTs: input.from,
      toTs: input.to,
      config: { setupType: input.setupType, riskPctPerTrade: riskPct, params },
      feesModel: costModel,
      sharpe: m.sharpe === null ? null : String(m.sharpe),
      sortino: m.sortino === null ? null : String(m.sortino),
      maxDrawdown: String(m.maxDrawdownPct),
      winRate: m.winRate === null ? null : String(m.winRate),
      profitFactor: m.profitFactor === null ? null : String(m.profitFactor),
      expectancy: m.expectancy === null ? null : String(m.expectancy),
      netReturn: String(m.netReturnPct),
      tradeCount: String(m.tradeCount),
      metrics: m,
      status: 'done',
      finishedAt: new Date(),
    })
    .returning();

  // ── VDB1: Trades als study_trades (Quelle: echter Backtest, 13_ §3) ──
  const clusterKey = `smc-core|${input.symbol}|${input.setupType}|${input.timeframe}|all|all`;
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

  return {
    backtestId: row!.id,
    candles: candles.length,
    params,
    costModel,
    result,
    raps: { ...raps, explanation, clusterKey },
  };
}

export type LabWalkForwardInput = {
  symbol: string;
  timeframe: '15m' | '1h' | '4h' | '1d';
  setupType: 'scalp' | 'swing' | 'position';
  from: Date;
  to: Date;
  isBars: number;
  oosBars: number;
  /** Kleines Parameter-Grid für die IS-Optimierung. */
  grid: Partial<SmcCoreParams>[];
  riskPctPerTrade?: number;
  costModel?: CostModel;
};

export async function runLabWalkForward(
  db: Db,
  input: LabWalkForwardInput,
): Promise<{ runId: string; wf: WalkForwardResult<Partial<SmcCoreParams>> }> {
  const { defaultVersionId } = await smcCoreIds(db);
  const costModel = input.costModel ?? DEFAULT_COSTS;
  const candles = await getOhlcv(db, {
    symbol: input.symbol,
    timeframe: input.timeframe,
    since: input.from,
    until: input.to,
  });
  if (candles.length < input.isBars + input.oosBars) {
    throw new Error(`Zu wenig Kerzen (${candles.length}) für IS ${input.isBars} + OOS ${input.oosBars}.`);
  }
  if (input.grid.length === 0 || input.grid.length > 64) {
    throw new Error('Parameter-Grid muss 1–64 Kombinationen haben.');
  }

  const wf = runWalkForward(candles, {
    paramGrid: input.grid,
    makeEvaluator: (p) => {
      const params = { ...SMC_CORE_DEFAULTS, ...p };
      return (cs, i) => evaluateSmcCoreAt(cs, i, params, { higherTfTrend: 'neutral' });
    },
    isBars: input.isBars,
    oosBars: input.oosBars,
    base: {
      initialEquity: 10_000,
      riskPctPerTrade: input.riskPctPerTrade ?? 1,
      costModel,
      barsPerYear: BARS_PER_YEAR[input.timeframe]!,
      tpWeights: [0.5, 0.3, 0.2],
      setupType: input.setupType,
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
        grid: input.grid,
        costModel,
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

  return { runId: row!.id, wf };
}
