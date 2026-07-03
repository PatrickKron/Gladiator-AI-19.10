import { describe, expect, it } from 'vitest';
import { evaluateSmcCoreAt, type SmcCoreParams } from './smc-core.js';
import type { Candle } from './types.js';

/**
 * Synthetisches Long-Szenario (kleine Perioden, damit ~20 Kerzen reichen):
 * Aufwärtstrend → Swing-Hoch 114 @12 (bestätigt @14) → BOS @15 (close 116 > 114)
 * → Pullback → @17 Retest: low 113.5 berührt Bruchlevel 114, bullishe Kerze,
 * Volumen 200 > MA. Alle Pflicht-Confluences erfüllt.
 */
function c(open: number, high: number, low: number, close: number, volume = 100, hourUtc = 9): Candle {
  return { ts: new Date(Date.UTC(2026, 6, 3, hourUtc)), open, high, low, close, volume };
}

const TEST_PARAMS: SmcCoreParams = {
  swingLeftBars: 2,
  swingRightBars: 2,
  emaTrendPeriod: 10,
  emaPullbackPeriod: 5,
  rsiPeriod: 5,
  rsiLongMin: 0,
  rsiLongMax: 100,
  rsiShortMin: 0,
  rsiShortMax: 100,
  volumeMaPeriod: 5,
  atrPeriod: 5,
  retestWindowBars: 10,
  emaProximityPct: 2,
  rsiLookbackBars: 1,
};

function longScenario(): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < 10; i++) {
    const base = 100 + i;
    candles.push(c(base - 0.5, base + 1, base - 1, base));
  }
  candles.push(c(109, 110, 108, 109.5)); // 10
  candles.push(c(109.5, 111, 109, 110.5)); // 11
  candles.push(c(110.5, 114, 110, 111)); // 12 ← Swing-Hoch 114
  candles.push(c(111, 111.5, 109.5, 110)); // 13
  candles.push(c(110, 110.5, 108.5, 109.5)); // 14 (Pivot @12 bestätigt)
  candles.push(c(109.5, 116.5, 109, 116)); // 15 ← BOS: close 116 > 114
  candles.push(c(116, 116.5, 114.5, 115)); // 16 Pullback beginnt
  candles.push(c(114.5, 116, 113.5, 115.5, 200)); // 17 ← RETEST: low ≤ 114, bullish, Volumen
  return candles;
}

describe('SMC Core (05_ §4 — Pine-Referenz, Retest ist PFLICHT)', () => {
  it('erzeugt am Retest-Bar drei Setups (scalp/swing/position) mit echtem Score', () => {
    const candles = longScenario();
    const setups = evaluateSmcCoreAt(candles, 17, TEST_PARAMS, { higherTfTrend: 'neutral' });

    expect(setups).toHaveLength(3);
    expect(setups.map((s) => s.setupType)).toEqual(['scalp', 'swing', 'position']);

    const swing = setups[1]!;
    expect(swing.direction).toBe('long');
    expect(swing.entry).toBe(115.5);
    expect(swing.stopLoss).toBeLessThan(swing.entry);
    expect(swing.takeProfits.length).toBe(3);
    expect(swing.takeProfits[0]!).toBeGreaterThan(swing.entry);
    // TPs sind R-Multiples: aufsteigend
    expect(swing.takeProfits[1]!).toBeGreaterThan(swing.takeProfits[0]!);
    // Score: Pflicht (7.0) + RR≥2 (1.0) + Session london (0.5) = 8.5; kein FVG-Ziel im Szenario
    expect(swing.score).toBe(8.5);
    expect(swing.riskClass).toBe('low');
    expect(swing.confluence).toContain('Struktur-Bruch');
    expect(swing.confluence).toContain('Retest@EMA/Level');
    expect(swing.session).toBe('london');
  });

  it('SL-Abstände skalieren mit Setup-Typ (scalp < swing < position, ATR-basiert)', () => {
    const setups = evaluateSmcCoreAt(longScenario(), 17, TEST_PARAMS, { higherTfTrend: 'neutral' });
    const dist = (s: (typeof setups)[number]) => s.entry - s.stopLoss;
    expect(dist(setups[0]!)).toBeLessThan(dist(setups[1]!));
    expect(dist(setups[1]!)).toBeLessThan(dist(setups[2]!));
  });

  it('KEIN Entry ohne Volumen-Bestätigung', () => {
    const candles = longScenario();
    candles[17] = { ...candles[17]!, volume: 50 };
    expect(evaluateSmcCoreAt(candles, 17, TEST_PARAMS, {})).toHaveLength(0);
  });

  it('KEIN Entry ohne Retest (Preis kehrt nicht zum Bruchlevel zurück)', () => {
    const candles = longScenario();
    candles[17] = { ...candles[17]!, low: 115.2 }; // berührt 114 nicht
    expect(evaluateSmcCoreAt(candles, 17, TEST_PARAMS, {})).toHaveLength(0);
  });

  it('KEIN Entry auf bearisher Retest-Kerze', () => {
    const candles = longScenario();
    candles[17] = { ...candles[17]!, open: 115.8, close: 114.2 }; // bearish
    expect(evaluateSmcCoreAt(candles, 17, TEST_PARAMS, {})).toHaveLength(0);
  });

  it('KEIN Entry gegen den EMA-Trend', () => {
    // Absteigende Serie: gleiches Muster wäre unter EMA10 → kein Long
    const candles: Candle[] = [];
    for (let i = 0; i < 18; i++) {
      const base = 130 - i * 2;
      candles.push(c(base + 0.5, base + 1, base - 1, base));
    }
    expect(evaluateSmcCoreAt(candles, 17, TEST_PARAMS, {})).toHaveLength(0);
  });

  it('RSI-Gate greift (enges Band → kein Entry)', () => {
    const params = { ...TEST_PARAMS, rsiLongMin: 0, rsiLongMax: 1 };
    expect(evaluateSmcCoreAt(longScenario(), 17, params, {})).toHaveLength(0);
  });

  it('Higher-TF dagegen senkt den Score um 1 (Malus statt Veto, 05_ §7)', () => {
    const aligned = evaluateSmcCoreAt(longScenario(), 17, TEST_PARAMS, { higherTfTrend: 'bull' });
    const opposed = evaluateSmcCoreAt(longScenario(), 17, TEST_PARAMS, { higherTfTrend: 'bear' });
    expect(aligned[1]!.score - opposed[1]!.score).toBe(2); // +1 vs −1
  });

  it('Look-ahead-frei: vor Pivot-Bestätigung existiert kein Entry', () => {
    // @15 bricht close 116 über 114 — Pivot @12 ist bestätigt @14, also ist das ok;
    // aber ein Retest-Check @13 (vor Bestätigung) darf nichts liefern.
    expect(evaluateSmcCoreAt(longScenario(), 13, TEST_PARAMS, {})).toHaveLength(0);
  });
});
