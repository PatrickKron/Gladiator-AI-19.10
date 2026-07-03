import { describe, expect, it } from 'vitest';
import { reviewTechnik } from './technik.js';
import type { SignalFacts } from './types.js';

const base: SignalFacts = {
  symbol: 'BTC/USDT',
  timeframe: '1h',
  direction: 'long',
  setupType: 'swing',
  source: 'engine',
  entry: 100,
  stopLoss: 95,
  takeProfits: [110, 115, 120],
  score: 8,
  confluence: ['BOS', 'Retest', 'EMA-Trend', 'RSI-Band'],
  session: 'london',
  emaRegime: 'above',
  marketPhase: 'bull',
};

describe('Technik-Agent (deterministisch, echte Signal-Fakten)', () => {
  it('sauberes Setup mit gutem RR und Regime-Alignment → confirm', () => {
    const v = reviewTechnik(base);
    expect(v.agent).toBe('technik');
    expect(v.vote).toBe('confirm');
    expect(v.confidence).toBeGreaterThan(0.7);
    expect(v.confidence).toBeLessThanOrEqual(1);
    expect(v.refs).toBeTruthy();
  });

  it('inkonsistentes Setup (SL auf falscher Seite) → reject, hoher Confidence', () => {
    const v = reviewTechnik({ ...base, stopLoss: 105 });
    expect(v.vote).toBe('reject');
    expect(v.reason).toMatch(/inkonsistent|Stop/i);
    expect(v.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('RR < 1 zum ersten TP → reject', () => {
    // Entry 100, SL 95 (Risiko 5), TP1 103 (Reward 3) → RR 0.6
    const v = reviewTechnik({ ...base, takeProfits: [103] });
    expect(v.vote).toBe('reject');
    expect(v.reason).toMatch(/RR/);
  });

  it('Long unter EMA200 → caution (Gegentrend-Warnung)', () => {
    const v = reviewTechnik({ ...base, emaRegime: 'below' });
    expect(v.vote).toBe('caution');
    expect(v.reason).toMatch(/EMA|Regime|Gegentrend/i);
  });

  it('knappes RR (1..1.5) → caution', () => {
    // Risiko 5, TP1 106 → RR 1.2
    const v = reviewTechnik({ ...base, takeProfits: [106, 110] });
    expect(v.vote).toBe('caution');
  });

  it('Confidence = Anteil bestandener Checks (nachvollziehbar, nie erfunden)', () => {
    const v = reviewTechnik(base);
    const checks = v.refs?.checks as { passed: boolean }[];
    const expected = checks.filter((c) => c.passed).length / checks.length;
    expect(v.confidence).toBeCloseTo(expected, 5);
  });

  it('Short-Setup korrekt gespiegelt (SL über Entry, TP darunter)', () => {
    const v = reviewTechnik({
      ...base,
      direction: 'short',
      stopLoss: 105,
      takeProfits: [90, 85],
      emaRegime: 'below',
      marketPhase: 'bear',
    });
    expect(v.vote).toBe('confirm');
  });
});
