import { describe, expect, it } from 'vitest';
import { atr, ema, rsi, sma } from './indicators.js';
import type { Candle } from './types.js';

function candle(o: number, h: number, l: number, c: number, v = 100): Candle {
  return { ts: new Date(0), open: o, high: h, low: l, close: c, volume: v };
}

describe('SMA', () => {
  it('berechnet den gleitenden Durchschnitt korrekt', () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(2);
    expect(out[3]).toBeCloseTo(3);
    expect(out[4]).toBeCloseTo(4);
  });
});

describe('EMA', () => {
  it('konstante Serie → EMA = Konstante', () => {
    const out = ema(Array(50).fill(42), 20);
    expect(out[49]).toBeCloseTo(42);
  });

  it('gewichtet neue Werte mit k = 2/(n+1) (handgerechnet)', () => {
    // n=3 → k=0.5; Seed = SMA(1,2,3)=2; dann EMA=0.5*10+0.5*2=6
    const out = ema([1, 2, 3, 10], 3);
    expect(out[2]).toBeCloseTo(2);
    expect(out[3]).toBeCloseTo(6);
  });

  it('liefert null vor der Seed-Periode', () => {
    expect(ema([1, 2, 3, 4], 3)[1]).toBeNull();
  });
});

describe('RSI (Wilder)', () => {
  it('nur steigende Kerzen → RSI 100', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const out = rsi(closes, 14);
    expect(out[29]).toBeCloseTo(100);
  });

  it('nur fallende Kerzen → RSI 0', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 - i);
    const out = rsi(closes, 14);
    expect(out[29]).toBeCloseTo(0);
  });

  it('gleich starke Auf- und Abbewegungen → RSI ≈ 50', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
    const out = rsi(closes, 14);
    expect(out[59]!).toBeGreaterThan(45);
    expect(out[59]!).toBeLessThan(55);
  });
});

describe('ATR (Wilder)', () => {
  it('konstante Range → ATR = Range', () => {
    const candles = Array.from({ length: 40 }, () => candle(100, 105, 95, 100));
    const out = atr(candles, 14);
    expect(out[39]).toBeCloseTo(10, 5);
  });

  it('berücksichtigt Gaps über True Range', () => {
    // Kerze 2 gappt nach oben: TR = max(high-low, |high-prevClose|, |low-prevClose|)
    const candles = [candle(100, 101, 99, 100), candle(120, 121, 119, 120)];
    const out = atr(candles, 1);
    expect(out[1]).toBeCloseTo(21); // |121 - 100| = 21
  });
});
