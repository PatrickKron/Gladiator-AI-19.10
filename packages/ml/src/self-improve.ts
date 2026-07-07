/**
 * Self-Improvement Loop: the system learns from its own history.
 *
 * Auto-Evaluation Pipeline:
 * - Evaluate completed episodes/trades for what went right/wrong
 * - Track rolling performance (7d, 30d, 90d windows)
 * - Compare against buy-and-hold benchmark
 * - Identify most predictive features (MDI from Random Forest)
 * - Propose auto-retire/promote with human gate
 *
 * Model Retraining with Feedback:
 * - Trigger retrain when enough new labels accumulate (>100)
 * - Compare new vs current model (must beat by >2% accuracy)
 * - Keep version history with full metrics
 */

import {
  trainForest,
  evaluateForest,
  DEFAULT_HYPERPARAMS,
  type ForestModel,
  type ForestMetrics,
  type TrainingSample,
} from './random-forest.js';

export type RollingMetrics = {
  period: '7d' | '30d' | '90d';
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  profitFactor: number;
  totalReturn: number;
  tradeCount: number;
  avgHoldingBars: number;
};

export type AgentEvaluation = {
  agentId: string;
  rolling: RollingMetrics[];
  benchmarkComparison: {
    agentReturn: number;
    benchmarkReturn: number;
    excess: number;
  };
  featureImportance: { feature: string; importance: number }[];
  recommendation: 'promote' | 'retire' | 'keep' | 'retrain';
  reasons: string[];
  requiresHumanApproval: boolean;
};

export type ModelComparison = {
  currentVersion: number;
  newVersion: number;
  currentMetrics: ForestMetrics;
  newMetrics: ForestMetrics;
  improvement: number; // accuracy delta
  shouldPromote: boolean;
  reason: string;
};

export type RetrainResult = {
  retrained: boolean;
  newModel: ForestModel | null;
  newMetrics: ForestMetrics | null;
  comparison: ModelComparison | null;
  reason: string;
};

function computeSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(252);
}

