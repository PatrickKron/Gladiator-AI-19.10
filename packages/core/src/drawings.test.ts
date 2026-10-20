import { describe, expect, it } from 'vitest';
import {
  DRAWING_KINDS,
  DRAWING_POINT_COUNT,
  FIB_LEVELS,
  MAX_DRAWINGS_PER_SYMBOL,
  fibLevelPrices,
  validateDrawingPoints,
  validateDrawingStyle,
} from './drawings.js';

describe('Chart-Zeichnungen: Konstanten', () => {
  it('kennt genau hline/trend/fib mit 1/2/2 Ankern', () => {
    expect([...DRAWING_KINDS]).toEqual(['hline', 'trend', 'fib']);
    expect(DRAWING_POINT_COUNT).toEqual({ hline: 1, trend: 2, fib: 2 });
  });
  it('Fibonacci-Stufen 0 … 1 (aufsteigend) und Limit 200', () => {
    expect([...FIB_LEVELS]).toEqual([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
    expect(MAX_DRAWINGS_PER_SYMBOL).toBe(200);
  });
});

describe('fibLevelPrices', () => {
  it('Level 0 am End-Anker, Level 1 am Start-Anker (Zug von Tief nach Hoch)', () => {
    const lv = fibLevelPrices({ time: 1, price: 100 }, { time: 2, price: 200 });
    expect(lv.map((l) => l.level)).toEqual([...FIB_LEVELS]);
    expect(lv[0]!.price).toBe(200);
    expect(lv[6]!.price).toBe(100);
    expect(lv[3]!.price).toBe(150);
    expect(lv[4]!.price).toBeCloseTo(138.2, 10);
  });
  it('funktioniert auch abwärts (Hoch → Tief)', () => {
    const lv = fibLevelPrices({ time: 1, price: 200 }, { time: 2, price: 100 });
    expect(lv[0]!.price).toBe(100);
    expect(lv[6]!.price).toBe(200);
    expect(lv[2]!.price).toBeCloseTo(138.2, 10);
  });
});

describe('validateDrawingPoints', () => {
  const p = (time: number, price: number) => ({ time, price });
  it('akzeptiert gültige Anker je Art', () => {
    expect(validateDrawingPoints('hline', [p(1_700_000_000, 42_000)])).toBeNull();
    expect(validateDrawingPoints('trend', [p(1_700_000_000, 1), p(1_700_003_600, 2)])).toBeNull();
    expect(validateDrawingPoints('fib', [p(1_700_000_000, 1), p(1_700_000_000, 2)])).toBeNull();
  });
  it('lehnt falsche Anzahl je Art ab', () => {
    expect(validateDrawingPoints('hline', [])).toMatch(/1/);
    expect(validateDrawingPoints('hline', [p(1, 1), p(2, 2)])).toMatch(/1/);
    expect(validateDrawingPoints('trend', [p(1_700_000_000, 1)])).toMatch(/2/);
    expect(validateDrawingPoints('fib', [p(1, 1), p(2, 2), p(3, 3)])).toMatch(/2/);
  });
  it('lehnt nicht-endliche / nicht-positive Werte ab', () => {
    expect(validateDrawingPoints('hline', [p(1_700_000_000, Number.NaN)])).not.toBeNull();
    expect(validateDrawingPoints('hline', [p(1_700_000_000, Number.POSITIVE_INFINITY)])).not.toBeNull();
    expect(validateDrawingPoints('hline', [p(1_700_000_000, 0)])).not.toBeNull();
    expect(validateDrawingPoints('hline', [p(1_700_000_000, -5)])).not.toBeNull();
    expect(validateDrawingPoints('hline', [p(Number.NaN, 5)])).not.toBeNull();
    expect(validateDrawingPoints('hline', [p(-1, 5)])).not.toBeNull();
    // Millisekunden statt Sekunden → abgelehnt
    expect(validateDrawingPoints('hline', [p(1_700_000_000_000, 5)])).not.toBeNull();
  });
  it('lehnt entartete Formen ab', () => {
    expect(validateDrawingPoints('trend', [p(1_700_000_000, 1), p(1_700_000_000, 2)])).toMatch(/Zeit/);
    expect(validateDrawingPoints('fib', [p(1_700_000_000, 5), p(1_700_003_600, 5)])).toMatch(/Preis/);
  });
  it('lehnt unbekannte Art ab', () => {
    expect(validateDrawingPoints('circle' as never, [p(1, 1)])).not.toBeNull();
  });
});

describe('validateDrawingStyle', () => {
  it('null/leer ist ok, Hex-Farbe + Linienbreite 1..4 ok', () => {
    expect(validateDrawingStyle(null)).toBeNull();
    expect(validateDrawingStyle({})).toBeNull();
    expect(validateDrawingStyle({ color: '#4fd1ff', lineWidth: 2 })).toBeNull();
  });
  it('lehnt beliebige Strings / Breiten ab', () => {
    expect(validateDrawingStyle({ color: 'red;background:url(x)' })).not.toBeNull();
    expect(validateDrawingStyle({ lineWidth: 9 })).not.toBeNull();
    expect(validateDrawingStyle({ lineWidth: 1.5 })).not.toBeNull();
  });
});
