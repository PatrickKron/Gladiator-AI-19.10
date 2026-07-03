import { describe, expect, it } from 'vitest';
import { computeSwings } from './swings.js';
import type { Candle } from './types.js';

/** Kerze aus (high, low); open/close mittig — für Pivot-Tests reicht das. */
function c(high: number, low: number): Candle {
  const mid = (high + low) / 2;
  return { ts: new Date(0), open: mid, high, low, close: mid, volume: 100 };
}

describe('Swing-Erkennung (pivotHigh/pivotLow, wie im Pine)', () => {
  it('findet ein Swing-Hoch: höher als left UND right Nachbarn (strikt)', () => {
    const candles = [c(10, 9), c(11, 10), c(14, 12), c(11, 10), c(10, 9)];
    const swings = computeSwings(candles, 2, 2);
    const highs = swings.filter((s) => s.type === 'high');
    expect(highs).toHaveLength(1);
    expect(highs[0]).toMatchObject({ index: 2, price: 14, confirmedAt: 4 });
  });

  it('findet ein Swing-Tief', () => {
    const candles = [c(12, 11), c(11, 10), c(10, 7), c(11, 10), c(12, 11)];
    const lows = computeSwings(candles, 2, 2).filter((s) => s.type === 'low');
    expect(lows).toHaveLength(1);
    expect(lows[0]).toMatchObject({ index: 2, price: 7, confirmedAt: 4 });
  });

  it('Plateau ist KEIN Pivot (strikte Ungleichheit, keine Doppel-Signale)', () => {
    const candles = [c(10, 9), c(14, 12), c(14, 12), c(10, 9), c(9, 8)];
    const highs = computeSwings(candles, 1, 1).filter((s) => s.type === 'high');
    expect(highs).toHaveLength(0);
  });

  it('confirmedAt = index + rightBars (look-ahead-Schutz)', () => {
    const candles = [c(10, 9), c(11, 10), c(15, 13), c(11, 10), c(10, 9), c(9, 8), c(8, 7)];
    const highs = computeSwings(candles, 2, 3).filter((s) => s.type === 'high');
    expect(highs[0]!.confirmedAt).toBe(2 + 3);
  });

  it('mehrere Swings in chronologischer Reihenfolge', () => {
    const candles = [
      c(10, 9), c(14, 12), c(10, 9),   // Hoch @1
      c(8, 5), c(10, 9),               // Tief @3
      c(16, 14), c(10, 9), c(9, 8),    // Hoch @5
    ];
    const swings = computeSwings(candles, 1, 1);
    expect(swings.map((s) => [s.type, s.index])).toEqual([
      ['high', 1],
      ['low', 3],
      ['high', 5],
    ]);
  });
});
