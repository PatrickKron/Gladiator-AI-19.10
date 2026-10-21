import { describe, expect, it } from 'vitest';
import { mulberry32, percentile, runMonteCarlo, simulatePath } from './montecarlo.js';

/**
 * Monte-Carlo über die Trade-Reihenfolge: deterministisch, nur Umordnung der
 * beobachteten R-Multiples, Kennzahlen von Hand nachrechenbar.
 */

describe('Monte-Carlo (Trade-Reihenfolge)', () => {
  it('PRNG ist deterministisch und gleichverteilt in [0, 1)', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const xs = Array.from({ length: 1000 }, () => a());
    const ys = Array.from({ length: 1000 }, () => b());
    expect(xs).toEqual(ys);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(xs.reduce((s, x) => s + x, 0) / xs.length).toBeGreaterThan(0.45);
    expect(xs.reduce((s, x) => s + x, 0) / xs.length).toBeLessThan(0.55);
  });

  it('Pfad: Kapital wird mit Risiko × R je Trade fortgeschrieben; Drawdown und Verlustserie stimmen', () => {
    // 1 % Risiko: +2R, −1R, −1R, +1R auf 10.000
    const p = simulatePath([2, -1, -1, 1], 10_000, 1);
    expect(p.equity[0]).toBe(10_000);
    expect(p.equity[1]).toBeCloseTo(10_200, 9);
    expect(p.equity[2]).toBeCloseTo(10_098, 9);
    expect(p.equity[3]).toBeCloseTo(9_997.02, 9);
    expect(p.equity[4]).toBeCloseTo(10_096.9902, 6);
    // Drawdown vom Hoch 10.200 auf 9.997,02 = 1,99 %
    expect(p.maxDrawdownPct).toBeCloseTo(((10_200 - 9_997.02) / 10_200) * 100, 9);
    expect(p.longestLossStreak).toBe(2);
    expect(p.ruined).toBe(false);
  });

  it('Ruin: fällt das Kapital auf ≤ 0, bleibt es dort', () => {
    const p = simulatePath([-1, -1, -1, 5], 100, 60);
    expect(p.equity).toEqual([100, 40, 16, 6.4, 6.4 + 6.4 * 0.6 * 5]);
    expect(p.ruined).toBe(false);
    const ruin = simulatePath([-2, 1], 100, 60);
    expect(ruin.equity[1]).toBe(0);
    expect(ruin.equity[2]).toBe(0);
    expect(ruin.ruined).toBe(true);
  });

  it('Perzentile mit linearer Interpolation', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10], 0.95)).toBe(10);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });

  it('Mischen erhält die Menge der R-Multiples: alle Simulationen enden gleich, wenn jeder Trade dasselbe R hat', () => {
    const rs = Array.from({ length: 50 }, () => 0.5);
    const r = runMonteCarlo({ rMultiples: rs, startEquity: 10_000, riskPct: 1, runs: 200, seed: 1 });
    const expected = (Math.pow(1.005, 50) - 1) * 100;
    expect(r.finalReturnPct.p5).toBeCloseTo(expected, 9);
    expect(r.finalReturnPct.p95).toBeCloseTo(expected, 9);
    expect(r.maxDrawdownPct.p95).toBe(0);
    expect(r.probLoss).toBe(0);
    expect(r.probRuin).toBe(0);
    expect(r.longestLossStreak.p95).toBe(0);
    expect(r.original.finalReturnPct).toBeCloseTo(expected, 9);
  });

  it('deterministisch über den Seed; anderer Seed → andere Verteilung; Perzentile geordnet; Fächer ≤ 101 Stützstellen', () => {
    const rnd = mulberry32(99);
    const rs = Array.from({ length: 400 }, () => (rnd() < 0.45 ? 2 : -1));
    const a = runMonteCarlo({ rMultiples: rs, startEquity: 10_000, riskPct: 1, runs: 500, seed: 42 });
    const b = runMonteCarlo({ rMultiples: rs, startEquity: 10_000, riskPct: 1, runs: 500, seed: 42 });
    expect(a).toEqual(b);
    const c = runMonteCarlo({ rMultiples: rs, startEquity: 10_000, riskPct: 1, runs: 500, seed: 43 });
    expect(c.maxDrawdownPct.p50).not.toBe(a.maxDrawdownPct.p50);
    for (const p of [a.finalReturnPct, a.maxDrawdownPct, a.longestLossStreak]) {
      expect(p.p5).toBeLessThanOrEqual(p.p25);
      expect(p.p25).toBeLessThanOrEqual(p.p50);
      expect(p.p50).toBeLessThanOrEqual(p.p75);
      expect(p.p75).toBeLessThanOrEqual(p.p95);
    }
    expect(a.fan.length).toBeLessThanOrEqual(101);
    expect(a.fan[0]).toMatchObject({ index: 0, p5: 10_000, p95: 10_000 });
    expect(a.fan[a.fan.length - 1]!.index).toBe(400);
    // Mischen: Endrendite identisch mit der Original-Reihenfolge (nur Reihenfolge, gleiche Faktoren)
    expect(a.finalReturnPct.p5).toBeCloseTo(a.original.finalReturnPct, 6);
    expect(a.finalReturnPct.p95).toBeCloseTo(a.original.finalReturnPct, 6);
    // Drawdown-Wahrscheinlichkeiten fallen mit steigender Schwelle
    const probs = a.probDrawdownOver.map((x) => x.probability);
    for (let i = 1; i < probs.length; i++) expect(probs[i]).toBeLessThanOrEqual(probs[i - 1]!);
  });

  it('Bootstrap streut die Endrendite (Ziehen mit Zurücklegen), Mischen nicht', () => {
    const rnd = mulberry32(5);
    const rs = Array.from({ length: 200 }, () => (rnd() < 0.5 ? 1.5 : -1));
    const shuffle = runMonteCarlo({ rMultiples: rs, startEquity: 10_000, riskPct: 1, runs: 300, seed: 3, mode: 'shuffle' });
    const boot = runMonteCarlo({ rMultiples: rs, startEquity: 10_000, riskPct: 1, runs: 300, seed: 3, mode: 'bootstrap' });
    expect(shuffle.finalReturnPct.p95 - shuffle.finalReturnPct.p5).toBeLessThan(1e-6);
    expect(boot.finalReturnPct.p95 - boot.finalReturnPct.p5).toBeGreaterThan(5);
    expect(boot.mode).toBe('bootstrap');
  });

  it('ungültige Eingaben werden abgelehnt', () => {
    expect(() => runMonteCarlo({ rMultiples: [], startEquity: 1, riskPct: 1, runs: 10, seed: 1 })).toThrow(/mindestens einen Trade/);
    expect(() => runMonteCarlo({ rMultiples: [1], startEquity: 0, riskPct: 1, runs: 10, seed: 1 })).toThrow(/Startkapital/);
    expect(() => runMonteCarlo({ rMultiples: [1], startEquity: 100, riskPct: 0, runs: 10, seed: 1 })).toThrow(/Risiko/);
  });
});
