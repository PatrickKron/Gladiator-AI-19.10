/**
 * CTDE Coordinator with HRP (Hierarchical Risk Parity).
 *
 * Multi-Agent Architecture:
 * - Multiple sub-agents, each with a distinct strategy
 * - Centralized Training: agents share global state during training
 * - Decentralized Execution: each agent acts on local observations only
 * - Coordinator aggregates signals using HRP portfolio allocation
 *
 * HRP (Hierarchical Risk Parity) — López de Prado:
 * 1. Compute correlation matrix from agent return series
 * 2. Cluster agents by correlation (single-linkage)
 * 3. Allocate risk inversely to cluster variance
 * 4. Result: diversified allocation that doesn't need matrix inversion
 *    (unlike Markowitz, no ill-conditioned covariance inversion)
 */

export const STRATEGY_TYPES = [
  'momentum',
  'mean_reversion',
  'breakout',
  'volatility_regime',
  'trend_following',
] as const;

export type StrategyType = typeof STRATEGY_TYPES[number];

export type SubAgentConfig = {
  id: string;
  name: string;
  strategyType: StrategyType;
  riskBudget: number;    // fraction of total capital (0–1)
  featureSubset?: string[]; // which features this agent focuses on
  lookbackBars: number;  // how far back this agent looks
};

export type SubAgentSignal = {
  agentId: string;
  symbol: string;
  direction: 'long' | 'short' | 'flat';
  strength: number;     // -1 to +1 (negative = short, positive = long)
  confidence: number;   // 0 to 1
};

export type AgentPerformanceRecord = {
  agentId: string;
  returns: number[];    // historical returns series
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
};

export type PortfolioAllocation = {
  agentId: string;
  weight: number;       // 0–1, sum to 1
  riskContribution: number;
};

export type CoordinatorSignal = {
  symbol: string;
  direction: 'long' | 'short' | 'flat';
  strength: number;
  confidence: number;
  contributions: { agentId: string; weight: number; signal: number }[];
};

/**
 * Compute correlation matrix from agent return series.
 */
function correlationMatrix(returnSeries: number[][]): number[][] {
  const n = returnSeries.length;
  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0) as number[]);

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      if (i === j) {
        matrix[i]![j] = 1;
        continue;
      }
      const corr = pearsonCorrelation(returnSeries[i]!, returnSeries[j]!);
      matrix[i]![j] = corr;
      matrix[j]![i] = corr;
    }
  }

  return matrix;
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i]!;
    sumY += y[i]!;
    sumXY += x[i]! * y[i]!;
    sumX2 += x[i]! * x[i]!;
    sumY2 += y[i]! * y[i]!;
  }

  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return den > 0 ? num / den : 0;
}

/**
 * Compute distance matrix from correlations: d(i,j) = sqrt(0.5 * (1 - corr(i,j)))
 */
function distanceMatrix(corr: number[][]): number[][] {
  return corr.map(row =>
    row.map(c => Math.sqrt(0.5 * (1 - Math.max(-1, Math.min(1, c))))),
  );
}

/**
 * Single-linkage hierarchical clustering.
 * Returns merge order as pairs of cluster indices.
 */
