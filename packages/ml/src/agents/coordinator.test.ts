import { describe, it, expect } from 'vitest';
import {
  STRATEGY_TYPES,
  computeHRPWeights,
  aggregateSignals,
  evaluatePromotion,
  getFeatureSubset,
  type AgentPerformanceRecord,
  type SubAgentSignal,
  type PortfolioAllocation,
} from './coordinator.js';

function makePerf(id: string, returns: number[], sharpe = 1.0, maxDD = 0.1, winRate = 0.55): AgentPerformanceRecord {
  return {
    agentId: id,
    returns,
    sharpeRatio: sharpe,
    maxDrawdown: maxDD,
    winRate,
  };
}

// Generates correlated return series
function makeReturns(n: number, seed: number, drift = 0): number[] {
  let s = seed;
  const rng = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s / 0x7fffffff - 0.5) * 0.02 + drift; };
  return Array.from({ length: n }, rng);
}

describe('STRATEGY_TYPES', () => {
  it('has 5 strategy types', () => {
    expect(STRATEGY_TYPES).toHaveLength(5);
    expect(STRATEGY_TYPES).toContain('momentum');
    expect(STRATEGY_TYPES).toContain('mean_reversion');
    expect(STRATEGY_TYPES).toContain('breakout');
    expect(STRATEGY_TYPES).toContain('volatility_regime');
    expect(STRATEGY_TYPES).toContain('trend_following');
  });
});

describe('computeHRPWeights', () => {
  it('returns empty for no agents', () => {
    expect(computeHRPWeights([])).toEqual([]);
  });

  it('gives 100% to single agent', () => {
    const allocs = computeHRPWeights([makePerf('a1', makeReturns(50, 1))]);
    expect(allocs).toHaveLength(1);
    expect(allocs[0]!.weight).toBeCloseTo(1, 5);
  });

  it('allocates across multiple agents, weights sum to 1', () => {
    const perfs = [
      makePerf('a1', makeReturns(50, 1, 0.001)),
      makePerf('a2', makeReturns(50, 2, -0.001)),
      makePerf('a3', makeReturns(50, 3, 0.002)),
    ];
    const allocs = computeHRPWeights(perfs);
    expect(allocs).toHaveLength(3);

    const totalWeight = allocs.reduce((sum, a) => sum + a.weight, 0);
    expect(totalWeight).toBeCloseTo(1, 5);

    // All weights should be positive
    for (const a of allocs) {
      expect(a.weight).toBeGreaterThan(0);
      expect(a.weight).toBeLessThanOrEqual(1);
    }
  });

  it('gives more weight to lower-variance agents', () => {
    // Agent 1: low variance, Agent 2: high variance
    const low = Array.from({ length: 50 }, (_, i) => Math.sin(i) * 0.001);
    const high = Array.from({ length: 50 }, (_, i) => Math.sin(i) * 0.05);
    const perfs = [
      makePerf('stable', low),
      makePerf('volatile', high),
    ];
    const allocs = computeHRPWeights(perfs);
    const stableWeight = allocs.find(a => a.agentId === 'stable')!.weight;
    const volatileWeight = allocs.find(a => a.agentId === 'volatile')!.weight;
    expect(stableWeight).toBeGreaterThan(volatileWeight);
  });

  it('handles agents with insufficient return history', () => {
    const perfs = [
      makePerf('new', [0.01, 0.02]), // too few returns
      makePerf('experienced', makeReturns(50, 1)),
    ];
    const allocs = computeHRPWeights(perfs);
    const newAgent = allocs.find(a => a.agentId === 'new');
    expect(newAgent).toBeDefined();
    expect(newAgent!.weight).toBe(0); // not enough history
  });

  it('falls back to equal weights when all agents have insufficient history', () => {
    const perfs = [
      makePerf('a1', [0.01]),
      makePerf('a2', [0.02]),
    ];
    const allocs = computeHRPWeights(perfs);
    expect(allocs[0]!.weight).toBeCloseTo(0.5, 5);
    expect(allocs[1]!.weight).toBeCloseTo(0.5, 5);
  });
});

