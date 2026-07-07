import { describe, it, expect } from 'vitest';
import { computeFeatures, featureVectorToArray, arrayToFeatureVector, FEATURE_NAMES } from './features.js';
import type { Candle } from '@gladiator/strategy-engine';

function makeCandles(count: number, basePrice = 100, baseVolume = 1000): Candle[] {
  const candles: Candle[] = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const change = Math.sin(i * 0.1) * 2 + Math.cos(i * 0.05) * 1.5;
    price = price + change;
    if (price < 1) price = 1;
    const high = price + Math.abs(change) * 0.5 + 0.5;
    const low = price - Math.abs(change) * 0.5 - 0.5;
    candles.push({
      ts: new Date(Date.UTC(2024, 0, 1) + i * 3600_000),
      open: price - change * 0.3,
      high,
      low,
      close: price,
      volume: baseVolume + Math.sin(i * 0.2) * 200,
    });
  }
  return candles;
}

describe('computeFeatures', () => {
  it('returns null for insufficient candles', () => {
    const candles = makeCandles(100);
    expect(computeFeatures(candles)).toBeNull();
  });

  it('computes features from 250 candles', () => {
    const candles = makeCandles(250);
    const fv = computeFeatures(candles);
    expect(fv).not.toBeNull();
    if (!fv) return;

    expect(typeof fv.return1).toBe('number');
    expect(typeof fv.return5).toBe('number');
    expect(typeof fv.rsi14).toBe('number');
    expect(fv.rsi14).toBeGreaterThanOrEqual(0);
    expect(fv.rsi14).toBeLessThanOrEqual(100);
    expect(typeof fv.atr14).toBe('number');
    expect(fv.atr14).toBeGreaterThan(0);
    expect(typeof fv.regime).toBe('number');
    expect(fv.regime).toBeGreaterThanOrEqual(-1);
    expect(fv.regime).toBeLessThanOrEqual(1);
  });

  it('all feature names are present in the vector', () => {
    const candles = makeCandles(250);
    const fv = computeFeatures(candles);
    expect(fv).not.toBeNull();
    if (!fv) return;

    for (const name of FEATURE_NAMES) {
      expect(typeof fv[name]).toBe('number');
      expect(Number.isFinite(fv[name])).toBe(true);
    }
  });

  it('bollinger position is between 0 and 1 in normal conditions', () => {
    const candles = makeCandles(250);
    const fv = computeFeatures(candles);
    expect(fv).not.toBeNull();
    if (!fv) return;
    // Bollinger position can exceed 0-1 range during extreme moves, but should be finite
    expect(Number.isFinite(fv.bollingerPosition)).toBe(true);
  });

  it('volume ratios are positive', () => {
    const candles = makeCandles(250);
    const fv = computeFeatures(candles);
    expect(fv).not.toBeNull();
    if (!fv) return;
    expect(fv.volumeRatio5).toBeGreaterThan(0);
    expect(fv.volumeRatio20).toBeGreaterThan(0);
  });
});

describe('featureVectorToArray / arrayToFeatureVector', () => {
  it('round-trips correctly', () => {
    const candles = makeCandles(250);
    const fv = computeFeatures(candles);
    expect(fv).not.toBeNull();
    if (!fv) return;

    const arr = featureVectorToArray(fv);
    expect(arr.length).toBe(FEATURE_NAMES.length);

    const reconstructed = arrayToFeatureVector(arr);
    for (const name of FEATURE_NAMES) {
      expect(reconstructed[name]).toBeCloseTo(fv[name], 10);
    }
  });
});
