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
        emaRegime: dir === 'long' ? 'above' : 'below',
        marketPhase: dir === 'long' ? 'bull' : 'bear',
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
  it('Warmup: OOS-Evaluator sieht vorangehende Kerzen als Indikator-Historie, handelt aber erst ab OOS-Start', () => {
    // Evaluator braucht ≥ 40 Kerzen Historie (wie EMA-Warmup) — ohne Warmup wären die
    // ersten 40 Bars jedes OOS-Fensters tot.
    const needsHistory = (params: P) => {
      const inner = makeEvaluator(params);
      return (cs: Candle[], i: number) => (i < 40 ? [] : inner(cs, i));
    };
    const cs = candles(400);
    const base = { initialEquity: 10_000, riskPctPerTrade: 1, costModel: ZERO_COSTS, barsPerYear: 8760, tpWeights: [0.5, 0.3, 0.2] };
    const cold = runWalkForward(cs, { paramGrid: [{ direction: 'long' }] as P[], makeEvaluator: needsHistory, isBars: 100, oosBars: 50, base });
    const warm = runWalkForward(cs, {
      paramGrid: [{ direction: 'long' }] as P[],
      makeEvaluator: needsHistory,
      isBars: 100,
      oosBars: 50,
      warmupBars: 60,
      base,
    });
    // Fenster-Raster bleibt identisch (gleiche OOS-Bereiche → vergleichbar)
    expect(warm.windows.map((w) => [w.oosStart, w.oosEnd])).toEqual(cold.windows.map((w) => [w.oosStart, w.oosEnd]));
    expect(warm.combinedOos.tradeCount).toBeGreaterThan(cold.combinedOos.tradeCount);
    // Kein Trade vor dem OOS-Start seines Fensters (Warmup handelt nie)
    for (const w of warm.windows) {
      const startTs = cs[w.oosStart]!.ts.getTime();
      const endTs = cs[w.oosEnd - 1]!.ts.getTime();
      const inWindow = warm.oosTrades.filter((t) => t.entryTs.getTime() >= startTs && t.entryTs.getTime() <= endTs);
      expect(inWindow.length).toBeGreaterThan(0);
    }
    const inSomeOos = (ts: number) =>
      warm.windows.some((w) => ts > cs[w.oosStart]!.ts.getTime() && ts <= cs[w.oosEnd - 1]!.ts.getTime());
    expect(warm.oosTrades.every((t) => inSomeOos(t.entryTs.getTime()))).toBe(true);
  });

  it('Warmup sieht NIE Kerzen nach dem Fensterende (look-ahead-frei)', () => {
    const cs = candles(400);
    let maxSeenTs = 0;
    const spy = (params: P) => {
      const inner = makeEvaluator(params);
      return (slice: Candle[], i: number) => {
        maxSeenTs = Math.max(maxSeenTs, slice[slice.length - 1]!.ts.getTime());
        return inner(slice, i);
      };
    };
    const res = runWalkForward(cs, {
      paramGrid: [{ direction: 'long' }] as P[],
      makeEvaluator: spy,
      isBars: 100,
      oosBars: 50,
      warmupBars: 60,
      base: { initialEquity: 10_000, riskPctPerTrade: 1, costModel: ZERO_COSTS, barsPerYear: 8760, tpWeights: [0.5, 0.3, 0.2] },
    });
    const last = res.windows[res.windows.length - 1]!;
    expect(maxSeenTs).toBeLessThanOrEqual(cs[last.oosEnd - 1]!.ts.getTime());
  });
});
