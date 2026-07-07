import { describe, expect, it } from 'vitest';
import { computeGrs, deriveGrsFromSeries, grsHistory, type MacroPoint } from './grs.js';

/**
 * GRS (Global Risk Score, 08_/09_ Aegis): dokumentierte, deterministische
 * Formel aus ECHTEN VIX/DXY/US10Y-Werten — kein erfundener Score.
 */

describe('computeGrs (pure, dokumentierte Formel)', () => {
  it('ruhiger Markt (VIX 13, Dollar/Renditen flach) → niedriger Score, Label risk-on', () => {
    const g = computeGrs({ vix: 13, dxyChangePct20d: 0, us10yChangeBp20d: 0 });
    expect(g.score).toBeLessThan(35);
    expect(g.label).toBe('risk-on');
    expect(g.components.vix.score).toBeLessThan(35);
  });

  it('Stress (VIX 35, Dollar +3 %, Renditen +40 bp) → hoher Score, Label risk-off', () => {
    const g = computeGrs({ vix: 35, dxyChangePct20d: 3, us10yChangeBp20d: 40 });
    expect(g.score).toBeGreaterThan(70);
    expect(g.label).toBe('risk-off');
  });

  it('Score liegt IMMER in [0, 100], auch bei Extremwerten', () => {
    expect(computeGrs({ vix: 80, dxyChangePct20d: 10, us10yChangeBp20d: 100 }).score).toBeLessThanOrEqual(100);
    expect(computeGrs({ vix: 5, dxyChangePct20d: -10, us10yChangeBp20d: -100 }).score).toBeGreaterThanOrEqual(0);
  });

  it('monoton: mehr VIX ⇒ nie niedrigerer Score', () => {
    let prev = -1;
    for (const vix of [10, 15, 20, 25, 30, 40]) {
      const s = computeGrs({ vix, dxyChangePct20d: 0, us10yChangeBp20d: 0 }).score;
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it('Gewichte sind dokumentiert: VIX 50 %, DXY 25 %, US10Y 25 %', () => {
    const g = computeGrs({ vix: 20, dxyChangePct20d: 1, us10yChangeBp20d: 10 });
    const expected = g.components.vix.score * 0.5 + g.components.dxy.score * 0.25 + g.components.us10y.score * 0.25;
    expect(g.score).toBeCloseTo(expected, 5);
  });
});

describe('deriveGrsFromSeries (Zeitreihen → Inputs)', () => {
  const mk = (values: number[]): MacroPoint[] =>
    values.map((v, i) => ({ ts: new Date(Date.UTC(2026, 5, 1) + i * 86_400_000), value: v }));

  it('berechnet 20-Tage-Änderungen aus den Serien', () => {
    const vix = mk(Array.from({ length: 25 }, () => 18));
    const dxy = mk(Array.from({ length: 25 }, (_, i) => 100 + i * 0.1)); // +2.4 % über 24 Tage
    const us10y = mk(Array.from({ length: 25 }, (_, i) => 4 + i * 0.01)); // ^TNX-Skala: 4.00 → 4.24 (%) = +20 bp über 20 Tage
    const g = deriveGrsFromSeries(vix, dxy, us10y);
    expect(g).not.toBeNull();
    expect(g!.inputs.vix).toBe(18);
    expect(g!.inputs.dxyChangePct20d).toBeCloseTo((dxy[24]!.value / dxy[4]!.value - 1) * 100, 5);
    expect(g!.inputs.us10yChangeBp20d).toBeCloseTo((us10y[24]!.value - us10y[4]!.value) * 100, 5);
  });

  it('zu wenig Historie (< 21 Punkte) → ehrlich null, kein geratener GRS', () => {
    expect(deriveGrsFromSeries(mk([18, 18]), mk([100, 100]), mk([4, 4]))).toBeNull();
  });
});

describe('grsHistory (P2.11 — Score-Verlauf, gleiche Formel je Stichtag)', () => {
  const mk = (values: number[]): MacroPoint[] =>
    values.map((v, i) => ({ ts: new Date(Date.UTC(2026, 5, 1) + i * 86_400_000), value: v }));

  it('liefert bis zu `days` Punkte, aufsteigend nach Zeit', () => {
    const n = 30;
    const vix = mk(Array.from({ length: n }, () => 18));
    const dxy = mk(Array.from({ length: n }, (_, i) => 100 + i * 0.05));
    const us10y = mk(Array.from({ length: n }, (_, i) => 4 + i * 0.005));
    const hist = grsHistory(vix, dxy, us10y, 5);
    expect(hist.length).toBe(5);
    // aufsteigend nach Zeit
    for (let i = 1; i < hist.length; i++) {
      expect(hist[i]!.ts.getTime()).toBeGreaterThan(hist[i - 1]!.ts.getTime());
    }
    // jeder Score ist der deterministische GRS as-of diesem Tag (0..100)
    for (const h of hist) {
      expect(h.score).toBeGreaterThanOrEqual(0);
      expect(h.score).toBeLessThanOrEqual(100);
    }
  });

  it('der letzte History-Punkt entspricht dem aktuellen GRS', () => {
    const n = 25;
    const vix = mk(Array.from({ length: n }, () => 20));
    const dxy = mk(Array.from({ length: n }, (_, i) => 100 + i * 0.1));
    const us10y = mk(Array.from({ length: n }, (_, i) => 4 + i * 0.01));
    const hist = grsHistory(vix, dxy, us10y, 3);
    const current = deriveGrsFromSeries(vix, dxy, us10y)!;
    expect(hist[hist.length - 1]!.score).toBeCloseTo(current.score, 6);
  });

  it('zu wenig Historie → leeres Ergebnis (kein geratener Verlauf)', () => {
    expect(grsHistory(mk([18, 18]), mk([100, 100]), mk([4, 4]), 30)).toEqual([]);
  });
});