function singleLinkageClustering(dist: number[][]): [number, number][] {
  const n = dist.length;
  if (n <= 1) return [];

  const active = new Set(Array.from({ length: n }, (_, i) => i));
  const merges: [number, number][] = [];

  // Working copy of distances
  const d = dist.map(row => [...row]);

  let nextCluster = n;

  while (active.size > 1) {
    let minDist = Infinity;
    let minI = -1;
    let minJ = -1;

    const activeArr = [...active];
    for (let ai = 0; ai < activeArr.length; ai++) {
      for (let aj = ai + 1; aj < activeArr.length; aj++) {
        const i = activeArr[ai]!;
        const j = activeArr[aj]!;
        const dij = d[i]?.[j] ?? Infinity;
        if (dij < minDist) {
          minDist = dij;
          minI = i;
          minJ = j;
        }
      }
    }

    if (minI === -1) break;

    merges.push([minI, minJ]);

    // Merge: create new cluster with min distance to others
    const newIdx = nextCluster++;
    active.delete(minI);
    active.delete(minJ);

    // Expand distance matrix
    while (d.length <= newIdx) {
      d.push(new Array(d.length + 1).fill(Infinity) as number[]);
    }
    for (const row of d) {
      while (row.length <= newIdx) row.push(Infinity);
    }

    for (const k of active) {
      const dk = Math.min(d[minI]?.[k] ?? Infinity, d[minJ]?.[k] ?? Infinity);
      d[newIdx]![k] = dk;
      d[k]![newIdx] = dk;
    }
    d[newIdx]![newIdx] = 0;

    active.add(newIdx);
  }

  return merges;
}

/**
 * Quasi-diagonal reordering from HRP clustering.
 * Reorders indices so correlated agents are adjacent.
 */
function getQuasiDiagOrder(merges: [number, number][], n: number): number[] {
  if (n <= 1) return n === 1 ? [0] : [];

  // Build cluster → members mapping
  const members = new Map<number, number[]>();
  for (let i = 0; i < n; i++) members.set(i, [i]);

  let nextId = n;
  for (const [a, b] of merges) {
    const ma = members.get(a) ?? [a];
    const mb = members.get(b) ?? [b];
    members.set(nextId, [...ma, ...mb]);
    nextId++;
  }

  // The last cluster contains all items in quasi-diagonal order
  return members.get(nextId - 1) ?? Array.from({ length: n }, (_, i) => i);
}

/**
 * Compute variance for a set of agent return series.
 */
function clusterVariance(returnSeries: number[][], indices: number[]): number {
  if (indices.length === 0) return 0;
  if (indices.length === 1) {
    const returns = returnSeries[indices[0]!]!;
    if (returns.length < 2) return 1;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    return returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  }

  // Portfolio variance = average variance (assuming equal weight within cluster)
  let totalVar = 0;
  for (const idx of indices) {
    const returns = returnSeries[idx]!;
    if (returns.length < 2) { totalVar += 1; continue; }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const v = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
    totalVar += v;
  }
  return totalVar / indices.length;
}

/**
 * HRP (Hierarchical Risk Parity) weight allocation.
 *
 * 1. Cluster agents by return correlation
 * 2. Reorder by quasi-diagonal
 * 3. Bisect and allocate inversely to cluster variance
 */
export function computeHRPWeights(performances: AgentPerformanceRecord[]): PortfolioAllocation[] {
  const n = performances.length;

  if (n === 0) return [];
  if (n === 1) {
    return [{ agentId: performances[0]!.agentId, weight: 1, riskContribution: 1 }];
  }

  // Filter agents with sufficient return history
  const validPerfs = performances.filter(p => p.returns.length >= 5);
  if (validPerfs.length === 0) {
    // Equal weight fallback
    const w = 1 / n;
    return performances.map(p => ({ agentId: p.agentId, weight: w, riskContribution: w }));
  }

  const returnSeries = validPerfs.map(p => p.returns);

  // Step 1: Correlation → Distance → Clustering
  const corr = correlationMatrix(returnSeries);
  const dist = distanceMatrix(corr);
  const merges = singleLinkageClustering(dist);
  const order = getQuasiDiagOrder(merges, validPerfs.length);

  // Step 2: Recursive bisection with inverse-variance allocation
  const weights = new Array(validPerfs.length).fill(1) as number[];
  bisect(returnSeries, order, weights);

  // Normalize
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const normalizedWeights = totalWeight > 0
    ? weights.map(w => w / totalWeight)
    : weights.map(() => 1 / validPerfs.length);

  // Compute risk contributions
  const variances = returnSeries.map(rs => {
    if (rs.length < 2) return 1;
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    return rs.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (rs.length - 1);
  });
  const totalRisk = normalizedWeights.reduce((sum, w, i) => sum + w * Math.sqrt(variances[i]!), 0);

  const allocations: PortfolioAllocation[] = validPerfs.map((p, i) => ({
    agentId: p.agentId,
    weight: normalizedWeights[i]!,
    riskContribution: totalRisk > 0
      ? (normalizedWeights[i]! * Math.sqrt(variances[i]!)) / totalRisk
      : 1 / validPerfs.length,
  }));

  // Add zero-weight entries for agents without enough history
  const validIds = new Set(validPerfs.map(p => p.agentId));
  for (const p of performances) {
    if (!validIds.has(p.agentId)) {
      allocations.push({ agentId: p.agentId, weight: 0, riskContribution: 0 });
    }
  }

  return allocations;
}

