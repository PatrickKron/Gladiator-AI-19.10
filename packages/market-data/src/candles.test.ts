import { describe, expect, it } from 'vitest';
import { parseCandle, sanitizeCandles, validateCandle, type RawOhlcv } from './candles.js';

const NOW = Date.now();
const ok: RawOhlcv = [NOW - 3_600_000, 100, 110, 95, 105, 1234];

describe('Kerzen-Datenqualität (08_ §3b)', () => {
  it('akzeptiert eine plausible Kerze', () => {
    expect(validateCandle(parseCandle(ok))).toEqual([]);
  });

  it('lehnt high < low ab', () => {
    expect(validateCandle(parseCandle([NOW, 100, 90, 95, 100, 10]))).toContain('high < low');
  });

  it('lehnt Preise <= 0 ab', () => {
    expect(validateCandle(parseCandle([NOW, 0, 110, 95, 105, 10]))).toContain('Preis <= 0');
  });

  it('lehnt high unter open/close und low über open/close ab', () => {
    expect(validateCandle(parseCandle([NOW, 100, 102, 95, 105, 10]))).toContain('high unter open/close');
    expect(validateCandle(parseCandle([NOW, 100, 110, 101, 105, 10]))).toContain('low über open/close');
  });

  it('lehnt negatives Volumen, NaN und Zukunfts-Timestamps ab', () => {
    expect(validateCandle(parseCandle([NOW, 100, 110, 95, 105, -1]))).toContain('negatives Volumen');
    expect(validateCandle(parseCandle([NOW, NaN, 110, 95, 105, 10]))).toContain('nicht-numerischer Wert');
    expect(validateCandle(parseCandle([NOW + 3_600_000, 100, 110, 95, 105, 10]))).toContain(
      'Timestamp in der Zukunft',
    );
  });

  it('sanitizeCandles trennt gültig/verworfen und erfindet nichts', () => {
    const bad: RawOhlcv = [NOW, 100, 90, 95, 100, 10];
    const { valid, rejected } = sanitizeCandles([ok, bad]);
    expect(valid).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.errors.length).toBeGreaterThan(0);
  });
});