describe('aggregateSignals', () => {
  it('returns null for empty signals', () => {
    expect(aggregateSignals([], [])).toBeNull();
  });

  it('aggregates weighted signals correctly', () => {
    const signals: SubAgentSignal[] = [
      { agentId: 'a1', symbol: 'BTCUSDT', direction: 'long', strength: 0.8, confidence: 0.9 },
      { agentId: 'a2', symbol: 'BTCUSDT', direction: 'short', strength: -0.3, confidence: 0.7 },
    ];
    const allocs: PortfolioAllocation[] = [
      { agentId: 'a1', weight: 0.7, riskContribution: 0.6 },
      { agentId: 'a2', weight: 0.3, riskContribution: 0.4 },
    ];
    const result = aggregateSignals(signals, allocs);
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe('BTCUSDT');
    expect(result!.direction).toBe('long'); // net long
    expect(result!.strength).toBeGreaterThan(0);
    expect(result!.contributions).toHaveLength(2);
  });

  it('returns flat for balanced signals', () => {
    const signals: SubAgentSignal[] = [
      { agentId: 'a1', symbol: 'ETHUSDT', direction: 'long', strength: 0.5, confidence: 0.8 },
      { agentId: 'a2', symbol: 'ETHUSDT', direction: 'short', strength: -0.5, confidence: 0.8 },
    ];
    const allocs: PortfolioAllocation[] = [
      { agentId: 'a1', weight: 0.5, riskContribution: 0.5 },
      { agentId: 'a2', weight: 0.5, riskContribution: 0.5 },
    ];
    const result = aggregateSignals(signals, allocs);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('flat');
  });
});

describe('evaluatePromotion', () => {
  it('paper agent meets criteria → eligible for sandbox', () => {
    const perf = makePerf('a1', makeReturns(200, 1), 0.8, 0.10, 0.52);
    const result = evaluatePromotion('paper', perf, 150);
    expect(result.eligible).toBe(true);
    expect(result.targetStatus).toBe('sandbox');
  });

  it('paper agent fails Sharpe → not eligible', () => {
    const perf = makePerf('a1', makeReturns(200, 1), 0.3, 0.10, 0.52);
    const result = evaluatePromotion('paper', perf, 150);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some(r => r.includes('Sharpe'))).toBe(true);
  });

  it('paper agent too few trades → not eligible', () => {
    const perf = makePerf('a1', makeReturns(200, 1), 0.8, 0.10, 0.52);
    const result = evaluatePromotion('paper', perf, 50);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some(r => r.includes('Trades'))).toBe(true);
  });

  it('sandbox → live has stricter criteria', () => {
    const perf = makePerf('a1', makeReturns(200, 1), 0.8, 0.10, 0.52);
    const result = evaluatePromotion('sandbox', perf, 600);
    expect(result.eligible).toBe(false); // Sharpe 0.8 < 1.0 required for live
    expect(result.targetStatus).toBe('live');
  });

  it('sandbox → live passes with strong performance', () => {
    const perf = makePerf('a1', makeReturns(200, 1), 1.5, 0.08, 0.55);
    const result = evaluatePromotion('sandbox', perf, 600);
    expect(result.eligible).toBe(true);
    expect(result.targetStatus).toBe('live');
  });

  it('live/retired agents are never eligible', () => {
    const perf = makePerf('a1', makeReturns(200, 1), 2.0, 0.05, 0.70);
    expect(evaluatePromotion('live', perf, 1000).eligible).toBe(false);
    expect(evaluatePromotion('retired', perf, 1000).eligible).toBe(false);
  });
});

describe('getFeatureSubset', () => {
  it('returns non-empty subset for each strategy', () => {
    for (const st of STRATEGY_TYPES) {
      const subset = getFeatureSubset(st);
      expect(subset.length).toBeGreaterThan(0);
      expect(subset.every(f => typeof f === 'string')).toBe(true);
    }
  });

  it('strategy subsets differ', () => {
    const momentum = getFeatureSubset('momentum');
    const meanRev = getFeatureSubset('mean_reversion');
    // Should have at least some different features
    const diff = momentum.filter(f => !meanRev.includes(f));
    expect(diff.length).toBeGreaterThan(0);
  });
});