function bisect(returnSeries: number[][], indices: number[], weights: number[]): void {
  if (indices.length <= 1) return;

  const mid = Math.floor(indices.length / 2);
  const left = indices.slice(0, mid);
  const right = indices.slice(mid);

  const leftVar = clusterVariance(returnSeries, left);
  const rightVar = clusterVariance(returnSeries, right);
  const totalVar = leftVar + rightVar;

  // Inverse-variance allocation
  const leftWeight = totalVar > 0 ? 1 - leftVar / totalVar : 0.5;
  const rightWeight = 1 - leftWeight;

  for (const idx of left) weights[idx]! *= leftWeight;
  for (const idx of right) weights[idx]! *= rightWeight;

  bisect(returnSeries, left, weights);
  bisect(returnSeries, right, weights);
}

/**
 * Aggregate sub-agent signals using HRP weights.
 * Final position = weighted sum of agent signal strengths.
 */
export function aggregateSignals(
  signals: SubAgentSignal[],
  allocations: PortfolioAllocation[],
): CoordinatorSignal | null {
  if (signals.length === 0) return null;

  const symbol = signals[0]!.symbol;
  const weightMap = new Map(allocations.map(a => [a.agentId, a.weight]));

  let weightedStrength = 0;
  let totalWeight = 0;
  let weightedConfidence = 0;
  const contributions: CoordinatorSignal['contributions'] = [];

  for (const sig of signals) {
    const weight = weightMap.get(sig.agentId) ?? 0;
    const signalValue = sig.direction === 'flat' ? 0 : sig.strength;
    weightedStrength += weight * signalValue;
    weightedConfidence += weight * sig.confidence;
    totalWeight += weight;

    contributions.push({
      agentId: sig.agentId,
      weight,
      signal: signalValue,
    });
  }

  if (totalWeight <= 0) return null;

  const strength = weightedStrength / totalWeight;
  const confidence = weightedConfidence / totalWeight;

  return {
    symbol,
    direction: strength > 0.05 ? 'long' : strength < -0.05 ? 'short' : 'flat',
    strength,
    confidence,
    contributions,
  };
}

/**
 * Evaluate whether an agent should be promoted based on rolling performance.
 * Paper → Sandbox: Sharpe > 0.5, maxDrawdown < 20%, >= 100 trades, winRate > 45%
 * Sandbox → Live: Sharpe > 1.0, maxDrawdown < 15%, >= 500 trades, winRate > 50%
 */
