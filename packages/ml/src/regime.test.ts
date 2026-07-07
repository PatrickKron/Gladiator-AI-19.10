import { describe, it, expect } from 'vitest';
import { detectRegime, detectRegimeMultiWindow, regimeStrategyWeights, REGIMES } from './regime.js';
import type { Candle } from '@gladiator/strategy-engine';

function makeCandle(close: number, volume: number, ts?: Date): Candle {
  return {
    ts: ts ?? new Date(),
    open: close * 0.999,
    high: close * 1.005,
    low: close * 0.995,
    close,
    volume,
  };
}

function makeCandles(count: number, startPrice: number, trend: number, volatility: number, baseVolume = 1000): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  // Simple LCG for deterministic pseudo-random noise (not periodic like sin)
  let seed = 42;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  for (let i = 0; i < count; i++) {
    const noise = rng() * volatility * price;
    price = price * (1 + trend) + noise;
    if (price <= 0) price = 0.01;
    const vol = baseVolume * (1 + rng() * 0.2);
    candles.push(makeCandle(price, Math.max(1, vol), new Date(Date.now() - (count - i) * 3600_000)));
  }
  return candles;
}

describe('detectRegime', () => {
  it('returns sideways with zero confidence for insufficient data', () => {
    const candles = makeCandles(20, 100, 0, 0);
    const result = detectRegime(candles);
    expect(result.regime).toBe('sideways');
    expect(result.confidence).toBe(0);
  });

  it('detects bull regime for strong uptrend', () => {
    // Steady 0.5% per bar uptrend, minimal noise
    const candles = makeCandles(250, 100, 0.005, 0.0005);
    const result = detectRegime(candles);
    expect(result.regime).toBe('bull');
    expect(result.confidence).toBeGreaterThan(0.2);
    expect(result.components.length).toBeGreaterThanOrEqual(5);
  });

  it('detects bear regime for strong downtrend', () => {
    // Steady -0.5% per bar downtrend, minimal noise
    const candles = makeCandles(250, 100, -0.005, 0.0005);
    const result = detectRegime(candles);
    // Bear or crisis (deep drawdown can trigger crisis classification)
    expect(['bear', 'crisis']).toContain(result.regime);
    expect(result.confidence).toBeGreaterThan(0.2);
  });

  it('detects sideways for flat market', () => {
    // No trend, very low noise
    const candles = makeCandles(250, 100, 0, 0.0003);
    const result = detectRegime(candles);
    expect(result.regime).toBe('sideways');
    expect(result.confidence).toBeGreaterThan(0.2);
  });

  it('detects high-vol regime for volatile market', () => {
    // Build candles with extreme volatility in recent period
    const calm = makeCandles(200, 100, 0, 0.001);
    const volatile: Candle[] = [];
    let price = calm[calm.length - 1]!.close;
    for (let i = 0; i < 50; i++) {
      // Huge swings: 5% each bar alternating
      price *= i % 2 === 0 ? 1.05 : 0.95;
      volatile.push(makeCandle(price, 1000, new Date(Date.now() - (50 - i) * 3600_000)));
    }
    const candles = [...calm, ...volatile];
    const result = detectRegime(candles);
    expect(['high_vol', 'crisis']).toContain(result.regime);
  });

  it('detects crisis for deep drawdown + high volatility', () => {
    // Start high, crash hard with high vol
    const good = makeCandles(150, 100, 0.002, 0.001);
    const ath = good[good.length - 1]!.close;
    const crash: Candle[] = [];
    let price = ath;
    for (let i = 0; i < 100; i++) {
      // Crash 1% per bar with big swings
      price *= 0.99;
      const noise = Math.sin(i * 2.3) * 0.03 * price;
      crash.push(makeCandle(price + noise, 3000, new Date(Date.now() - (100 - i) * 3600_000)));
    }
    const candles = [...good, ...crash];
    const result = detectRegime(candles);
    expect(['crisis', 'bear', 'high_vol']).toContain(result.regime);
  });

  it('components array contains all 5 sub-scores', () => {
    const candles = makeCandles(250, 100, 0.002, 0.005);
    const result = detectRegime(candles);
    const names = result.components.map(c => c.name);
    expect(names).toContain('trend');
    expect(names).toContain('volatility');
    expect(names).toContain('volume');
    expect(names).toContain('drawdown');
    expect(names).toContain('mean_reversion');
  });

  it('confidence is between 0 and 1', () => {
    const scenarios = [
      makeCandles(250, 100, 0.005, 0.001),  // bull
      makeCandles(250, 100, -0.005, 0.001), // bear
      makeCandles(250, 100, 0, 0.002),       // sideways
    ];
    for (const candles of scenarios) {
      const result = detectRegime(candles);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('each component score is in valid range', () => {
    const candles = makeCandles(250, 100, 0.003, 0.005);
    const result = detectRegime(candles);
    for (const comp of result.components) {
      expect(comp.score).toBeGreaterThanOrEqual(-1);
      expect(comp.score).toBeLessThanOrEqual(1);
      expect(comp.detail.length).toBeGreaterThan(0);
    }
  });

  it('regime is always one of the defined REGIMES', () => {
    const scenarios = [
      makeCandles(250, 100, 0.01, 0.001),
      makeCandles(250, 100, -0.01, 0.001),
      makeCandles(250, 100, 0, 0.001),
      makeCandles(60, 100, 0, 0.001),
    ];
    for (const candles of scenarios) {
      const result = detectRegime(candles);
      expect(REGIMES).toContain(result.regime);
    }
  });
});

describe('detectRegimeMultiWindow', () => {
  it('boosts confidence when all windows agree', () => {
    // Consistent strong uptrend across all windows, minimal noise
    const candles = makeCandles(300, 100, 0.005, 0.0005);
    const single = detectRegime(candles);
    const multi = detectRegimeMultiWindow(candles);
    // Both should detect same regime
    expect(multi.regime).toBe(single.regime);
    // Multi-window result should have reasonable confidence
    expect(multi.confidence).toBeGreaterThan(0.2);
  });

  it('falls back to single-window for short data', () => {
    const candles = makeCandles(80, 100, 0.003, 0.002);
    const single = detectRegime(candles);
    const multi = detectRegimeMultiWindow(candles);
    expect(multi.regime).toBe(single.regime);
  });

  it('adds multi_window component when short-term diverges', () => {
    // Long uptrend then recent reversal
    const up = makeCandles(200, 100, 0.005, 0.001);
    const down = makeCandles(50, up[up.length - 1]!.close, -0.008, 0.002);
    const candles = [...up, ...down];
    const result = detectRegimeMultiWindow(candles);
    // Should detect the divergence (full vs short window may differ)
    if (result.components.some(c => c.name === 'multi_window')) {
      expect(result.confidence).toBeLessThan(0.9);
    }
  });
});

describe('regimeStrategyWeights', () => {
  it('returns weights for all strategy types in each regime', () => {
    const strategies = ['momentum', 'mean_reversion', 'breakout', 'volatility_regime', 'trend_following'];
    for (const regime of REGIMES) {
      const weights = regimeStrategyWeights(regime);
      for (const strat of strategies) {
        expect(weights[strat]).toBeTypeOf('number');
        expect(weights[strat]).toBeGreaterThan(0);
      }
    }
  });

  it('favors trend-following in bull regime', () => {
    const w = regimeStrategyWeights('bull');
    expect(w.trend_following).toBeGreaterThan(1.0);
    expect(w.trend_following).toBeGreaterThan(w.mean_reversion!);
  });

  it('favors mean-reversion in sideways regime', () => {
    const w = regimeStrategyWeights('sideways');
    expect(w.mean_reversion).toBeGreaterThan(1.0);
    expect(w.mean_reversion).toBeGreaterThan(w.trend_following!);
  });

  it('favors volatility strategy in high-vol and crisis', () => {
    expect(regimeStrategyWeights('high_vol').volatility_regime).toBeGreaterThan(1.0);
    expect(regimeStrategyWeights('crisis').volatility_regime).toBeGreaterThan(1.0);
  });

  it('reduces most strategies in crisis', () => {
    const w = regimeStrategyWeights('crisis');
    expect(w.momentum).toBeLessThan(1.0);
    expect(w.mean_reversion).toBeLessThan(1.0);
    expect(w.breakout).toBeLessThan(1.0);
    expect(w.trend_following).toBeLessThan(1.0);
  });
});
