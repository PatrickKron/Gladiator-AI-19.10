import { describe, expect, it } from 'vitest';
import { stepFromPrecision } from './venue.js';

/**
 * Regression Patrick-Befund: Sizing-Rechner meldete „Order unter Mindest-Notional
 * (0.00 < 5)" bei 10.000 $ Konto — Ursache: ccxt-Binance läuft im TICK_SIZE-Modus
 * (precision.amount IST die Schrittweite, z. B. 0.00001), der Adapter rechnete aber
 * 10^(-precision) und machte daraus lotSize ≈ 1 → jede BTC-Order rundete auf 0.
 */
describe('stepFromPrecision (ccxt-Precision → Schrittweite)', () => {
  it('TICK_SIZE-Modus: Wert ist bereits die Schrittweite', () => {
    expect(stepFromPrecision(0.00001, true, 0.000001)).toBe(0.00001);
    expect(stepFromPrecision(0.01, true, 0.01)).toBe(0.01);
    expect(stepFromPrecision(1, true, 0.000001)).toBe(1); // ganze Stücke (z. B. Meme-Coins)
  });

  it('DECIMAL_PLACES-Modus: Nachkommastellen → 10^-n', () => {
    expect(stepFromPrecision(5, false, 0.000001)).toBeCloseTo(0.00001, 12);
    expect(stepFromPrecision(0, false, 0.000001)).toBe(1);
    expect(stepFromPrecision(2, false, 0.000001)).toBeCloseTo(0.01, 12);
  });

  it('fehlende/ungültige Precision → ehrlicher Fallback', () => {
    expect(stepFromPrecision(undefined, true, 0.000001)).toBe(0.000001);
    expect(stepFromPrecision(null, false, 0.01)).toBe(0.01);
    expect(stepFromPrecision(NaN, true, 0.0001)).toBe(0.0001);
    expect(stepFromPrecision(-1, true, 0.0001)).toBe(0.0001);
    expect(stepFromPrecision(0, true, 0.0001)).toBe(0.0001);
  });

  it('Regression: BTC-Sizing 0.1 wird mit TICK_SIZE-Step NICHT auf 0 gerundet', () => {
    const lotSize = stepFromPrecision(0.00001, true, 0.000001);
    const qty = Math.floor(0.1 / lotSize) * lotSize;
    expect(qty).toBeGreaterThan(0.09);
  });
});