function computeMaxDrawdown(equityCurve: number[]): number {
  if (equityCurve.length === 0) return 0;
  let peak = equityCurve[0]!;
  let maxDD = 0;
  for (const val of equityCurve) {
    if (val > peak) peak = val;
    const dd = peak > 0 ? (peak - val) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function computeProfitFactor(returns: number[]): number {
  let gross = 0;
  let loss = 0;
  for (const r of returns) {
    if (r > 0) gross += r;
    else loss += Math.abs(r);
  }
  return loss > 0 ? gross / loss : gross > 0 ? Infinity : 0;
}

/**
 * Compute rolling metrics for a given window from episode data.
 */
export function computeRollingMetrics(
  episodeReturns: number[],
  episodeWins: boolean[],
  holdingBars: number[],
  period: '7d' | '30d' | '90d',
  windowSize: number,
): RollingMetrics {
  const n = Math.min(episodeReturns.length, windowSize);
  const returns = episodeReturns.slice(-n);
  const wins = episodeWins.slice(-n);
  const bars = holdingBars.slice(-n);

  const winCount = wins.filter(Boolean).length;

  return {
    period,
    sharpeRatio: computeSharpe(returns),
    maxDrawdown: computeMaxDrawdown(
      returns.reduce<number[]>((curve, r) => {
        const prev = curve.length > 0 ? curve[curve.length - 1]! : 1;
        curve.push(prev * (1 + r));
        return curve;
      }, []),
    ),
    winRate: returns.length > 0 ? winCount / returns.length : 0,
    profitFactor: computeProfitFactor(returns),
    totalReturn: returns.reduce((a, b) => a + b, 0),
    tradeCount: returns.length,
    avgHoldingBars: bars.length > 0 ? bars.reduce((a, b) => a + b, 0) / bars.length : 0,
  };
}

/**
 * Evaluate an agent's performance and recommend action.
 *
 * Rules:
 * - Sharpe < 0 for 30d → recommend retire (human approval required)
 * - Sharpe > 1.5 for 30d → recommend promote (human approval required)
 * - Win rate < 35% for 30d → recommend retrain
 * - Profit factor < 0.8 for 30d → recommend retrain
 * - Otherwise → keep
 */
export function evaluateAgent(
  agentId: string,
  episodeReturns: number[],
  episodeWins: boolean[],
  holdingBars: number[],
  benchmarkReturns: number[],
  featureImportances: { feature: string; importance: number }[],
): AgentEvaluation {
  const rolling7d = computeRollingMetrics(episodeReturns, episodeWins, holdingBars, '7d', 7);
  const rolling30d = computeRollingMetrics(episodeReturns, episodeWins, holdingBars, '30d', 30);
  const rolling90d = computeRollingMetrics(episodeReturns, episodeWins, holdingBars, '90d', 90);

  const agentReturn = rolling30d.totalReturn;
  const benchmarkReturn = benchmarkReturns.slice(-30).reduce((a, b) => a + b, 0);

  const reasons: string[] = [];
  let recommendation: AgentEvaluation['recommendation'] = 'keep';
  let requiresHumanApproval = false;

  if (rolling30d.tradeCount < 5) {
    reasons.push(`Insufficient trades (${rolling30d.tradeCount}) for 30d evaluation`);
  } else if (rolling30d.sharpeRatio < 0) {
    recommendation = 'retire';
    requiresHumanApproval = true;
    reasons.push(`Negative Sharpe (${rolling30d.sharpeRatio.toFixed(2)}) over 30d`);
  } else if (rolling30d.sharpeRatio > 1.5) {
    recommendation = 'promote';
    requiresHumanApproval = true;
    reasons.push(`Strong Sharpe (${rolling30d.sharpeRatio.toFixed(2)}) over 30d`);
  }

  if (rolling30d.winRate < 0.35 && rolling30d.tradeCount >= 10) {
    if (recommendation === 'keep') recommendation = 'retrain';
    reasons.push(`Low win rate (${(rolling30d.winRate * 100).toFixed(1)}%) over 30d`);
  }

  if (rolling30d.profitFactor < 0.8 && rolling30d.tradeCount >= 10) {
    if (recommendation === 'keep') recommendation = 'retrain';
    reasons.push(`Low profit factor (${rolling30d.profitFactor.toFixed(2)}) over 30d`);
  }

  if (agentReturn < benchmarkReturn && rolling30d.tradeCount >= 10) {
    reasons.push(`Underperforming benchmark (agent: ${(agentReturn * 100).toFixed(2)}%, benchmark: ${(benchmarkReturn * 100).toFixed(2)}%)`);
  }

  if (reasons.length === 0) {
    reasons.push('Performance within acceptable range');
  }

  return {
    agentId,
    rolling: [rolling7d, rolling30d, rolling90d],
    benchmarkComparison: {
      agentReturn,
      benchmarkReturn,
      excess: agentReturn - benchmarkReturn,
    },
    featureImportance: featureImportances,
    recommendation,
    reasons,
    requiresHumanApproval,
  };
}

/**
 * Compare a newly trained model against the current active model.
 * Only promote if the new model beats the current by >2% accuracy.
 * This prevents model regression.
 */
export function compareModels(
  currentMetrics: ForestMetrics,
  newMetrics: ForestMetrics,
  currentVersion: number,
): ModelComparison {
  const improvement = newMetrics.accuracy - currentMetrics.accuracy;
  const MIN_IMPROVEMENT = 0.02; // 2% accuracy improvement required

  const shouldPromote = improvement > MIN_IMPROVEMENT;
  const reason = shouldPromote
    ? `New model accuracy ${(newMetrics.accuracy * 100).toFixed(1)}% beats current ${(currentMetrics.accuracy * 100).toFixed(1)}% by ${(improvement * 100).toFixed(1)}pp`
    : improvement > 0
      ? `Improvement ${(improvement * 100).toFixed(1)}pp below ${(MIN_IMPROVEMENT * 100).toFixed(0)}pp threshold`
      : `New model accuracy ${(newMetrics.accuracy * 100).toFixed(1)}% does not beat current ${(currentMetrics.accuracy * 100).toFixed(1)}%`;

  return {
    currentVersion,
    newVersion: currentVersion + 1,
    currentMetrics,
    newMetrics,
    improvement,
    shouldPromote,
    reason,
  };
}

/**
 * Retrain model with feedback loop.
 * Only deploys new model if it beats the current by >2%.
 */
export function retrainWithFeedback(
  samples: TrainingSample[],
  currentMetrics: ForestMetrics | null,
  currentVersion: number,
): RetrainResult {
  if (samples.length < 30) {
    return {
      retrained: false,
      newModel: null,
      newMetrics: null,
      comparison: null,
      reason: `Need ≥30 labeled samples, have ${samples.length}`,
    };
  }

  // 80/20 train/test split
  const splitIdx = Math.floor(samples.length * 0.8);
  const trainSet = samples.slice(0, splitIdx);
  const testSet = samples.slice(splitIdx);

  if (testSet.length < 5) {
    return {
      retrained: false,
      newModel: null,
      newMetrics: null,
      comparison: null,
      reason: `Test set too small (${testSet.length})`,
    };
  }

  const newModel = trainForest(trainSet, DEFAULT_HYPERPARAMS);
  const newMetrics = evaluateForest(newModel, testSet);

  if (!currentMetrics) {
    return {
      retrained: true,
      newModel,
      newMetrics,
      comparison: null,
      reason: 'First model — no comparison needed',
    };
  }

  const comparison = compareModels(currentMetrics, newMetrics, currentVersion);

  return {
    retrained: comparison.shouldPromote,
    newModel: comparison.shouldPromote ? newModel : null,
    newMetrics,
    comparison,
    reason: comparison.reason,
  };
}

/**
 * Compute VaR (Value at Risk) at a given confidence level.
 * Uses historical simulation (sorted returns, take percentile).
 */
export function computeVaR(returns: number[], confidence = 0.95): number {
  if (returns.length < 5) return 0;
  const sorted = [...returns].sort((a, b) => a - b);
  // Index of the (1-confidence) quantile
  const idx = Math.max(0, Math.round(sorted.length * (1 - confidence)) - 1);
  return Math.max(0, -sorted[idx]!);
}

/**
 * Compute Expected Shortfall (Conditional VaR).
 * Average of losses beyond VaR threshold.
 */
export function computeExpectedShortfall(returns: number[], confidence = 0.95): number {
  if (returns.length < 5) return 0;
  const sorted = [...returns].sort((a, b) => a - b);
  const cutoff = Math.floor(sorted.length * (1 - confidence));
  if (cutoff <= 0) return -sorted[0]!;
  const tail = sorted.slice(0, cutoff);
  const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
  return -avg;
}

/**
 * Compute Sortino ratio (downside-only volatility).
 */
export function computeSortino(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const downsideReturns = returns.filter(r => r < 0);
  if (downsideReturns.length === 0) return mean > 0 ? Infinity : 0;
  const downsideVariance = downsideReturns.reduce((s, r) => s + r * r, 0) / downsideReturns.length;
  const downsideDev = Math.sqrt(downsideVariance);
  if (downsideDev === 0) return 0;
  return (mean / downsideDev) * Math.sqrt(252);
}

/**
 * Compute Calmar ratio (return / max drawdown).
 */
export function computeCalmar(totalReturn: number, maxDrawdown: number): number {
  if (maxDrawdown <= 0) return totalReturn > 0 ? Infinity : 0;
  return totalReturn / maxDrawdown;
}
