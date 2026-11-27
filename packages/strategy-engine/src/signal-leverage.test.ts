import { describe, expect, it } from 'vitest';
import { EXCHANGE_LEVERAGE_STEPS, EXCHANGE_MAX_LEVERAGE, suggestSignalLeverage } from './signal-leverage.js';

describe('suggestSignalLeverage (Welle 29 — Intelligente Signal-Vorbelegung & 125x Börsen-Hebel)', () => {
  it('übernimmt einen expliziten Strategie-Hebel (> 1x), sofern vorhanden', () => {
    expect(
      suggestSignalLeverage({
        entry: 90_000,
        stopLoss: 88_500,
        setupType: 'swing',
        strategyLeverage: 15,
      }),
    ).toBe(15);
  });

  it('berechnet für Engine-/Standard-Signale ohne festen Strategie-Hebel einen zum Setup & Stop passenden Hebel', () => {
    // Scalp mit engem Stop (0,8 %) und hohem Score (8,5) -> 10x
    const scalpLev = suggestSignalLeverage({
      entry: 100,
      stopLoss: 99.2,
      setupType: 'scalp',
      score: 8.5,
      riskClass: 'low',
    });
    expect(scalpLev).toBe(10);

    // Swing mit 1,5 % Stop -> 5x
    const swingLev = suggestSignalLeverage({
      entry: 100,
      stopLoss: 98.5,
      setupType: 'swing',
      score: 7.2,
      riskClass: 'medium',
    });
    expect(swingLev).toBe(5);

    // Position mit weitem 12 % Stop -> durch safeMaxFromStop (45 / 12 = 3x) sicher begrenzt
    const wideStopLev = suggestSignalLeverage({
      entry: 100,
      stopLoss: 88,
      setupType: 'scalp',
      score: 9.0,
    });
    expect(wideStopLev).toBe(3);
  });

  it('bleibt bei Yahoo / Twelve-Data Schlusskurs-Venues ehrlich auf 1x', () => {
    expect(
      suggestSignalLeverage({
        entry: 200,
        stopLoss: 196,
        setupType: 'scalp',
        venue: 'yahoo',
        strategyLeverage: 10,
      }),
    ).toBe(1);
  });

  it('stellt Börsen-Hebelstufen bis 125x bereit', () => {
    expect(EXCHANGE_MAX_LEVERAGE).toBe(125);
    expect(EXCHANGE_LEVERAGE_STEPS).toContain(25);
    expect(EXCHANGE_LEVERAGE_STEPS).toContain(50);
    expect(EXCHANGE_LEVERAGE_STEPS).toContain(100);
    expect(EXCHANGE_LEVERAGE_STEPS).toContain(125);
  });
});
