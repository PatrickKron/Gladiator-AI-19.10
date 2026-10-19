import { describe, it, expect } from 'vitest';
import { FEATURE_MIN_CANDLES } from '@gladiator/ml';
import { computeAllFeatures, autoLabelSignals, retrainModel, parsePgNumericArray, labelHistoryStart } from './ml-pipeline.js';

// These functions require a live DB connection.
// Unit tests verify the export shape; integration tests run on the server.

describe('ml-pipeline exports', () => {
  it('computeAllFeatures is a function', () => {
    expect(typeof computeAllFeatures).toBe('function');
  });

  it('autoLabelSignals is a function', () => {
    expect(typeof autoLabelSignals).toBe('function');
  });

  it('retrainModel is a function', () => {
    expect(typeof retrainModel).toBe('function');
  });
});

describe('parsePgNumericArray', () => {
  it('parst ein Postgres-Array-Literal mit mehreren Werten', () => {
    expect(parsePgNumericArray('{61000,62000.5,63000}')).toEqual([61000, 62000.5, 63000]);
  });

  it('parst gequotete Elemente (numeric kommt teils als "123.45")', () => {
    expect(parsePgNumericArray('{"61000.10","62000"}')).toEqual([61000.1, 62000]);
  });

  it('leeres Array-Literal → []', () => {
    expect(parsePgNumericArray('{}')).toEqual([]);
  });

  it('ignoriert nicht-numerische Elemente statt zu werfen', () => {
    expect(parsePgNumericArray('{61000,NULL}')).toEqual([61000]);
  });

  it('Regression: das echte Live-Format aus db.execute wirft nicht (vorher JSON.parse-SyntaxError)', () => {
    expect(() => parsePgNumericArray('{118372.1,119200}')).not.toThrow();
    expect(parsePgNumericArray('{118372.1,119200}')).toEqual([118372.1, 119200]);
  });
});

describe('labelHistoryStart (Audit 2026-10-19: Labels bekamen nie Features)', () => {
  it('lädt genug Vorlauf für einen Feature-Vektor (≥ 220 Kerzen VOR dem Signal)', () => {
    const createdAt = new Date('2026-10-01T12:00:00Z');
    const start = labelHistoryStart(createdAt, '1h');
    const barsBefore = (createdAt.getTime() - start.getTime()) / 3_600_000;
    expect(barsBefore).toBeGreaterThanOrEqual(FEATURE_MIN_CANDLES);
  });

  it('skaliert mit dem Timeframe', () => {
    const createdAt = new Date('2026-10-01T12:00:00Z');
    const h1 = createdAt.getTime() - labelHistoryStart(createdAt, '1h').getTime();
    const h4 = createdAt.getTime() - labelHistoryStart(createdAt, '4h').getTime();
    expect(h4).toBe(h1 * 4);
  });

  it('unbekannter Timeframe → 1h-Annahme statt Absturz', () => {
    const createdAt = new Date('2026-10-01T12:00:00Z');
    expect(labelHistoryStart(createdAt, 'xyz').getTime()).toBe(labelHistoryStart(createdAt, '1h').getTime());
  });
});
