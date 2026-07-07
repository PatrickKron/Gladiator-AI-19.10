import { describe, it, expect } from 'vitest';
import { normalCdf, zScore, computeBetSize } from './bet-sizing.js';

describe('normalCdf', () => {
  it('returns 0.5 at z=0', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 5);
  });

  it('returns ~0.8413 at z=1', () => {
    expect(normalCdf(1)).toBeCloseTo(0.8413, 3);
  });

  it('returns ~0.9772 at z=2', () => {
    expect(normalCdf(2)).toBeCloseTo(0.9772, 3);
  });

  it('returns ~0.1587 at z=-1', () => {
    expect(normalCdf(-1)).toBeCloseTo(0.1587, 3);
  });

  it('saturates at extremes', () => {
    expect(normalCdf(-10)).toBe(0);
    expect(normalCdf(10)).toBe(1);
  });

  it('is monotonically increasing', () => {
    for (let z = -4; z < 4; z += 0.5) {
      expect(normalCdf(z + 0.5)).toBeGreaterThan(normalCdf(z));
    }
  });
});

describe('zScore', () => {
  it('returns 0 for p=0.5 (no edge)', () => {
    expect(zScore(0.5, 100)).toBeCloseTo(0, 5);
  });

  it('returns positive z for p>0.5', () => {
    expect(zScore(0.7, 100)).toBeGreaterThan(0);
  });

  it('scales with sample size', () => {
    const z100 = zScore(0.6, 100);
    const z1000 = zScore(0.6, 1000);
    expect(z1000).toBeGreaterThan(z100);
  });

  it('returns 0 for sampleSize <= 0', () => {
    expect(zScore(0.7, 0)).toBe(0);
    expect(zScore(0.7, -5)).toBe(0);
  });
});

describe('computeBetSize', () => {
  it('returns 0 for p <= 0.5 (no edge)', () => {
    const result = computeBetSize(0.5, 100);
    expect(result.discretizedSize).toBe(0);
    expect(result.rawSize).toBe(0);
  });

  it('returns 0 for p=0.3 (negative edge)', () => {
    const result = computeBetSize(0.3, 100);
    expect(result.discretizedSize).toBe(0);
  });

  it('returns positive size for p=0.7 with sufficient sample', () => {
    const result = computeBetSize(0.7, 200);
    expect(result.discretizedSize).toBeGreaterThan(0);
    expect(result.discretizedSize).toBeLessThanOrEqual(1);
  });

  it('returns larger size for higher probability', () => {
    const low = computeBetSize(0.6, 200);
    const high = computeBetSize(0.9, 200);
    expect(high.discretizedSize).toBeGreaterThanOrEqual(low.discretizedSize);
  });

  it('discretizes to 0.1 steps', () => {
    const result = computeBetSize(0.75, 200);
    expect(result.discretizedSize * 10).toBe(Math.round(result.discretizedSize * 10));
  });

  it('is conservative: discretized <= raw', () => {
    for (const p of [0.55, 0.6, 0.7, 0.8, 0.9]) {
      const result = computeBetSize(p, 200);
      expect(result.discretizedSize).toBeLessThanOrEqual(result.rawSize + 0.001);
    }
  });

  it('clamps probability to [0, 1]', () => {
    const neg = computeBetSize(-0.5, 100);
    expect(neg.discretizedSize).toBe(0);

    const over = computeBetSize(1.5, 100);
    expect(over.discretizedSize).toBeLessThanOrEqual(1);
  });

  it('respects custom step size', () => {
    const result = computeBetSize(0.75, 200, 0.25);
    expect(result.discretizedSize % 0.25).toBeCloseTo(0, 5);
  });
});
