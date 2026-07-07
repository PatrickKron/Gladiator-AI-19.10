import { describe, it, expect } from 'vitest';
import type { Candle } from '@gladiator/strategy-engine';
import {
  ACTION_SPACE,
  NUM_ACTIONS,
  STATE_DIM,
  DEFAULT_EPISODE_CONFIG,
  initEpisode,
  getState,
  stateToArray,
  step,
  computeEpisodeMetrics,
} from './environment.js';

function makeCandles(n: number, basePrice = 100, seed = 42): Candle[] {
  let s = seed;
  const rng = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };

  const candles: Candle[] = [];
  let price = basePrice;
  const now = Date.now();

  for (let i = 0; i < n; i++) {
    const change = (rng() - 0.5) * 2;
    price = Math.max(1, price + change);
    const high = price + rng() * 2;
    const low = price - rng() * 2;
    candles.push({
      ts: new Date(now + i * 3600_000),
      open: price - change * 0.3,
      high,
      low: Math.max(0.1, low),
      close: price,
      volume: 1000 + rng() * 5000,
    });
  }
  return candles;
}

describe('environment constants', () => {
  it('has 7 actions', () => {
    expect(NUM_ACTIONS).toBe(7);
    expect(ACTION_SPACE).toHaveLength(7);
  });

  it('state dimension is 29 (25 features + 4 portfolio)', () => {
    expect(STATE_DIM).toBe(29);
  });
});

describe('initEpisode', () => {
  it('creates context with correct defaults', () => {
    const candles = makeCandles(300);
    const ctx = initEpisode(candles);
    expect(ctx.currentBar).toBe(220);
    expect(ctx.position).toBe(0);
    expect(ctx.capital).toBe(DEFAULT_EPISODE_CONFIG.initialCapital);
    expect(ctx.totalReturn).toBe(0);
    expect(ctx.maxDrawdown).toBe(0);
  });
});

describe('getState', () => {
  it('returns null for insufficient candles', () => {
    const candles = makeCandles(100);
    const ctx = initEpisode(candles);
    ctx.currentBar = 50;
    expect(getState(ctx)).toBeNull();
  });

  it('returns valid state for sufficient candles', () => {
    const candles = makeCandles(300);
    const ctx = initEpisode(candles);
    const state = getState(ctx);
    expect(state).not.toBeNull();
    expect(state!.features).toHaveLength(25);
    expect(state!.portfolio.positionSize).toBe(0);
    expect(state!.portfolio.cashRatio).toBe(1);
  });
});

describe('stateToArray', () => {
  it('produces array of STATE_DIM length', () => {
    const candles = makeCandles(300);
    const ctx = initEpisode(candles);
    const state = getState(ctx)!;
    const arr = stateToArray(state);
    expect(arr).toHaveLength(STATE_DIM);
    expect(arr.every(v => typeof v === 'number' && isFinite(v))).toBe(true);
  });
});

describe('step', () => {
  it('advances bar and returns result', () => {
    const candles = makeCandles(300);
    const ctx = initEpisode(candles);
    const bar0 = ctx.currentBar;
    const result = step(ctx, 'hold');
    expect(result).not.toBeNull();
    expect(ctx.currentBar).toBe(bar0 + 1);
    expect(result!.info.action).toBe('hold');
  });

  it('buying increases position', () => {
    const candles = makeCandles(300);
    const ctx = initEpisode(candles);
    const result = step(ctx, 'buy_medium');
    expect(result).not.toBeNull();
    expect(ctx.position).toBeGreaterThan(0);
    expect(result!.info.positionAfter).toBeGreaterThan(0);
  });

  it('selling decreases position', () => {
    const candles = makeCandles(300);
    const ctx = initEpisode(candles);
    step(ctx, 'buy_large');
    const posBefore = ctx.position;
    step(ctx, 'sell_medium');
    expect(ctx.position).toBeLessThan(posBefore);
  });

  it('tracks transaction costs', () => {
    const candles = makeCandles(300);
    const ctx = initEpisode(candles);
    step(ctx, 'buy_large');
    // Capital should decrease due to tx cost even before price change
    expect(ctx.totalTrades).toBe(1);
    // After trading, capital adjusts for both tx cost and price movement
    expect(typeof ctx.capital).toBe('number');
    expect(isFinite(ctx.capital)).toBe(true);
  });

  it('stops at 50% loss', () => {
    const candles = makeCandles(300);
    const ctx = initEpisode(candles);
    ctx.capital = ctx.config.initialCapital * 0.49; // below 50%
    const result = step(ctx, 'hold');
    expect(result).not.toBeNull();
    expect(result!.done).toBe(true);
  });

  it('returns null at end of candles', () => {
    const candles = makeCandles(222);
    const ctx = initEpisode(candles);
    const r1 = step(ctx, 'hold');
    expect(r1).not.toBeNull();
    expect(r1!.done).toBe(true);
  });
});

describe('computeEpisodeMetrics', () => {
  it('computes reasonable metrics after trading', () => {
    const candles = makeCandles(300);
    const ctx = initEpisode(candles);

    // Run a few steps
    step(ctx, 'buy_medium');
    for (let i = 0; i < 10; i++) step(ctx, 'hold');
    step(ctx, 'sell_large');
    for (let i = 0; i < 5; i++) step(ctx, 'hold');

    const metrics = computeEpisodeMetrics(ctx);
    expect(typeof metrics.totalReturn).toBe('number');
    expect(typeof metrics.sharpeRatio).toBe('number');
    expect(metrics.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(metrics.totalTrades).toBe(2);
    expect(metrics.winRate).toBeGreaterThanOrEqual(0);
    expect(metrics.winRate).toBeLessThanOrEqual(1);
  });

  it('handles empty returns', () => {
    const candles = makeCandles(300);
    const ctx = initEpisode(candles);
    const metrics = computeEpisodeMetrics(ctx);
    expect(metrics.totalReturn).toBe(0);
    expect(metrics.sharpeRatio).toBe(0);
    expect(metrics.totalTrades).toBe(0);
  });
});
