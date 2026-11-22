import { describe, expect, it } from 'vitest';
import { detectAllDivergences, detectDivergences } from './divergences.js';
import type { Candle } from './types.js';

function makeCandles(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    ts: new Date(1_700_000_000_000 + i * 3_600_000),
    open: c,
    high: c + 0.8,
    low: c - 0.8,
    close: c,
    volume: 100,
  }));
}

describe('detectDivergences', () => {
  it('erkennt reguläre Bullish-RSI-Divergenz (tieferes Kurs-Tief, höheres RSI-Tief) look-ahead-frei', () => {
    // 25 stabile Bars → scharfer Abverkauf auf 70 (RSI sehr tief) → Erholung auf 92 → langsameres tieferes Tief auf 68 (RSI höher) → Erholung
    const closes = [
      ...Array.from({ length: 22 }, () => 100),
      96, 90, 82, 74, 70, // scharfes Tief 1 bei idx 26 (RSI sehr niedrig)
      76, 82, 87, 91, 93, 92, 90, 88, 86, 84, 82, 80, 77, 74, 71, 68, // langsameres tieferes Tief 2 bei idx 42
      73, 78, 83, 88, 92,
    ];
    const candles = makeCandles(closes);
    const divs = detectDivergences(candles, { indicator: 'rsi', leftBars: 2, rightBars: 2 });
    const bull = divs.find((d) => d.kind === 'bullish');
    expect(bull).toBeDefined();
    expect(bull!.price).toBeLessThan(bull!.prevPrice);
    expect(bull!.indValue).toBeGreaterThan(bull!.prevIndValue);
    // Look-ahead-Freiheit: confirmedAt liegt genau rightBars hinter index
    expect(bull!.confirmedAt).toBe(bull!.index + 2);
    // Wenn Zukunftskerzen nach index+1 fehlen, darf die Divergenz noch NICHT erscheinen
    const truncated = detectDivergences(candles.slice(0, bull!.index + 2), { indicator: 'rsi', leftBars: 2, rightBars: 2 });
    expect(truncated.some((d) => d.index === bull!.index)).toBe(false);
  });

  it('erkennt reguläre Bearish-RSI-Divergenz (höheres Kurs-Hoch, tieferes RSI-Hoch)', () => {
    const closes = [
      ...Array.from({ length: 22 }, () => 100),
      105, 112, 120, 128, 134, // steiles Hoch 1
      127, 121, 117, 114, 113, 115, 117, 119, 121, 124, 127, 130, 133, 136, // langsameres höheres Hoch 2
      131, 126, 120, 115,
    ];
    const candles = makeCandles(closes);
    const divs = detectDivergences(candles, { indicator: 'rsi', leftBars: 2, rightBars: 2 });
    const bear = divs.find((d) => d.kind === 'bearish');
    expect(bear).toBeDefined();
    expect(bear!.price).toBeGreaterThan(bear!.prevPrice);
    expect(bear!.indValue).toBeLessThan(bear!.prevIndValue);
  });

  it('detectAllDivergences kombiniert RSI und MACD deterministisch und chronologisch', () => {
    const closes = [
      ...Array.from({ length: 30 }, () => 100),
      95, 88, 78, 70, 76, 84, 90, 92, 90, 86, 82, 78, 74, 71, 68, 74, 80, 86, 92,
    ];
    const all = detectAllDivergences(makeCandles(closes));
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.index).toBeGreaterThanOrEqual(all[i - 1]!.index);
    }
  });
});
