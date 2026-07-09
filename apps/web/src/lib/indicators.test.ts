import { describe, expect, it } from 'vitest';
import {
  bollinger,
  clampFloat,
  clampInt,
  defaultIndicatorConfig,
  ema,
  macd,
  MAX_MAS,
  rsi,
  sanitizeIndicatorConfig,
  sma,
  toTimedSeries,
} from './indicators.js';

/**
 * Handgerechnete Referenzwerte — die Funktionen spiegeln
 * packages/strategy-engine/src/indicators.ts (gleiche Formeln), damit
 * clientseitig gerechnete Perioden zu den Server-Serien passen.
 */

describe('sma', () => {
  it('null vor vollem Fenster, danach korrekte Mittelwerte', () => {
    expect(sma([2, 4, 6, 8], 2)).toEqual([null, 3, 5, 7]);
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it('Periode länger als Input → alles null', () => {
    expect(sma([1, 2], 5)).toEqual([null, null]);
  });
});

describe('ema', () => {
  it('SMA-Seed bei Periode-1, danach k = 2/(n+1)', () => {
    // p=3 → k=0.5; Seed = (1+2+3)/3 = 2; dann 4*0.5+2*0.5=3; 5*0.5+3*0.5=4
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it('zu wenig Werte → alles null', () => {
    expect(ema([1, 2], 3)).toEqual([null, null]);
  });
});

describe('rsi (Wilder)', () => {
  it('nur Gewinne → 100, nur Verluste → 0', () => {
    expect(rsi([1, 2, 3, 4, 5, 6], 3).slice(3)).toEqual([100, 100, 100]);
    expect(rsi([6, 5, 4, 3, 2, 1], 3).slice(3)).toEqual([0, 0, 0]);
  });
  it('gemischte Bewegung: handgerechnet (Periode 2)', () => {
    // Changes: +1, −1, +1 → avgGain=avgLoss=0.5 → RSI=50;
    // danach Wilder-Glättung: avgGain=0.75, avgLoss=0.25 → RSI=75
    const out = rsi([10, 11, 10, 11], 2);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(50, 10);
    expect(out[3]).toBeCloseTo(75, 10);
  });
  it('zu wenig Kerzen → alles null', () => {
    expect(rsi([1, 2, 3], 14)).toEqual([null, null, null]);
  });
});

describe('macd', () => {
  it('Linie = EMA(fast) − EMA(slow) an allen definierten Stellen', () => {
    const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const { macd: line } = macd(closes, 2, 4, 2);
    const fast = ema(closes, 2);
    const slow = ema(closes, 4);
    for (let i = 0; i < closes.length; i++) {
      if (fast[i] != null && slow[i] != null) expect(line[i]).toBeCloseTo(fast[i]! - slow[i]!, 10);
      else expect(line[i]).toBeNull();
    }
  });
  it('Histogramm = Linie − Signal, wo beide definiert sind', () => {
    const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const { macd: line, signal, histogram } = macd(closes, 2, 4, 2);
    for (let i = 0; i < closes.length; i++) {
      if (line[i] != null && signal[i] != null) expect(histogram[i]).toBeCloseTo(line[i]! - signal[i]!, 10);
      else expect(histogram[i]).toBeNull();
    }
  });
  it('konstante Kurse → Linie/Signal/Histogramm = 0', () => {
    const { macd: line, signal, histogram } = macd(new Array<number>(8).fill(5), 2, 3, 2);
    expect(line.filter((v) => v != null).every((v) => v === 0)).toBe(true);
    expect(signal.filter((v) => v != null).every((v) => v === 0)).toBe(true);
    expect(histogram.filter((v) => v != null).every((v) => v === 0)).toBe(true);
  });
});

describe('bollinger', () => {
  it('konstante Kurse → σ=0, alle Bänder auf dem Mittelband', () => {
    const { middle, upper, lower } = bollinger(new Array<number>(6).fill(5), 3, 2);
    expect(middle.slice(2)).toEqual([5, 5, 5, 5]);
    expect(upper.slice(2)).toEqual([5, 5, 5, 5]);
    expect(lower.slice(2)).toEqual([5, 5, 5, 5]);
  });
  it('Populations-σ handgerechnet: [1,2,3], p=3, mult=2', () => {
    // mean=2, var=((−1)²+0²+1²)/3=2/3, σ≈0.8165 → upper≈3.633, lower≈0.367
    const { middle, upper, lower } = bollinger([1, 2, 3], 3, 2);
    expect(middle[2]).toBeCloseTo(2, 10);
    expect(upper[2]).toBeCloseTo(2 + 2 * Math.sqrt(2 / 3), 10);
    expect(lower[2]).toBeCloseTo(2 - 2 * Math.sqrt(2 / 3), 10);
    expect(upper[0]).toBeNull();
    expect(upper[1]).toBeNull();
  });
});

describe('toTimedSeries', () => {
  it('lässt null und nicht-finite Werte weg, behält Zeitzuordnung', () => {
    expect(toTimedSeries([10, 20, 30], [null, 1.5, Number.NaN])).toEqual([{ time: 20, value: 1.5 }]);
  });
});

describe('clampInt / clampFloat', () => {
  it('klemmt, rundet und fällt bei Müll auf den Fallback zurück', () => {
    expect(clampInt(999, 2, 400, 20)).toBe(400);
    expect(clampInt(0, 2, 400, 20)).toBe(2);
    expect(clampInt(14.6, 2, 400, 20)).toBe(15);
    expect(clampInt('50', 2, 400, 20)).toBe(50);
    expect(clampInt('abc', 2, 400, 20)).toBe(20);
    expect(clampInt(undefined, 2, 400, 20)).toBe(20);
    expect(clampFloat(99, 0.5, 5, 2)).toBe(5);
    expect(clampFloat(1.5, 0.5, 5, 2)).toBe(1.5);
    expect(clampFloat(null, 0.5, 5, 2)).toBe(2);
  });
});

describe('sanitizeIndicatorConfig', () => {
  it('Müll-Input → sichere Defaults', () => {
    expect(sanitizeIndicatorConfig(null)).toEqual(defaultIndicatorConfig());
    expect(sanitizeIndicatorConfig('kaputt')).toEqual(defaultIndicatorConfig());
    expect(sanitizeIndicatorConfig(42)).toEqual(defaultIndicatorConfig());
  });

  it('gültige Konfiguration überlebt den Roundtrip unverändert', () => {
    const cfg = {
      mas: [
        { kind: 'ema' as const, period: 100 },
        { kind: 'sma' as const, period: 50 },
      ],
      rsi: { on: true, period: 21 },
      macd: { on: true, fast: 8, slow: 21, signal: 5 },
      bollinger: { on: true, period: 34, mult: 2.5 },
      strategySlugs: ['mein-smc-script'],
    };
    expect(sanitizeIndicatorConfig(JSON.parse(JSON.stringify(cfg)))).toEqual(cfg);
  });

  it('klemmt Perioden und verwirft ungültige MA-Einträge', () => {
    const out = sanitizeIndicatorConfig({
      mas: [
        { kind: 'ema', period: 99999 },
        { kind: 'sma', period: 1 },
        { kind: 'wma', period: 20 }, // unbekannter Typ → raus
        'quatsch',
      ],
    });
    expect(out.mas).toEqual([
      { kind: 'ema', period: 400 },
      { kind: 'sma', period: 2 },
    ]);
  });

  it('kappt die MA-Liste bei MAX_MAS', () => {
    const out = sanitizeIndicatorConfig({
      mas: new Array(20).fill({ kind: 'ema', period: 20 }),
    });
    expect(out.mas).toHaveLength(MAX_MAS);
  });

  it('erzwingt MACD fast < slow', () => {
    const out = sanitizeIndicatorConfig({ macd: { on: true, fast: 30, slow: 26, signal: 9 } });
    expect(out.macd.slow).toBe(26);
    expect(out.macd.fast).toBe(25);
  });

  it('on-Flags nur bei echtem true; kaputte Werte → Defaults', () => {
    const out = sanitizeIndicatorConfig({ rsi: { on: 'yes', period: 'abc' }, bollinger: { on: true, mult: 99 } });
    expect(out.rsi).toEqual({ on: false, period: 14 });
    expect(out.bollinger).toEqual({ on: true, period: 20, mult: 5 });
  });

  it('strategySlugs: nur Strings, dedupliziert', () => {
    const out = sanitizeIndicatorConfig({ strategySlugs: ['a', 5, 'a', '', 'b', null] });
    expect(out.strategySlugs).toEqual(['a', 'b']);
  });

  it('defaultIndicatorConfig liefert unabhängige Objekte (kein Shared State)', () => {
    const a = defaultIndicatorConfig();
    a.rsi.on = true;
    a.mas.push({ kind: 'ema', period: 9 });
    expect(defaultIndicatorConfig().rsi.on).toBe(false);
    expect(defaultIndicatorConfig().mas).toEqual([]);
  });
});
