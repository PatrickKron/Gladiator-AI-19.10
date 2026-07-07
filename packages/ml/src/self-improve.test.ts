import { describe, it, expect } from 'vitest';
import {
  computeRollingMetrics,
  evaluateAgent,
  compareModels,
  retrainWithFeedback,
  computeVaR,
  computeExpectedShortfall,
  computeSortino,
  computeCalmar,
} from './self-improve.js';
import type { ForestMetrics, TrainingSample } from './random-forest.js';

function makeSamples(count: number, winRate: number): TrainingSample[] {
  const samples: TrainingSample[] = [];
  let seed = 123;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < count; i++) {
    const features = Array.from({ length: 25 }, () => rng());
    const label = rng() < winRate ? 1 : 0;
    samples.push({ features, label: label as 0 | 1 });
  }
  return samples;
}

describe('computeRollingMetrics', () => {
  it('computes correct win rate', () => {
    const returns = [0.01, -0.02, 0.03, 0.01, -0.01];
    const wins = [true, false, true, true, false];
    const bars = [10, 8, 12, 5, 7];
    const m = computeRollingMetrics(returns, wins, bars, '7d', 10);
    expect(m.winRate).toBeCloseTo(0.6); // 3/5
    expect(m.tradeCount).toBe(5);
    expect(m.period).toBe('7d');
  });

  it('computes positive Sharpe for consistently profitable returns', () => {
    const returns = Array.from({ length: 30 }, () => 0.01); // all positive
    const wins = returns.map(() => true);
    const bars = returns.map(() => 10);
    const m = computeRollingMetrics(returns, wins, bars, '30d', 30);
    expect(m.sharpeRatio).toBeGreaterThan(0);
    expect(m.winRate).toBe(1);
  });

  it('computes zero metrics for empty data', () => {
    const m = computeRollingMetrics([], [], [], '7d', 10);
    expect(m.sharpeRatio).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.tradeCount).toBe(0);
  });

  it('truncates to window size', () => {
    const returns = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.005));
    const wins = returns.map(r => r > 0);
    const bars = returns.map(() => 5);
    const m = computeRollingMetrics(returns, wins, bars, '7d', 7);
    expect(m.tradeCount).toBe(7);
  });

  it('computes profit factor correctly', () => {
    const returns = [0.10, -0.05, 0.08, -0.03];
    const wins = returns.map(r => r > 0);
    const bars = returns.map(() => 10);
    const m = computeRollingMetrics(returns, wins, bars, '30d', 30);
    expect(m.profitFactor).toBeCloseTo(0.18 / 0.08); // 2.25
  });

  it('computes max drawdown correctly', () => {
    const returns = [0.10, -0.05, -0.05, 0.03, -0.10];
    const wins = returns.map(r => r > 0);
    const bars = returns.map(() => 5);
    const m = computeRollingMetrics(returns, wins, bars, '30d', 30);
    expect(m.maxDrawdown).toBeGreaterThan(0);
  });
});

describe('evaluateAgent', () => {
  it('recommends keep for acceptable performance', () => {
    // Moderate performance: very slight positive bias with large swings → Sharpe ~0.5-1.0
    // mean ≈ +0.001, std ≈ 0.030 → annualized Sharpe ≈ (0.001/0.030)*sqrt(252) ≈ 0.53
    const returns = [
      0.03, -0.02, 0.01, -0.03, 0.04, -0.04, 0.02, -0.01, 0.03, -0.03,
      0.02, -0.01, 0.01, -0.02, 0.03, -0.03, 0.04, -0.02, 0.01, -0.01,
      0.02, -0.03, 0.03, -0.01, 0.02, -0.02, 0.01, -0.01, 0.02, -0.01,
    ];
    const wins = returns.map(r => r > 0);
    const bars = returns.map(() => 10);
    const benchmark = returns.map(() => 0.002);
    const features = [{ feature: 'rsi14', importance: 0.3 }, { feature: 'macdLine', importance: 0.2 }];

    const eval_ = evaluateAgent('agent-1', returns, wins, bars, benchmark, features);
    expect(eval_.agentId).toBe('agent-1');
    expect(eval_.rolling.length).toBe(3);
    expect(eval_.recommendation).toBe('keep');
    expect(eval_.requiresHumanApproval).toBe(false);
  });

  it('recommends retire for negative Sharpe', () => {
    const returns = Array.from({ length: 30 }, () => -0.02); // all losses
    const wins = returns.map(() => false);
    const bars = returns.map(() => 10);
    const benchmark = returns.map(() => 0.001);

    const eval_ = evaluateAgent('agent-bad', returns, wins, bars, benchmark, []);
    expect(eval_.recommendation).toBe('retire');
    expect(eval_.requiresHumanApproval).toBe(true);
    expect(eval_.reasons.some(r => r.includes('Negative Sharpe'))).toBe(true);
  });

  it('recommends retrain for low win rate', () => {
    // Win rate ~20%: 2 wins out of 10
    const returns = Array.from({ length: 20 }, (_, i) => (i < 4 ? 0.03 : -0.008));
    const wins = returns.map(r => r > 0);
    const bars = returns.map(() => 10);
    const benchmark = returns.map(() => 0.001);

    const eval_ = evaluateAgent('agent-weak', returns, wins, bars, benchmark, []);
    // Low win rate or negative Sharpe should trigger retrain or retire
    expect(['retrain', 'retire']).toContain(eval_.recommendation);
  });

  it('provides benchmark comparison', () => {
    const returns = Array.from({ length: 30 }, () => 0.01);
    const wins = returns.map(() => true);
    const bars = returns.map(() => 5);
    const benchmark = Array.from({ length: 30 }, () => 0.005);

    const eval_ = evaluateAgent('agent-x', returns, wins, bars, benchmark, []);
    expect(eval_.benchmarkComparison.agentReturn).toBeGreaterThan(eval_.benchmarkComparison.benchmarkReturn);
    expect(eval_.benchmarkComparison.excess).toBeGreaterThan(0);
  });

  it('handles insufficient trades gracefully', () => {
    const eval_ = evaluateAgent('agent-new', [0.01, 0.02], [true, true], [5, 8], [0.001], []);
    expect(eval_.reasons.some(r => r.includes('Insufficient'))).toBe(true);
  });
});

