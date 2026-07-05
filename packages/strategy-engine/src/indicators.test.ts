import { describe, expect, it } from 'vitest';
import { atr, bollinger, ema, macd, rsi, sma } from './indicators.js';
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

describe('MACD (12/26/9)', () => {
  it('konstante Serie → MACD-Linie und Histogramm 0', () => {
    const closes = Array(60).fill(100);
    const { macd: line, signal, histogram } = macd(closes);
    expect(line[59]).toBeCloseTo(0, 8);
    expect(signal[59]).toBeCloseTo(0, 8);
    expect(histogram[59]).toBeCloseTo(0, 8);
  });

  it('null vor definierten EMAs, danach ausgerichtete Serien gleicher Länge', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
    const { macd: line, signal, histogram } = macd(closes);
    expect(line).toHaveLength(60);
    expect(signal).toHaveLength(60);
    expect(histogram).toHaveLength(60);
    expect(line[10]).toBeNull(); // vor slow-EMA-Seed (26)
    expect(line[59]).not.toBeNull();
  });

  it('steigende Serie → MACD-Linie positiv (fast über slow)', () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 2);
    const { macd: line } = macd(closes);
    expect(line[79]!).toBeGreaterThan(0);
  });
});

describe('Bollinger', () => {
  it('konstante Serie → Bänder = Mittelband (σ = 0)', () => {
    const closes = Array(30).fill(50);
    const { middle, upper, lower } = bollinger(closes, 20, 2);
    expect(middle[29]).toBeCloseTo(50);
    expect(upper[29]).toBeCloseTo(50);
    expect(lower[29]).toBeCloseTo(50);
  });

  it('null vor vollem Fenster, danach oben > Mitte > unten', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 5 : -5));
    const { middle, upper, lower } = bollinger(closes, 20, 2);
    expect(middle[18]).toBeNull();
    expect(upper[39]!).toBeGreaterThan(middle[39]!);
    expect(middle[39]!).toBeGreaterThan(lower[39]!);
  });

  it('handgerechnet: σ eines bekannten Fensters', () => {
    // 20× Werte: zehn 0 und zehn 10 → mean 5, Populations-σ = 5
    const closes = Array.from({ length: 20 }, (_, i) => (i < 10 ? 0 : 10));
    const { middle, upper, lower } = bollinger(closes, 20, 2);
    expect(middle[19]).toBeCloseTo(5);
    expect(upper[19]).toBeCloseTo(15); // 5 + 2*5
    expect(lower[19]).toBeCloseTo(-5); // 5 - 2*5
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
