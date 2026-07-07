import { describe, expect, it } from 'vitest';
import {
  BARS_PER_YEAR,
  SUPPORTED_TIMEFRAMES,
  TIMEFRAME_MS,
  isSupportedTimeframe,
  orderTimeframes,
} from './timeframes.js';

/** Kanonische Timeframes (Feature A) — pur, TDD. */

describe('SUPPORTED_TIMEFRAMES', () => {
  it('enthält die neuen TFs zusätzlich zu den bisherigen 4', () => {
    for (const tf of ['15m', '1h', '4h', '1d']) expect(SUPPORTED_TIMEFRAMES).toContain(tf); // Bestand
    for (const tf of ['5m', '30m', '2h', '12h', '1w', '1M']) expect(SUPPORTED_TIMEFRAMES).toContain(tf); // neu
  });

  it('für jeden TF gibt es Bar-Länge und Bars/Jahr', () => {
    for (const tf of SUPPORTED_TIMEFRAMES) {
      expect(TIMEFRAME_MS[tf]).toBeGreaterThan(0);
      expect(BARS_PER_YEAR[tf]).toBeGreaterThan(0);
    }
  });
});

describe('isSupportedTimeframe', () => {
  it.each([
    ['1h', true],
    ['12h', true],
    ['1M', true],
    ['3d', false], // von uns nicht angeboten
    ['', false],
    [null, false],
  ])('%s → %s', (input, expected) => {
    expect(isSupportedTimeframe(input as string | null)).toBe(expected);
  });
});

describe('orderTimeframes', () => {
  it('bringt vorhandene TFs in kanonische Reihenfolge, filtert Unbekanntes', () => {
    expect(orderTimeframes(['1d', '5m', '1h', 'nonsense', '4h'])).toEqual(['5m', '1h', '4h', '1d']);
  });
  it('leere Eingabe → leer', () => {
    expect(orderTimeframes([])).toEqual([]);
  });
});
