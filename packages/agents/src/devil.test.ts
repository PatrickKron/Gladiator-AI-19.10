import { describe, expect, it } from 'vitest';
import { reviewDevil, type DevilEvidence } from './devil.js';
import type { SignalFacts } from './types.js';

const facts: SignalFacts = {
  symbol: 'BTC/USDT',
  timeframe: '1h',
  direction: 'long',
  setupType: 'swing',
  source: 'engine',
  entry: 100,
  stopLoss: 95,
  takeProfits: [110],
  score: 8,
  confluence: ['BOS', 'Retest'],
  session: 'london',
  emaRegime: 'above',
  marketPhase: 'bull',
};

describe("Devil's Advocate (Gegenevidenz aus ECHTER Historie)", () => {
  it('starke negative Evidenz (viele Trades, deutlich negativer Erwartungswert) → reject', () => {
    const evidence: DevilEvidence = {
      buckets: [
        { label: 'Longs unter EMA200', trades: 40, expectancyR: -0.3, winRate: 0.35 },
      ],
      totalTrades: 200,
    };
    const v = reviewDevil(facts, evidence);
    expect(v.agent).toBe('devil');
    expect(v.vote).toBe('reject');
    expect(v.reason).toMatch(/Longs unter EMA200/);
    expect(v.refs?.buckets).toBeTruthy();
  });

  it('schwach negative Evidenz → caution', () => {
    const evidence: DevilEvidence = {
      buckets: [{ label: 'Session off', trades: 12, expectancyR: -0.08, winRate: 0.42 }],
      totalTrades: 150,
    };
    const v = reviewDevil(facts, evidence);
    expect(v.vote).toBe('caution');
  });

  it('keine ausreichende Historie → caution mit NIEDRIGER Confidence (ehrlich, kein Fake)', () => {
    const evidence: DevilEvidence = { buckets: [], totalTrades: 3 };
    const v = reviewDevil(facts, evidence);
    expect(v.vote).toBe('caution');
    expect(v.confidence).toBeLessThanOrEqual(0.35);
    expect(v.reason).toMatch(/Historie/i);
  });

  it('positive Evidenz ohne Gegenargumente → Devil räumt ein: confirm', () => {
    const evidence: DevilEvidence = {
      buckets: [{ label: 'London-Session', trades: 30, expectancyR: 0.21, winRate: 0.7 }],
      totalTrades: 120,
    };
    const v = reviewDevil(facts, evidence);
    expect(v.vote).toBe('confirm');
    expect(v.reason).toMatch(/keine substanzielle Gegenevidenz/i);
  });

  it('Buckets mit zu wenig Trades (<10) zählen nicht als Evidenz', () => {
    const evidence: DevilEvidence = {
      buckets: [{ label: 'Off-Session', trades: 4, expectancyR: -0.9, winRate: 0.1 }],
      totalTrades: 80,
    };
    const v = reviewDevil(facts, evidence);
    // 4 Trades sind Rauschen — kein reject darauf stützen
    expect(v.vote).not.toBe('reject');
  });
});
