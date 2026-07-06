import { describe, expect, it } from 'vitest';
import { adx, obv, stochastic, supertrend, vwap } from './indicators-extra.js';
import type { Candle } from './types.js';

function candle(o: number, h: number, l: number, c: number, v = 100): Candle {
  return { ts: new Date(0), open: o, high: h, low: l, close: c, volume: v };
}

describe('VWAP', () => {
  it('kumulativ: konstanter Typical Price → VWAP = dieser Preis', () => {
    const cs = Array.from({ length: 10 }, () => candle(10, 12, 8, 10, 50)); // tp = 10
    const out = vwap(cs);
    expect(out[9]).toBeCloseTo(10);
  });

  it('gewichtet nach Volumen (handgerechnet)', () => {
    // tp1=10 (vol 100), tp2=20 (vol 300) → VWAP = (10*100 + 20*300)/400 = 17.5
    const cs = [candle(10, 10, 10, 10, 100), candle(20, 20, 20, 20, 300)];
    const out = vwap(cs);
    expect(out[0]).toBeCloseTo(10);
    expect(out[1]).toBeCloseTo(17.5);
  });

  it('rollend über period reagiert auf jüngste Kerzen', () => {
    const cs = [candle(10, 10, 10, 10, 100), candle(10, 10, 10, 10, 100), candle(20, 20, 20, 20, 100)];
    const out = vwap(cs, 2); // letzte 2: (10+20)/2 gewichtet gleich = 15
    expect(out[2]).toBeCloseTo(15);
  });

  it('Nullvolumen-Fenster → null (kein Raten)', () => {
    const cs = [candle(10, 10, 10, 10, 0), candle(20, 20, 20, 20, 0)];
    expect(vwap(cs)[1]).toBeNull();
  });
});

describe('Stochastic', () => {
  it('Schluss am Fenster-Hoch → %K = 100', () => {
    const cs = Array.from({ length: 20 }, (_, i) => candle(0, i + 1, 0, i + 1)); // steigend, close=high
    const { k } = stochastic(cs, 14, 3, 1);
    expect(k[19]).toBeCloseTo(100);
  });

  it('Schluss am Fenster-Tief → %K = 0', () => {
    const cs = Array.from({ length: 20 }, (_, i) => candle(0, 100 - i, -i, 100 - i - 0)).map((c) => ({ ...c, low: c.close, high: 100 }));
    const { k } = stochastic(cs, 14, 3, 1);
    // Schluss = tiefster Wert im Fenster → 0
    expect(k[19]).toBeLessThan(20);
  });

  it('%D ist der geglättete %K, gleiche Länge, null vor Fenster', () => {
    const cs = Array.from({ length: 30 }, (_, i) => candle(i, i + 2, i - 2, i + 1));
    const { k, d } = stochastic(cs, 14, 3, 1);
    expect(k).toHaveLength(30);
    expect(d).toHaveLength(30);
    expect(k[5]).toBeNull();
    expect(d[29]).not.toBeNull();
  });
});

describe('ADX / DMI (Wilder)', () => {
  it('anhaltender Aufwärtstrend → +DI > -DI und ADX steigt über 20', () => {
    const cs = Array.from({ length: 60 }, (_, i) => candle(100 + i, 100 + i + 1.5, 100 + i - 0.2, 100 + i + 1));
    const { plusDi, minusDi, adx: a } = adx(cs, 14);
    expect(plusDi[59]!).toBeGreaterThan(minusDi[59]!);
    expect(a[59]!).toBeGreaterThan(20);
  });

  it('gibt ausgerichtete Arrays gleicher Länge, null vor Warmup', () => {
    const cs = Array.from({ length: 40 }, (_, i) => candle(100 + i, 101 + i, 99 + i, 100 + i));
    const { adx: a } = adx(cs, 14);
    expect(a).toHaveLength(40);
    expect(a[5]).toBeNull();
  });
});

describe('Supertrend (ATR-basiert)', () => {
  it('Aufwärtstrend → Supertrend-Band unter dem Preis (dir = up)', () => {
    const cs = Array.from({ length: 40 }, (_, i) => candle(100 + i, 100 + i + 1, 100 + i - 0.5, 100 + i + 0.8));
    const out = supertrend(cs, 10, 3);
    const last = out[39]!;
    expect(last.direction).toBe('up');
    expect(last.value).toBeLessThan(cs[39]!.close);
  });

  it('null vor ATR-Warmup, dann durchgehend definiert', () => {
    const cs = Array.from({ length: 30 }, (_, i) => candle(50, 51, 49, 50 + (i % 2 === 0 ? 0.2 : -0.2)));
    const out = supertrend(cs, 10, 3);
    expect(out[3]).toBeNull();
    expect(out[29]).not.toBeNull();
  });
});

describe('OBV', () => {
  it('addiert Volumen bei Anstieg, subtrahiert bei Rückgang', () => {
    const cs = [candle(0, 0, 0, 10, 100), candle(0, 0, 0, 12, 50), candle(0, 0, 0, 11, 30)];
    const out = obv(cs);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(50); // Anstieg → +50
    expect(out[2]).toBe(20); // Rückgang → -30
  });
});
