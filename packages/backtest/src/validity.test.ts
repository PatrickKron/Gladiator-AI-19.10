import { describe, expect, it } from 'vitest';
import { DEFAULT_VALIDITY_THRESHOLDS, evaluateBacktestValidity, type BacktestMetricsInput } from './validity.js';

/**
 * Backtest-Validitäts-Gate (Patrick Vision 5): eine Strategie darf NUR dann
 * selbstständig (Paper-Auto-Loop) laufen, wenn ein Backtest sie als valide
 * beweist. Diese reine Funktion ist das Herz des Gates.
 */

const good: BacktestMetricsInput = {
  tradeCount: 42,
  winRate: 0.55,
  profitFactor: 1.6,
  expectancy: 0.28,
  maxDrawdownPct: 18,
  sharpe: 1.2,
  netReturnPct: 34,
};

describe('evaluateBacktestValidity', () => {
  it('solider Backtest → passed, keine Gründe', () => {
    const v = evaluateBacktestValidity(good);
    expect(v.passed).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.checks.every((c) => c.passed)).toBe(true);
  });

  it('zu wenige Trades → nicht valide', () => {
    const v = evaluateBacktestValidity({ ...good, tradeCount: 12 });
    expect(v.passed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/Trades/i);
  });

  it('Profit-Factor unter Schwelle → nicht valide', () => {
    const v = evaluateBacktestValidity({ ...good, profitFactor: 0.9 });
    expect(v.passed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/Profit-Factor|profitabel/i);
  });

  it('Drawdown zu hoch → nicht valide', () => {
    const v = evaluateBacktestValidity({ ...good, maxDrawdownPct: 65 });
    expect(v.passed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/Drawdown/i);
  });

  it('negative Erwartung → nicht valide', () => {
    const v = evaluateBacktestValidity({ ...good, expectancy: -0.1 });
    expect(v.passed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/Erwartung/i);
  });

  it('Profit-Factor null = KEINE Verlusttrades → besteht die PF-Prüfung', () => {
    const v = evaluateBacktestValidity({ ...good, profitFactor: null });
    const pf = v.checks.find((c) => c.name === 'profitFactor')!;
    expect(pf.passed).toBe(true);
    expect(pf.detail).toMatch(/keine Verlust/i);
    expect(v.passed).toBe(true);
  });

  it('leerer Backtest (0 Trades) → nicht valide, mehrere Gründe', () => {
    const v = evaluateBacktestValidity({
      tradeCount: 0,
      winRate: null,
      profitFactor: null,
      expectancy: null,
      maxDrawdownPct: 0,
      sharpe: null,
      netReturnPct: 0,
    });
    expect(v.passed).toBe(false);
    expect(v.reasons.length).toBeGreaterThanOrEqual(1);
    // Erwartung mit null (keine Trades) darf nicht durchrutschen
    expect(v.checks.find((c) => c.name === 'expectancy')!.passed).toBe(false);
  });

  it('konfigurierbare Schwellen greifen', () => {
    const strict = { ...DEFAULT_VALIDITY_THRESHOLDS, minTrades: 100 };
    expect(evaluateBacktestValidity(good, strict).passed).toBe(false);
    const lax = { ...DEFAULT_VALIDITY_THRESHOLDS, minTrades: 10, minProfitFactor: 0.5, maxDrawdownPct: 90, minExpectancyR: -1 };
    expect(evaluateBacktestValidity({ ...good, tradeCount: 11, profitFactor: 0.8 }, lax).passed).toBe(true);
  });
});
