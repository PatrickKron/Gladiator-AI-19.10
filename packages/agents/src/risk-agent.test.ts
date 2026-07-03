import { describe, expect, it } from 'vitest';
import type { RiskVerdict } from '@gladiator/risk';
import { reviewRisk } from './risk-agent.js';

function verdict(allowed: boolean, failed: number, total: number): RiskVerdict {
  const checks = Array.from({ length: total }, (_, i) => ({
    name: `check-${i}`,
    passed: i >= failed,
    detail: i < failed ? `Check ${i} verletzt` : 'ok',
  }));
  return {
    allowed,
    reasons: checks.filter((c) => !c.passed).map((c) => c.detail),
    checks,
    sizing: allowed ? { qty: 0.01, notional: 1000, marginRequired: 1000, riskAmount: 100 } : null,
  };
}

describe('Risk-Agent (Vorschau der ECHTEN Risk-Engine — kein eigenes Urteil erfunden)', () => {
  it('Risk-Gate grün → confirm mit Sizing in refs', () => {
    const v = reviewRisk(verdict(true, 0, 10));
    expect(v.agent).toBe('risk');
    expect(v.vote).toBe('confirm');
    expect(v.confidence).toBe(1);
    expect((v.refs?.sizing as { qty: number }).qty).toBe(0.01);
  });

  it('Risk-Gate rot → reject mit den echten Gründen', () => {
    const v = reviewRisk(verdict(false, 2, 10));
    expect(v.vote).toBe('reject');
    expect(v.reason).toMatch(/Check 0 verletzt/);
    expect(v.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('Confidence bei confirm = Anteil bestandener Checks', () => {
    const withWarn = verdict(true, 0, 8);
    const v = reviewRisk(withWarn);
    expect(v.confidence).toBeCloseTo(1, 5);
  });
});
