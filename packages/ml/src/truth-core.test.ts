import { describe, it, expect } from 'vitest';
import { runTruthCore, type TruthCoreInput } from './truth-core.js';
import type { Candle } from '@gladiator/strategy-engine';

function makeTrendingCandles(count: number, direction: 'up' | 'down', basePrice = 100): Candle[] {
  const candles: Candle[] = [];
  let price = basePrice;
  const step = direction === 'up' ? 0.5 : -0.5;

  for (let i = 0; i < count; i++) {
    price += step;
    const high = price + 1;
    const low = price - 1;
    candles.push({
      ts: new Date(Date.UTC(2024, 0, 1) + i * 3600_000),
      open: price - step * 0.5,
      high,
      low,
      close: price,
      volume: 1000 + i * 10,
    });
  }
  return candles;
}

function makeRangingCandles(count: number, basePrice = 100): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const osc = Math.sin(i * 0.5) * 3;
    const price = basePrice + osc;
    candles.push({
      ts: new Date(Date.UTC(2024, 0, 1) + i * 3600_000),
      open: price - 0.5,
      high: price + 2,
      low: price - 2,
      close: price,
      volume: 1000,
    });
  }
  return candles;
}

describe('runTruthCore', () => {
  it('passes for long signal in uptrend', () => {
    const candles = makeTrendingCandles(250, 'up');
    const lastClose = candles[candles.length - 1]!.close;

    const input: TruthCoreInput = {
      direction: 'long',
      entry: lastClose,
      stopLoss: lastClose - 5,
      score: 8,
      features: null,
      candles,
    };

    const result = runTruthCore(input);
    expect(result.passed).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it('passes for short signal in downtrend', () => {
    const candles = makeTrendingCandles(250, 'down', 200);
    const lastClose = candles[candles.length - 1]!.close;

    const input: TruthCoreInput = {
      direction: 'short',
      entry: lastClose,
      stopLoss: lastClose + 5,
      score: 8,
      features: null,
      candles,
    };

    const result = runTruthCore(input);
    expect(result.passed).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('rejects long signal in strong downtrend', () => {
    const candles = makeTrendingCandles(250, 'down', 200);
    const lastClose = candles[candles.length - 1]!.close;

    const input: TruthCoreInput = {
      direction: 'long',
      entry: lastClose,
      stopLoss: lastClose - 5,
      score: 6,
      features: null,
      candles,
    };

    const result = runTruthCore(input);
    // Trend alignment and MACD should contradict long in downtrend
    const trendCheck = result.checks.find(c => c.name === 'trend_alignment');
    expect(trendCheck?.passed).toBe(false);
    // Confidence should be lower than for a correctly-aligned signal
    expect(result.confidence).toBeLessThan(1);
  });

  it('flags extreme SL placement', () => {
    const candles = makeTrendingCandles(250, 'up');
    const lastClose = candles[candles.length - 1]!.close;

    const input: TruthCoreInput = {
      direction: 'long',
      entry: lastClose,
      stopLoss: lastClose - 100, // Way too wide
      score: 7,
      features: null,
      candles,
    };

    const result = runTruthCore(input);
    const volCheck = result.checks.find(c => c.name === 'volatility');
    expect(volCheck).toBeDefined();
    expect(volCheck!.passed).toBe(false);
  });

  it('all checks return valid structure', () => {
    const candles = makeTrendingCandles(250, 'up');
    const lastClose = candles[candles.length - 1]!.close;

    const result = runTruthCore({
      direction: 'long',
      entry: lastClose,
      stopLoss: lastClose - 3,
      score: 7,
      features: null,
      candles,
    });

    for (const check of result.checks) {
      expect(typeof check.name).toBe('string');
      expect(typeof check.passed).toBe('boolean');
      expect(typeof check.reason).toBe('string');
      expect(check.reason.length).toBeGreaterThan(0);
      expect(typeof check.weight).toBe('number');
      expect(check.weight).toBeGreaterThan(0);
    }
  });

  it('handles insufficient candles gracefully', () => {
    const candles = makeTrendingCandles(10, 'up');
    const result = runTruthCore({
      direction: 'long',
      entry: 100,
      stopLoss: 95,
      score: 7,
      features: null,
      candles,
    });
    // Should not crash, checks should return with reasons
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it('incorporates higher-TF data when available', () => {
    const candles = makeTrendingCandles(250, 'up');
    const higherTfCandles = makeTrendingCandles(100, 'up', 100);
    const lastClose = candles[candles.length - 1]!.close;

    const result = runTruthCore({
      direction: 'long',
      entry: lastClose,
      stopLoss: lastClose - 3,
      score: 7,
      features: null,
      candles,
      higherTfCandles,
    });

    const htfCheck = result.checks.find(c => c.name === 'higher_tf');
    expect(htfCheck).toBeDefined();
    expect(htfCheck!.reason).not.toContain('skipped');
  });

  it('reasons array contains only failed check reasons', () => {
    const candles = makeTrendingCandles(250, 'up');
    const lastClose = candles[candles.length - 1]!.close;

    const result = runTruthCore({
      direction: 'long',
      entry: lastClose,
      stopLoss: lastClose - 3,
      score: 7,
      features: null,
      candles,
    });

    const failedReasons = result.checks.filter(c => !c.passed).map(c => c.reason);
    expect(result.reasons).toEqual(failedReasons);
  });
});
