import { describe, expect, it } from 'vitest';
import { analyzeTrades, type AnalyzableTrade } from './analysis.js';

function t(over: Partial<AnalyzableTrade>): AnalyzableTrade {
  return {
    netPnl: 100,
    rMultiple: 1,
    direction: 'long',
    session: 'london',
    emaRegime: 'above',
    marketPhase: 'bull',
    confluence: ['Trend (EMA)', 'Volumen'],
    ...over,
  };
}

describe('Rundum-Trade-Analyse (Session / EMA-Regime / Marktphase / Confluence)', () => {
  it('gruppiert nach Session mit ehrlichen Kennzahlen', () => {
    const res = analyzeTrades([
      t({ session: 'london', rMultiple: 1, netPnl: 100 }),
      t({ session: 'london', rMultiple: -1, netPnl: -100 }),
      t({ session: 'asia', rMultiple: 2, netPnl: 200 }),
    ]);
    expect(res.bySession['london']).toMatchObject({ trades: 2, netPnl: 0 });
    expect(res.bySession['london']!.expectancyR).toBeCloseTo(0);
    expect(res.bySession['asia']).toMatchObject({ trades: 1 });
    expect(res.bySession['asia']!.winRate).toBe(1);
    expect(res.bySession['overlap']).toBeUndefined(); // keine Trades → kein Eintrag, nichts erfunden
  });

  it('trennt Richtung × EMA-Regime (Longs über vs. unter EMA200)', () => {
    const res = analyzeTrades([
      t({ direction: 'long', emaRegime: 'above', rMultiple: 1.5 }),
      t({ direction: 'long', emaRegime: 'below', rMultiple: -1, netPnl: -100 }),
      t({ direction: 'long', emaRegime: 'below', rMultiple: -0.8, netPnl: -80 }),
      t({ direction: 'short', emaRegime: 'below', rMultiple: 0.5, netPnl: 50 }),
    ]);
    expect(res.byDirectionRegime['long|above']!.expectancyR).toBeCloseTo(1.5);
    expect(res.byDirectionRegime['long|below']!.expectancyR).toBeCloseTo(-0.9);
    expect(res.byDirectionRegime['long|below']!.trades).toBe(2);
    expect(res.byDirectionRegime['short|below']!.trades).toBe(1);
  });

  it('gruppiert nach Marktphase (bull/bear)', () => {
    const res = analyzeTrades([
      t({ marketPhase: 'bull', rMultiple: 1 }),
      t({ marketPhase: 'bear', rMultiple: -0.5, netPnl: -50 }),
    ]);
    expect(res.byPhase['bull']!.trades).toBe(1);
    expect(res.byPhase['bear']!.expectancyR).toBeCloseTo(-0.5);
  });

  it('misst jeden Confluence-Faktor einzeln: mit vs. ohne (Delta in R)', () => {
    const res = analyzeTrades([
      t({ confluence: ['FVG-Ziel', 'Volumen'], rMultiple: 2 }),
      t({ confluence: ['Volumen'], rMultiple: -1, netPnl: -100 }),
      t({ confluence: ['Volumen'], rMultiple: 0.5, netPnl: 50 }),
    ]);
    const fvg = res.byConfluence['FVG-Ziel']!;
    expect(fvg.withTrades).toBe(1);
    expect(fvg.withExpectancyR).toBeCloseTo(2);
    expect(fvg.withoutExpectancyR).toBeCloseTo(-0.25);
    expect(fvg.deltaR).toBeCloseTo(2.25);
  });

  it('leere Liste → leere Gruppen, keine erfundenen Werte', () => {
    const res = analyzeTrades([]);
    expect(Object.keys(res.bySession)).toHaveLength(0);
    expect(Object.keys(res.byConfluence)).toHaveLength(0);
  });
});
