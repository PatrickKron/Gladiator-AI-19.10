import { describe, expect, it } from 'vitest';
import { computeMetrics, maxDrawdownPct } from './metrics.js';

/** Handgerechnete Fälle — Kennzahlen sind NETTO-Werte auf Basis der Trade-Liste. */

const T = (netPnl: number, rMultiple: number) => ({ netPnl, rMultiple });

describe('Max-Drawdown (aus der Equity-Kurve)', () => {
  it('einfacher Fall: 100 → 120 → 90 → 130 ⇒ DD = 25 % (von 120 auf 90)', () => {
    expect(maxDrawdownPct([100, 120, 90, 130])).toBeCloseTo(25);
  });

  it('monoton steigend ⇒ 0 %', () => {
    expect(maxDrawdownPct([100, 110, 120])).toBe(0);
  });

  it('leer/einelementig ⇒ 0 %', () => {
    expect(maxDrawdownPct([])).toBe(0);
    expect(maxDrawdownPct([100])).toBe(0);
  });
});

describe('Trade-Kennzahlen (alle netto)', () => {
  it('WinRate, ProfitFactor, Expectancy handgerechnet', () => {
    // 3 Gewinner (+100, +200, +100), 2 Verlierer (−100, −100)
    const trades = [T(100, 1), T(200, 2), T(100, 1), T(-100, -1), T(-100, -1)];
    const m = computeMetrics(trades, [1000, 1100, 1300, 1400, 1300, 1200]);
    expect(m.tradeCount).toBe(5);
    expect(m.winRate).toBeCloseTo(0.6);
    expect(m.profitFactor).toBeCloseTo(400 / 200); // 2.0
    expect(m.expectancy).toBeCloseTo((1 + 2 + 1 - 1 - 1) / 5); // 0.4 R
    expect(m.netPnl).toBeCloseTo(200);
  });

  it('nur Gewinner: ProfitFactor = Infinity wird als null gemeldet (ehrlich: nicht definiert)', () => {
    const m = computeMetrics([T(100, 1), T(50, 0.5)], [1000, 1100, 1150]);
    expect(m.profitFactor).toBeNull();
    expect(m.winRate).toBe(1);
  });

  it('Sharpe/Sortino: konstant positive Bar-Returns ⇒ Sortino null (keine Downside), Sharpe > 0', () => {
    const equity = [1000, 1010, 1020.1, 1030.3];
    const m = computeMetrics([T(30, 1)], equity, { barsPerYear: 8760 });
    expect(m.sharpe).not.toBeNull();
    expect(m.sharpe!).toBeGreaterThan(0);
    expect(m.sortino).toBeNull(); // keine negativen Returns → Downside-Deviation 0 → undefiniert
  });

  it('Sharpe negativ bei fallender Equity', () => {
    const m = computeMetrics([T(-30, -1)], [1000, 990, 980, 970], { barsPerYear: 8760 });
    expect(m.sharpe!).toBeLessThan(0);
  });

  it('keine Trades ⇒ neutrale Kennzahlen, keine Erfindungen', () => {
    const m = computeMetrics([], [1000]);
    expect(m.tradeCount).toBe(0);
    expect(m.winRate).toBeNull();
    expect(m.expectancy).toBeNull();
    expect(m.sharpe).toBeNull();
  });
});