export function evaluatePromotion(
  currentStatus: 'paper' | 'sandbox' | 'live' | 'retired',
  performance: AgentPerformanceRecord,
  totalTrades: number,
): { eligible: boolean; targetStatus: string; reasons: string[] } {
  const reasons: string[] = [];

  if (currentStatus === 'live' || currentStatus === 'retired') {
    return { eligible: false, targetStatus: currentStatus, reasons: ['Already live or retired'] };
  }

  if (currentStatus === 'paper') {
    const minSharpe = 0.5;
    const maxDD = 0.20;
    const minTrades = 100;
    const minWinRate = 0.45;

    if (performance.sharpeRatio < minSharpe) reasons.push(`Sharpe ${performance.sharpeRatio.toFixed(2)} < ${minSharpe}`);
    if (performance.maxDrawdown > maxDD) reasons.push(`Max Drawdown ${(performance.maxDrawdown * 100).toFixed(1)}% > ${(maxDD * 100).toFixed(0)}%`);
    if (totalTrades < minTrades) reasons.push(`Trades ${totalTrades} < ${minTrades}`);
    if (performance.winRate < minWinRate) reasons.push(`Win Rate ${(performance.winRate * 100).toFixed(1)}% < ${(minWinRate * 100).toFixed(0)}%`);

    return {
      eligible: reasons.length === 0,
      targetStatus: 'sandbox',
      reasons: reasons.length > 0 ? reasons : ['All paper criteria met'],
    };
  }

  // sandbox → live
  const minSharpe = 1.0;
  const maxDD = 0.15;
  const minTrades = 500;
  const minWinRate = 0.50;

  if (performance.sharpeRatio < minSharpe) reasons.push(`Sharpe ${performance.sharpeRatio.toFixed(2)} < ${minSharpe}`);
  if (performance.maxDrawdown > maxDD) reasons.push(`Max Drawdown ${(performance.maxDrawdown * 100).toFixed(1)}% > ${(maxDD * 100).toFixed(0)}%`);
  if (totalTrades < minTrades) reasons.push(`Trades ${totalTrades} < ${minTrades}`);
  if (performance.winRate < minWinRate) reasons.push(`Win Rate ${(performance.winRate * 100).toFixed(1)}% < ${(minWinRate * 100).toFixed(0)}%`);

  return {
    eligible: reasons.length === 0,
    targetStatus: 'live',
    reasons: reasons.length > 0 ? reasons : ['All sandbox criteria met'],
  };
}

/**
 * Apply regime-based weight adjustments to HRP allocations.
 * Multiplies each agent's weight by its strategy type's regime multiplier,
 * then re-normalizes to sum to 1.
 */
export function applyRegimeWeights(
  allocations: PortfolioAllocation[],
  agentStrategies: Map<string, StrategyType>,
  regimeWeights: Record<string, number>,
): PortfolioAllocation[] {
  const adjusted = allocations.map(a => {
    const strategy = agentStrategies.get(a.agentId);
    const multiplier = strategy ? (regimeWeights[strategy] ?? 1) : 1;
    return { ...a, weight: a.weight * multiplier };
  });

  const total = adjusted.reduce((s, a) => s + a.weight, 0);
  if (total <= 0) return allocations;

  return adjusted.map(a => ({ ...a, weight: a.weight / total }));
}

/**
 * Default feature subsets for each strategy type.
 * Each agent focuses on the features most relevant to its strategy.
 */
export function getFeatureSubset(strategyType: StrategyType): string[] {
  switch (strategyType) {
    case 'momentum':
      return ['rsi14', 'macdLine', 'macdHistogram', 'momentum10', 'momentum20', 'roc5', 'volumeRatio5'];
    case 'mean_reversion':
      return ['bollingerPosition', 'bollingerWidth', 'rsi14', 'ema20Dist', 'ema50Dist', 'return1', 'return5'];
    case 'breakout':
      return ['atr14', 'atrPct', 'volumeRatio5', 'volumeRatio20', 'volatility5', 'bollingerWidth', 'return1'];
    case 'volatility_regime':
      return ['volatility5', 'volatility20', 'atr14', 'atrPct', 'bollingerWidth', 'regime', 'trendStrength'];
    case 'trend_following':
      return ['ema20Dist', 'ema50Dist', 'ema200Dist', 'emaCross2050', 'trendStrength', 'regime', 'macdLine'];
  }
}
