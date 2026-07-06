import { describe, expect, it } from 'vitest';
import { parseYahooOhlcv, yahooIntervalFor } from './yahoo-chart.js';

/**
 * Yahoo v8 Chart-Endpoint (reverse-engineered, KEIN API-Key) — Parser.
 * Echte OHLCV für Aktien/ETF/Indizes. Fehlende Bars (null) werden ehrlich
 * übersprungen, nie interpoliert.
 */

const sample = {
  chart: {
    result: [
      {
        meta: { symbol: 'AAPL', currency: 'USD' },
        timestamp: [1_700_000_000, 1_700_086_400, 1_700_172_800],
        indicators: {
          quote: [
            {
              open: [100, 102, null],
              high: [105, 106, null],
              low: [99, 101, null],
              close: [104, 105, null],
              volume: [1_000_000, 1_200_000, null],
            },
          ],
        },
      },
    ],
    error: null,
  },
};

describe('parseYahooOhlcv', () => {
  it('parst echte Bars und überspringt fehlende (null) Bars', () => {
    const r = parseYahooOhlcv(sample);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candles).toHaveLength(2); // dritte Bar ist null → übersprungen
    // Timestamp in ms (Yahoo liefert Sekunden)
    expect(r.candles[0]![0]).toBe(1_700_000_000_000);
    expect(r.candles[0]!.slice(1)).toEqual([100, 105, 99, 104, 1_000_000]);
  });

  it('Yahoo-Fehlerobjekt → ok:false', () => {
    const r = parseYahooOhlcv({ chart: { result: null, error: { code: 'Not Found', description: 'No data found for symbol XYZ' } } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/No data found/);
  });

  it('kein quote-Block → ok:false (kein Raten)', () => {
    const r = parseYahooOhlcv({ chart: { result: [{ timestamp: [1, 2] }], error: null } });
    expect(r.ok).toBe(false);
  });

  it('nur null-Bars → ok:false', () => {
    const r = parseYahooOhlcv({
      chart: { result: [{ timestamp: [1, 2], indicators: { quote: [{ open: [null, null], high: [null, null], low: [null, null], close: [null, null], volume: [null, null] }] } }], error: null },
    });
    expect(r.ok).toBe(false);
  });
});

describe('yahooIntervalFor', () => {
  it('mappt App-Timeframes auf Yahoo-Intervalle', () => {
    expect(yahooIntervalFor('1d')).toBe('1d');
    expect(yahooIntervalFor('1h')).toBe('60m');
    expect(yahooIntervalFor('1wk')).toBe('1wk');
    expect(yahooIntervalFor('1M')).toBe('1mo');
    expect(yahooIntervalFor('unbekannt')).toBe('1d'); // sicherer Fallback
  });
});
