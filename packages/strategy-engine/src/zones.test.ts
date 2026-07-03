import { describe, expect, it } from 'vitest';
import { detectFvgs, detectOrderBlocks } from './zones.js';
import type { Candle } from './types.js';

function c(open: number, high: number, low: number, close: number, volume = 100): Candle {
  return { ts: new Date(0), open, high, low, close, volume };
}

describe('Order Blocks (05_ §3: letzte Gegenkerze vor impulsiver Bewegung, Range > 1,5×)', () => {
  it('bullish OB: bearishe Kerze, danach impulsive bullishe Kerze über deren Hoch', () => {
    const candles = [
      c(100, 101, 99, 100),
      c(101, 102, 98, 99),      // @1: bearish (Gegenkerze), Range 4
      c(99, 106, 98.5, 105.5),  // @2: bullish, Range 7.5 > 1.5×4, close > high[1] → OB @1
      c(105, 107, 104, 106),
    ];
    const obs = detectOrderBlocks(candles);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ kind: 'bullish-ob', index: 1, top: 102, bottom: 98, createdAt: 2 });
  });

  it('bearish OB: bullishe Kerze, danach impulsive bearishe Kerze unter deren Tief', () => {
    const candles = [
      c(100, 101, 99, 100),
      c(99, 102, 98.5, 101.5),  // @1: bullish, Range 3.5
      c(101, 101.5, 95, 95.5),  // @2: bearish, Range 6.5 > 1.5×3.5, close < low[1] → OB @1
    ];
    const obs = detectOrderBlocks(candles);
    expect(obs[0]).toMatchObject({ kind: 'bearish-ob', index: 1, top: 102, bottom: 98.5 });
  });

  it('KEIN OB ohne Impulsivität (Folgekerze zu klein)', () => {
    const candles = [
      c(101, 102, 98, 99),      // bearish, Range 4
      c(99, 103, 98.8, 102.5),  // bullish, aber Range 4.2 < 1.5×4 = 6
    ];
    expect(detectOrderBlocks(candles)).toHaveLength(0);
  });

  it('KEIN OB wenn Folgekerze das Hoch der Gegenkerze nicht überwindet', () => {
    const candles = [
      c(101, 102, 98, 99),
      c(99, 101.8, 92, 101.5), // groß, aber close 101.5 < high[0]=102
    ];
    expect(detectOrderBlocks(candles)).toHaveLength(0);
  });

  it('Mitigation: Rückkehr in die Zone setzt mitigatedAt', () => {
    const candles = [
      c(101, 102, 98, 99),
      c(99, 106, 98.5, 105.5),
      c(105, 107, 104, 106),
      c(106, 106.5, 101, 102), // @3: low 101 ≤ top 102 → Zone berührt
    ];
    const obs = detectOrderBlocks(candles);
    expect(obs[0]!.mitigatedAt).toBe(3);
  });
});

describe('FVG (05_ §3: 3-Kerzen-Imbalance)', () => {
  it('bullish FVG: low der 3. Kerze > high der 1. Kerze', () => {
    const candles = [
      c(100, 102, 99, 101),
      c(102, 108, 101.5, 107),
      c(107, 110, 104, 109), // low 104 > high[0] 102 → Gap [102, 104]
    ];
    const fvgs = detectFvgs(candles);
    expect(fvgs).toHaveLength(1);
    expect(fvgs[0]).toMatchObject({ kind: 'bullish-fvg', index: 1, bottom: 102, top: 104, createdAt: 2 });
  });

  it('bearish FVG: high der 3. Kerze < low der 1. Kerze', () => {
    const candles = [
      c(100, 101, 98, 99),
      c(98, 98.5, 92, 93),
      c(93, 95, 91, 94), // high 95 < low[0] 98 → Gap [95, 98]
    ];
    const fvgs = detectFvgs(candles);
    expect(fvgs[0]).toMatchObject({ kind: 'bearish-fvg', bottom: 95, top: 98 });
  });

  it('kein FVG bei Überlappung', () => {
    const candles = [c(100, 102, 99, 101), c(101, 103, 100, 102), c(102, 104, 101.5, 103)];
    expect(detectFvgs(candles)).toHaveLength(0);
  });

  it('gefülltes Gap bekommt filledAt (bullish: low fällt auf/unter Gap-Boden)', () => {
    const candles = [
      c(100, 102, 99, 101),
      c(102, 108, 101.5, 107),
      c(107, 110, 104, 109),
      c(109, 109.5, 101.5, 103), // @3: low 101.5 ≤ bottom 102 → gefüllt
    ];
    const fvgs = detectFvgs(candles);
    expect(fvgs[0]!.filledAt).toBe(3);
  });
});
