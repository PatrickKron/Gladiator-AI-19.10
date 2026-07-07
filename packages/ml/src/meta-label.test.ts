import { describe, it, expect } from 'vitest';
import { labelSignal, batchLabel } from './meta-label.js';
import type { Candle } from '@gladiator/strategy-engine';

function makeCandle(ts: Date, open: number, high: number, low: number, close: number): Candle {
  return { ts, open, high, low, close, volume: 1000 };
}

const BASE_TS = new Date('2024-01-01T00:00:00Z');
function ts(hours: number): Date {
  return new Date(BASE_TS.getTime() + hours * 3600_000);
}

describe('labelSignal — long', () => {
  const candles: Candle[] = [
    makeCandle(ts(0), 100, 105, 95, 100),  // entry bar (index 0)
    makeCandle(ts(1), 100, 102, 98, 101),   // bar 1: no SL, no TP
    makeCandle(ts(2), 101, 103, 99, 102),   // bar 2: no SL, no TP
    makeCandle(ts(3), 102, 112, 101, 110),  // bar 3: TP hit (110)
    makeCandle(ts(4), 110, 115, 108, 112),  // bar 4
  ];

  it('detects TP hit for long', () => {
    const result = labelSignal(candles, {
      direction: 'long',
      entryPrice: 100,
      stopLoss: 90,
      takeProfits: [110],
      entryBarIndex: 0,
      maxHoldingBars: 10,
    });
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe(1);
    expect(result!.exitReason).toBe('tp');
    expect(result!.holdingBars).toBe(3);
    expect(result!.exitPrice).toBe(110);
  });

  it('detects SL hit for long', () => {
    const candlesWithSl: Candle[] = [
      makeCandle(ts(0), 100, 105, 95, 100),
      makeCandle(ts(1), 100, 101, 88, 90),  // bar 1: SL hit at 90
      makeCandle(ts(2), 90, 115, 85, 110),   // bar 2: would hit TP but SL already triggered
    ];
    const result = labelSignal(candlesWithSl, {
      direction: 'long',
      entryPrice: 100,
      stopLoss: 90,
      takeProfits: [110],
      entryBarIndex: 0,
      maxHoldingBars: 10,
    });
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe(0);
    expect(result!.exitReason).toBe('sl');
    expect(result!.holdingBars).toBe(1);
  });

  it('handles timeout with profit', () => {
    const result = labelSignal(candles, {
      direction: 'long',
      entryPrice: 100,
      stopLoss: 90,
      takeProfits: [200], // TP never hit
      entryBarIndex: 0,
      maxHoldingBars: 2,
    });
    expect(result).not.toBeNull();
    expect(result!.exitReason).toBe('timeout');
    expect(result!.outcome).toBe(1); // Close at 102 > entry 100
  });

  it('handles timeout with loss', () => {
    const candlesDown: Candle[] = [
      makeCandle(ts(0), 100, 105, 95, 100),
      makeCandle(ts(1), 100, 101, 96, 97),
      makeCandle(ts(2), 97, 99, 94, 95),
    ];
    const result = labelSignal(candlesDown, {
      direction: 'long',
      entryPrice: 100,
      stopLoss: 80,
      takeProfits: [200],
      entryBarIndex: 0,
      maxHoldingBars: 2,
    });
    expect(result).not.toBeNull();
    expect(result!.exitReason).toBe('timeout');
    expect(result!.outcome).toBe(0); // Close at 95 < entry 100
  });
});

describe('labelSignal — short', () => {
  it('detects TP hit for short', () => {
    const candles: Candle[] = [
      makeCandle(ts(0), 100, 105, 95, 100),
      makeCandle(ts(1), 100, 102, 89, 90),  // TP at 90 hit
    ];
    const result = labelSignal(candles, {
      direction: 'short',
      entryPrice: 100,
      stopLoss: 110,
      takeProfits: [90],
      entryBarIndex: 0,
      maxHoldingBars: 10,
    });
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe(1);
    expect(result!.exitReason).toBe('tp');
  });

  it('detects SL hit for short', () => {
    const candles: Candle[] = [
      makeCandle(ts(0), 100, 105, 95, 100),
      makeCandle(ts(1), 100, 112, 98, 108),  // SL at 110 hit via high
    ];
    const result = labelSignal(candles, {
      direction: 'short',
      entryPrice: 100,
      stopLoss: 110,
      takeProfits: [90],
      entryBarIndex: 0,
      maxHoldingBars: 10,
    });
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe(0);
    expect(result!.exitReason).toBe('sl');
  });
});

describe('labelSignal — edge cases', () => {
  it('returns null for invalid entry bar index', () => {
    const candles: Candle[] = [makeCandle(ts(0), 100, 105, 95, 100)];
    expect(labelSignal(candles, {
      direction: 'long', entryPrice: 100, stopLoss: 90,
      takeProfits: [110], entryBarIndex: 5, maxHoldingBars: 10,
    })).toBeNull();
  });

  it('returns null when entry bar is the last bar', () => {
    const candles: Candle[] = [makeCandle(ts(0), 100, 105, 95, 100)];
    expect(labelSignal(candles, {
      direction: 'long', entryPrice: 100, stopLoss: 90,
      takeProfits: [110], entryBarIndex: 0, maxHoldingBars: 10,
    })).toBeNull();
  });

  it('returns null for zero entry price', () => {
    const candles: Candle[] = [
      makeCandle(ts(0), 100, 105, 95, 100),
      makeCandle(ts(1), 100, 105, 95, 100),
    ];
    expect(labelSignal(candles, {
      direction: 'long', entryPrice: 0, stopLoss: 90,
      takeProfits: [110], entryBarIndex: 0, maxHoldingBars: 10,
    })).toBeNull();
  });
});

describe('batchLabel', () => {
  it('labels multiple signals', () => {
    const candles: Candle[] = [
      makeCandle(ts(0), 100, 105, 95, 100),
      makeCandle(ts(1), 100, 108, 96, 105),  // no SL/TP for either
      makeCandle(ts(2), 105, 112, 103, 110),  // long TP=110 hit (high 112); short SL=110 hit (high 112)
    ];
    const results = batchLabel(candles, [
      { direction: 'long', entryPrice: 100, stopLoss: 90, takeProfits: [110], entryBarIndex: 0, maxHoldingBars: 10 },
      { direction: 'short', entryPrice: 100, stopLoss: 110, takeProfits: [90], entryBarIndex: 0, maxHoldingBars: 10 },
    ]);
    expect(results.length).toBe(2);
    // Long should hit TP at 110 on bar 2
    expect(results[0]!.outcome).toBe(1);
    expect(results[0]!.exitReason).toBe('tp');
    // Short SL hits at 110 on bar 2 (high of bar 2 is 112 >= 110)
    expect(results[1]!.outcome).toBe(0);
    expect(results[1]!.exitReason).toBe('sl');
  });
});
