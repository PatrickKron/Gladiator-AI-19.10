import { describe, it, expect } from 'vitest';
import { computeAllFeatures, autoLabelSignals, retrainModel, parsePgNumericArray } from './ml-pipeline.js';

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
