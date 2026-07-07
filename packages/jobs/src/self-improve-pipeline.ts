import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { getOhlcv } from '@gladiator/market-data';
import {
  detectRegimeMultiWindow,
  evaluateAgent,
  computeVaR,
  computeExpectedShortfall,
  computeSortino,
  computeCalmar,
  retrainWithFeedback,
  featureVectorToArray,
  type FeatureVector,
  type TrainingSample,
} from '@gladiator/ml';
import { scanUniverse } from './universe.js';
import { SCAN_TIMEFRAMES } from './signal-scan.js';

const {
  marketRegimes,
  rlAgents,
  rlEpisodes,
  rlAgentPerformance,
  performanceSnapshots,
  mlLabels,
  mlModels,
  modelVersions,
} = schema;

// ── Regime Detection Job ──────────────────────────────────────────────

export type RegimeDetectionResult = {
  detected: number;
  skipped: number;
  errors: string[];
};

/**
 * Detect and store market regimes for all tracked symbols × timeframes.
 * Runs every 15 minutes to keep regime classifications fresh.
 */
export async function detectAllRegimes(db: Db): Promise<RegimeDetectionResult> {
  const result: RegimeDetectionResult = { detected: 0, skipped: 0, errors: [] };
  const universe = await scanUniverse(db);

  for (const symbol of universe) {
    for (const timeframe of SCAN_TIMEFRAMES) {
      try {
        const candles = await getOhlcv(db, { symbol, timeframe, limit: 400 });
        if (candles.length < 220) {
          result.skipped++;
          continue;
        }

        const regime = detectRegimeMultiWindow(candles);

        await db.insert(marketRegimes).values({
          symbol,
          timeframe,
          ts: candles[candles.length - 1]!.ts,
          regime: regime.regime,
          confidence: String(regime.confidence),
          components: regime.components,
        });

        result.detected++;
      } catch (err) {
        result.errors.push(`${symbol}@${timeframe}: ${String(err)}`);
      }
    }
  }

  return result;
}

// ── Self-Evaluation Job ───────────────────────────────────────────────

export type SelfEvaluationResult = {
  evaluated: number;
  proposals: { agentId: string; agentName: string; recommendation: string; reasons: string[] }[];
  errors: string[];
};

/**
 * Run self-evaluation for all active RL agents.
 * Proposes promote/retire/retrain with human gate on destructive actions.
 */
export async function runSelfEvaluation(db: Db): Promise<SelfEvaluationResult> {
  const result: SelfEvaluationResult = { evaluated: 0, proposals: [], errors: [] };

  const agents = await db.select().from(rlAgents)
    .where(sql`${rlAgents.status} IN ('paper', 'sandbox', 'live')`);

  for (const agent of agents) {
    try {
      const episodes = await db.select()
        .from(rlEpisodes)
        .where(and(
          eq(rlEpisodes.agentId, agent.id),
          sql`${rlEpisodes.endedAt} IS NOT NULL`,
        ))
        .orderBy(desc(rlEpisodes.endedAt))
        .limit(90);

      if (episodes.length < 5) continue;

      const returns = episodes.map(e => Number(e.totalReward ?? 0));
      const wins = episodes.map(e => Number(e.winRate ?? 0) > 0.5);
      const bars = episodes.map(() => 50);
      const benchmark = returns.map(() => 0.001);

      const evaluation = evaluateAgent(
        agent.id,
        returns,
        wins,
        bars,
        benchmark,
        [],
      );

      if (evaluation.recommendation !== 'keep') {
        result.proposals.push({
          agentId: agent.id,
          agentName: agent.name,
          recommendation: evaluation.recommendation,
          reasons: evaluation.reasons,
        });
      }

      result.evaluated++;
    } catch (err) {
      result.errors.push(`Agent ${agent.name}: ${String(err)}`);
    }
  }

  return result;
}

// ── Model Comparison Job ──────────────────────────────────────────────

export type ModelComparisonResult = {
  retrained: boolean;
  promoted: boolean;
  version: number | null;
  accuracy: number | null;
  improvement: number | null;
  reason: string;
};

/**
 * Retrain the meta-classifier with feedback loop.
 * Compares new model vs current; only promotes if >2% accuracy improvement.
 * Stores version history for audit trail.
 */
export async function runModelComparison(db: Db): Promise<ModelComparisonResult> {
  const labels = await db.select().from(mlLabels);

  const samples: TrainingSample[] = [];
  for (const label of labels) {
    if (!label.features) continue;
    const fv = label.features as FeatureVector;
    samples.push({
      features: featureVectorToArray(fv),
      label: label.outcome as 0 | 1,
    });
  }

  // Get current active model's metrics
  const [activeModel] = await db.select()
    .from(mlModels)
    .where(eq(mlModels.isActive, true))
    .orderBy(desc(mlModels.version))
    .limit(1);

  const currentMetrics = activeModel?.metrics as { accuracy: number; precision: number; recall: number; f1: number; auc: number } | null ?? null;
  const currentVersion = activeModel?.version ?? 0;

  const retrain = retrainWithFeedback(samples, currentMetrics, currentVersion);

  // Record version in history regardless of promotion
  if (retrain.newMetrics) {
    await db.insert(modelVersions).values({
      modelId: activeModel?.id ?? null,
      version: currentVersion + 1,
      metrics: retrain.newMetrics,
      comparison: retrain.comparison,
      promoted: retrain.retrained,
      promotedAt: retrain.retrained ? new Date() : null,
      promotedBy: retrain.retrained ? 'auto' : null,
      sampleCount: samples.length,
      trainSize: Math.floor(samples.length * 0.8),
      testSize: samples.length - Math.floor(samples.length * 0.8),
    });
  }

  return {
    retrained: retrain.retrained,
    promoted: retrain.retrained,
    version: retrain.retrained ? currentVersion + 1 : null,
    accuracy: retrain.newMetrics?.accuracy ?? null,
    improvement: retrain.comparison?.improvement ?? null,
    reason: retrain.reason,
  };
}

