import { describe, expect, it } from 'vitest';
import { DEFAULT_VALIDITY_THRESHOLDS, evaluateBacktestValidity, type BacktestMetricsInput } from './validity.js';
import { holdoutMetrics, readHoldout } from './validity.js';

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

describe('Holdout-Check: jüngster Abschnitt muss allein bestehen (08 §4, Robustheit)', () => {
  const base = { tradeCount: 60, winRate: 0.5, profitFactor: 1.4, expectancy: 0.3, maxDrawdownPct: 12, sharpe: 1, netReturnPct: 20 };
  const from = new Date('2026-01-01T00:00:00Z');
  const to = new Date('2026-11-01T00:00:00Z'); // 304 Tage → Holdout ab 2026-08-01 (letzte 30 %)
  const tr = (iso: string, netPnl: number, rMultiple: number) => ({ entryTs: new Date(iso), netPnl, rMultiple });

  it('holdoutMetrics wertet nur Trades im jüngsten Anteil des Zeitraums aus', () => {
    const trades = [tr('2026-02-01T00:00:00Z', 500, 5), tr('2026-09-01T00:00:00Z', -100, -1), tr('2026-10-01T00:00:00Z', 50, 0.5)];
    const h = holdoutMetrics(trades, from, to);
    expect(h.tradeCount).toBe(2);
    expect(h.fromTs.toISOString().slice(0, 10)).toBe('2026-08-01'); // 304 T × 30 % = 91,2 T vor Ende
    expect(h.expectancy).toBeCloseTo(-0.25, 6);
    expect(h.profitFactor).toBeCloseTo(0.5, 6);
  });

  it('besteht nur mit genug Holdout-Trades und nicht negativer Erwartung', () => {
    const good = { fromTs: new Date('2026-08-03T00:00:00Z'), tradeCount: 15, expectancy: 0.2, profitFactor: 1.3 };
    expect(evaluateBacktestValidity({ ...base, holdout: good }).passed).toBe(true);
    const few = evaluateBacktestValidity({ ...base, holdout: { ...good, tradeCount: 4 } });
    expect(few.passed).toBe(false);
    expect(few.reasons.join(' ')).toMatch(/jüngsten Abschnitt/);
    expect(evaluateBacktestValidity({ ...base, holdout: { ...good, expectancy: -0.1, profitFactor: 0.9 } }).passed).toBe(false);
  });

  it('alter Backtest ohne Holdout-Auswertung → nicht freigegeben, ehrlicher Hinweis auf neuen Lauf', () => {
    const v = evaluateBacktestValidity({ ...base, holdout: null });
    expect(v.passed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/neu laufen/);
  });
});

describe('readHoldout (gespeichertes metrics-JSON)', () => {
  it('liest den Holdout aus JSON (fromTs als String) und meldet fehlende Auswertung als null', () => {
    const h = readHoldout({ netPnl: 1, holdout: { fromTs: '2026-08-03T00:00:00.000Z', tradeCount: 12, expectancy: 0.1, profitFactor: null } });
    expect(h).toEqual({ fromTs: new Date('2026-08-03T00:00:00.000Z'), tradeCount: 12, expectancy: 0.1, profitFactor: null });
    expect(readHoldout({ netPnl: 1 })).toBeNull();
    expect(readHoldout(null)).toBeNull();
  });
});
