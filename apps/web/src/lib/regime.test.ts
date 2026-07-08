import { describe, expect, it } from 'vitest';
import { normalizeRegime, REGIME_COLORS, REGIME_ICONS, REGIME_NAMES } from './regime.js';

/**
 * Wächter gegen den „regime.undefined (NaN % Konfidenz)"-Bug: das Backend
 * liefert das Regime TOP-LEVEL; wer versehentlich `response.regime` (den
 * String) normalisiert, bekommt null statt kaputter Anzeige.
 */
describe('normalizeRegime', () => {
  it('akzeptiert die echte Backend-Shape (top-level)', () => {
    const backendResponse = {
      regime: 'sideways',
      confidence: 0.8979,
      components: [
        { name: 'trend', score: -0.13, detail: 'neutral (ret20=-0.86%)' },
        { name: 'volatility', score: 0.37, detail: 'vol=0.344%' },
      ],
      ts: '2026-07-08T07:00:00.000Z',
      cached: false,
    };
    const d = normalizeRegime(backendResponse);
    expect(d).not.toBeNull();
    expect(d!.regime).toBe('sideways');
    expect(d!.confidence).toBeCloseTo(0.8979);
    expect(d!.components).toHaveLength(2);
  });

  it('Leer-Fall des Backends (regime: null + reason) → null, kein Crash', () => {
    expect(
      normalizeRegime({ regime: null, confidence: 0, components: [], ts: null, cached: false, reason: 'Insufficient candles' }),
    ).toBeNull();
  });

  it('der historische Fehlgriff — String statt Objekt — ergibt null statt NaN-Anzeige', () => {
    expect(normalizeRegime('sideways')).toBeNull();
    expect(normalizeRegime(undefined)).toBeNull();
    expect(normalizeRegime(null)).toBeNull();
    expect(normalizeRegime({})).toBeNull();
  });

  it('unbekannter Regime-Name → null (kein regime.undefined-i18n-Key)', () => {
    expect(normalizeRegime({ regime: 'mega_bull', confidence: 0.9, components: [] })).toBeNull();
  });

  it('kaputte confidence wird 0 statt NaN', () => {
    const d = normalizeRegime({ regime: 'bull', confidence: 'hoch', components: [] });
    expect(d!.confidence).toBe(0);
    expect(Number.isNaN(d!.confidence)).toBe(false);
  });

  it('components: nur wohlgeformte Einträge überleben, fehlend → []', () => {
    const d = normalizeRegime({ regime: 'bear', confidence: 0.5, components: [{ name: 'trend', score: 1, detail: 'x' }, 'kaputt', null] });
    expect(d!.components).toEqual([{ name: 'trend', score: 1, detail: 'x' }]);
    expect(normalizeRegime({ regime: 'bear', confidence: 0.5 })!.components).toEqual([]);
  });

  it('für jedes Regime existieren Farbe und Icon', () => {
    for (const name of REGIME_NAMES) {
      expect(REGIME_COLORS[name]).toBeTruthy();
      expect(REGIME_ICONS[name]).toBeTruthy();
    }
  });
});