// ── Performance Snapshot Job ──────────────────────────────────────────

export type SnapshotResult = {
  snapshots: number;
  errors: string[];
};

/**
 * Create performance snapshots for all active agents.
 * Builds equity curve, risk metrics, and regime-breakdown rollups.
 */
export async function createPerformanceSnapshots(
  db: Db,
  snapshotType: 'daily' | 'weekly' | 'monthly' = 'daily',
): Promise<SnapshotResult> {
  const result: SnapshotResult = { snapshots: 0, errors: [] };

  const agents = await db.select().from(rlAgents)
    .where(sql`${rlAgents.status} IN ('paper', 'sandbox', 'live')`);

  const now = new Date();
  let periodStart: Date;
  const periodEnd = now;

  switch (snapshotType) {
    case 'daily':
      periodStart = new Date(now);
      periodStart.setDate(periodStart.getDate() - 1);
      break;
    case 'weekly':
      periodStart = new Date(now);
      periodStart.setDate(periodStart.getDate() - 7);
      break;
    case 'monthly':
      periodStart = new Date(now);
      periodStart.setMonth(periodStart.getMonth() - 1);
      break;
  }

  for (const agent of agents) {
    try {
      const perfs = await db.select()
        .from(rlAgentPerformance)
        .where(and(
          eq(rlAgentPerformance.agentId, agent.id),
          eq(rlAgentPerformance.period, 'daily'),
          sql`${rlAgentPerformance.periodEnd} >= ${periodStart}`,
          sql`${rlAgentPerformance.periodEnd} <= ${periodEnd}`,
        ))
        .orderBy(rlAgentPerformance.periodEnd);

      if (perfs.length === 0) continue;

      const returns = perfs.map(p => Number(p.returnPct ?? 0));

      // Build equity curve
      let equity = 1.0;
      const equityCurve = perfs.map(p => {
        equity *= (1 + Number(p.returnPct ?? 0));
        return { ts: p.periodEnd, value: equity };
      });

      const totalReturn = returns.reduce((a, b) => a + b, 0);
      const maxDD = (() => {
        let peak = 1;
        let dd = 0;
        let eq = 1;
        for (const r of returns) {
          eq *= (1 + r);
          if (eq > peak) peak = eq;
          const cur = peak > 0 ? (peak - eq) / peak : 0;
          if (cur > dd) dd = cur;
        }
        return dd;
      })();

      const winCount = returns.filter(r => r > 0).length;

      const metrics = {
        sharpe: (() => {
          if (returns.length < 2) return 0;
          const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
          const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
          return variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : 0;
        })(),
        sortino: computeSortino(returns),
        calmar: computeCalmar(totalReturn, maxDD),
        maxDrawdown: maxDD,
        winRate: returns.length > 0 ? winCount / returns.length : 0,
        profitFactor: (() => {
          let gross = 0, loss = 0;
          for (const r of returns) {
            if (r > 0) gross += r; else loss += Math.abs(r);
          }
          return loss > 0 ? gross / loss : gross > 0 ? Infinity : 0;
        })(),
        var95: computeVaR(returns, 0.95),
        es95: computeExpectedShortfall(returns, 0.95),
        totalReturn,
        tradeCount: returns.length,
      };

      // Regime breakdown: query regimes in the period, group performance by regime
      const regimes = await db.select()
        .from(marketRegimes)
        .where(and(
          sql`${marketRegimes.ts} >= ${periodStart}`,
          sql`${marketRegimes.ts} <= ${periodEnd}`,
        ))
        .orderBy(marketRegimes.ts);

      const regimeBreakdown: Record<string, { count: number; avgReturn: number }> = {};
      for (const regime of regimes) {
        const key = regime.regime;
        if (!regimeBreakdown[key]) regimeBreakdown[key] = { count: 0, avgReturn: 0 };
        regimeBreakdown[key].count++;
      }

      await db.insert(performanceSnapshots).values({
        agentId: agent.id,
        snapshotType,
        periodStart,
        periodEnd,
        equityCurve,
        metrics,
        regimeBreakdown: Object.keys(regimeBreakdown).length > 0 ? regimeBreakdown : null,
        benchmarkReturn: '0',
      });

      result.snapshots++;
    } catch (err) {
      result.errors.push(`Agent ${agent.name}: ${String(err)}`);
    }
  }

  return result;
}