describe('compareModels', () => {
  it('promotes when improvement exceeds 2%', () => {
    const current: ForestMetrics = { accuracy: 0.60, precision: 0.58, recall: 0.62, f1: 0.60, auc: 0.65 };
    const newer: ForestMetrics = { accuracy: 0.65, precision: 0.63, recall: 0.67, f1: 0.65, auc: 0.70 };
    const comp = compareModels(current, newer, 1);
    expect(comp.shouldPromote).toBe(true);
    expect(comp.improvement).toBeCloseTo(0.05);
    expect(comp.newVersion).toBe(2);
  });

  it('rejects when improvement is below threshold', () => {
    const current: ForestMetrics = { accuracy: 0.60, precision: 0.58, recall: 0.62, f1: 0.60, auc: 0.65 };
    const newer: ForestMetrics = { accuracy: 0.61, precision: 0.59, recall: 0.63, f1: 0.61, auc: 0.66 };
    const comp = compareModels(current, newer, 1);
    expect(comp.shouldPromote).toBe(false);
    expect(comp.reason).toContain('below');
  });

  it('rejects when new model is worse', () => {
    const current: ForestMetrics = { accuracy: 0.65, precision: 0.63, recall: 0.67, f1: 0.65, auc: 0.70 };
    const newer: ForestMetrics = { accuracy: 0.60, precision: 0.58, recall: 0.62, f1: 0.60, auc: 0.65 };
    const comp = compareModels(current, newer, 3);
    expect(comp.shouldPromote).toBe(false);
    expect(comp.improvement).toBeLessThan(0);
  });
});

describe('retrainWithFeedback', () => {
  it('returns not retrained for insufficient samples', () => {
    const result = retrainWithFeedback(makeSamples(10, 0.6), null, 0);
    expect(result.retrained).toBe(false);
    expect(result.reason).toContain('30');
  });

  it('trains first model without comparison', () => {
    const result = retrainWithFeedback(makeSamples(100, 0.6), null, 0);
    expect(result.retrained).toBe(true);
    expect(result.newModel).not.toBeNull();
    expect(result.newMetrics).not.toBeNull();
    expect(result.comparison).toBeNull();
    expect(result.reason).toContain('First model');
  });

  it('compares against current when current metrics exist', () => {
    const currentMetrics: ForestMetrics = { accuracy: 0.5, precision: 0.5, recall: 0.5, f1: 0.5, auc: 0.5 };
    const result = retrainWithFeedback(makeSamples(100, 0.6), currentMetrics, 1);
    expect(result.comparison).not.toBeNull();
    expect(result.newMetrics).not.toBeNull();
  });
});

describe('computeVaR', () => {
  it('returns correct 95% VaR for known distribution', () => {
    // 100 returns: 95 at +1%, 5 at -5%
    const returns = [
      ...Array.from({ length: 95 }, () => 0.01),
      ...Array.from({ length: 5 }, () => -0.05),
    ];
    const var95 = computeVaR(returns, 0.95);
    expect(var95).toBeGreaterThan(0);
    expect(var95).toBeCloseTo(0.05, 1);
  });

  it('returns 0 for insufficient data', () => {
    expect(computeVaR([0.01, -0.02], 0.95)).toBe(0);
  });

  it('is positive for losses', () => {
    const returns = [-0.01, -0.02, -0.03, -0.01, -0.02, 0.01, 0.02, 0.01, 0.03, 0.01];
    expect(computeVaR(returns)).toBeGreaterThanOrEqual(0);
  });
});

describe('computeExpectedShortfall', () => {
  it('is greater than or equal to VaR', () => {
    const returns = Array.from({ length: 100 }, (_, i) => (i < 10 ? -(i + 1) * 0.01 : 0.005));
    const var95 = computeVaR(returns, 0.95);
    const es95 = computeExpectedShortfall(returns, 0.95);
    expect(es95).toBeGreaterThanOrEqual(var95);
  });

  it('returns 0 for insufficient data', () => {
    expect(computeExpectedShortfall([0.01], 0.95)).toBe(0);
  });
});

describe('computeSortino', () => {
  it('is higher than Sharpe for positive skew', () => {
    // Mostly positive returns with few small negatives
    const returns = [0.05, 0.03, 0.04, -0.01, 0.06, 0.02, -0.005, 0.04];
    const sortino = computeSortino(returns);
    expect(sortino).toBeGreaterThan(0);
  });

  it('returns 0 for empty returns', () => {
    expect(computeSortino([])).toBe(0);
  });

  it('returns Infinity for no downside returns', () => {
    const returns = [0.01, 0.02, 0.03, 0.01, 0.02];
    expect(computeSortino(returns)).toBe(Infinity);
  });
});

describe('computeCalmar', () => {
  it('computes ratio correctly', () => {
    expect(computeCalmar(0.20, 0.10)).toBeCloseTo(2.0);
  });

  it('handles zero drawdown', () => {
    expect(computeCalmar(0.10, 0)).toBe(Infinity);
  });

  it('handles negative return', () => {
    expect(computeCalmar(-0.10, 0.20)).toBeCloseTo(-0.5);
  });
});
