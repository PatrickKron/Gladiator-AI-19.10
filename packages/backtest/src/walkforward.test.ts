import { describe, expect, it } from 'vitest';
import { runWalkForward } from './walkforward.js';
import { ZERO_COSTS } from './engine.js';
import type { Candle, SetupCandidate } from '@gladiator/strategy-engine';

/**
 * Deterministisches Szenario: stetig steigender Markt.
 * Parameter { direction } steuert die Handelsrichtung des Test-Evaluators:
 * long gewinnt, short verliert. Der Walk-Forward MUSS auf In-Sample
 * 'long' wählen und Out-of-Sample positiv abschneiden — und die
 * OOS-Fenster dürfen NIE mit den IS-Fenstern überlappen.
 */

function candles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: new Date(i * 3_600_000),
    open: 100 + i,
    high: 102 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 100,
  }));
}

type P = { direction: 'long' | 'short' };

function makeEvaluator(params: P) {
  return (cs: Candle[], i: number): SetupCandidate[] => {
    if (i % 20 !== 10 || i + 1 >= cs.length) return []; // regelmäßige Test-Signale
    const c = cs[i]!;
    const dir = params.direction;
    const sign = dir === 'long' ? 1 : -1;
    return [
      {
        direction: dir,
        setupType: 'swing',
        entry: c.close,
        stopLoss: c.close - sign * 5,
        takeProfits: [c.close + sign * 5, c.close + sign * 10, c.close + sign * 15],
        score: 8,
        riskClass: 'low',
        confluence: [],
        session: 'london',
        brokenLevel: 0,
        structureKind: 'BOS',
      },
    ];
  };
}

describe('Walk-Forward (08_ §4: rollierend IS-optimieren, OOS validieren)', () => {
  it('wählt auf IS den profitablen Parameter und validiert OOS positiv', () => {
    const result = runWalkForward(candles(400), {
      paramGrid: [{ direction: 'long' }, { direction: 'short' }] as P[],
      makeEvaluator,
      isBars: 100,
      oosBars: 50,
      base: { initialEquity: 10_000, riskPctPerTrade: 1, costModel: ZERO_COSTS, barsPerYear: 8760, tpWeights: [0.5, 0.3, 0.2] },
    });

    expect(result.windows.length).toBeGreaterThanOrEqual(2);
    for (const w of result.windows) {
      expect((w.bestParams as P).direction).toBe('long'); // IS-Optimierung findet den Gewinner
      expect(w.oosStart).toBeGreaterThanOrEqual(w.isEnd); // OOS strikt NACH IS (kein Leck)
    }
    expect(result.combinedOos.netPnl).toBeGreaterThan(0);
    expect(result.combinedOos.tradeCount).toBeGreaterThan(0);
  });

  it('Fenster rollieren korrekt: nächstes IS beginnt um oosBars später', () => {
    const result = runWalkForward(candles(400), {
      paramGrid: [{ direction: 'long' }] as P[],
      makeEvaluator,
      isBars: 100,
      oosBars: 50,
      base: { initialEquity: 10_000, riskPctPerTrade: 1, costModel: ZERO_COSTS, barsPerYear: 8760, tpWeights: [0.5, 0.3, 0.2] },
    });
    const w0 = result.windows[0]!;
    const w1 = result.windows[1]!;
    expect(w1.isStart - w0.isStart).toBe(50);
  });

  it('zu wenig Daten → leeres, ehrliches Ergebnis (keine Fantasie-Fenster)', () => {
    const result = runWalkForward(candles(80), {
      paramGrid: [{ direction: 'long' }] as P[],
      makeEvaluator,
      isBars: 100,
      oosBars: 50,
      base: { initialEquity: 10_000, riskPctPerTrade: 1, costModel: ZERO_COSTS, barsPerYear: 8760, tpWeights: [0.5, 0.3, 0.2] },
    });
    expect(result.windows).toHaveLength(0);
    expect(result.combinedOos.tradeCount).toBe(0);
  });
});
