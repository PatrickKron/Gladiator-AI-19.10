import { describe, expect, it } from 'vitest';
import { parseYahooOhlcv, YAHOO_LOAD_PLAN, yahooIntervalFor, yahooRefreshRange } from './yahoo-chart.js';

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
    // kanonischer App-Timeframe ist '1w' (SUPPORTED_TIMEFRAMES) — Yahoo nennt ihn '1wk'
    expect(yahooIntervalFor('1w')).toBe('1wk');
    expect(yahooIntervalFor('1M')).toBe('1mo');
    expect(yahooIntervalFor('unbekannt')).toBe('1d'); // sicherer Fallback
  });
});

describe('parseYahooOhlcv — Metadaten', () => {
  it('liefert echte Instrument-Metadaten (Typ, Name, Währung, Börse) mit, wenn Yahoo sie schickt', () => {
    const r = parseYahooOhlcv({
      chart: {
        result: [
          {
            meta: { symbol: 'SAP.DE', currency: 'EUR', exchangeName: 'GER', fullExchangeName: 'XETRA', instrumentType: 'EQUITY', longName: 'SAP SE', shortName: 'SAP' },
            timestamp: [1_700_000_000],
            indicators: { quote: [{ open: [1], high: [2], low: [0.5], close: [1.5], volume: [10] }] },
          },
        ],
        error: null,
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta).toEqual({ symbol: 'SAP.DE', instrumentType: 'EQUITY', name: 'SAP SE', currency: 'EUR', exchange: 'XETRA' });
  });

  it('ohne meta-Block → meta null (nichts geraten)', () => {
    const r = parseYahooOhlcv(sample);
    expect(r.ok && r.meta).toMatchObject({ symbol: 'AAPL', currency: 'USD', instrumentType: null, name: null, exchange: null });
    const bare = parseYahooOhlcv({ chart: { result: [{ timestamp: [1], indicators: { quote: [{ open: [1], high: [1], low: [1], close: [1] }] } }], error: null } });
    expect(bare.ok && bare.meta).toBeNull();
  });
});

describe('Yahoo-Ladeplan und Refresh-Fenster', () => {
  it('Erstladung: 1d über 5 Jahre, 1h über 1 Jahr (Yahoo-Grenze 730 T), 15m über 60 Tage (Yahoo-Grenze)', () => {
    expect(YAHOO_LOAD_PLAN).toEqual([
      { timeframe: '1d', range: '5y' },
      { timeframe: '1h', range: '1y' },
      { timeframe: '15m', range: '60d' },
    ]);
  });

  const NOW = new Date('2026-10-25T12:00:00Z');
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const H = 3_600_000;
  const D = 24 * H;

  it('kleinstes Yahoo-Fenster, das die Lücke seit der letzten Kerze deckt (inkrementell)', () => {
    expect(yahooRefreshRange('15m', ago(30 * 60_000), NOW)).toBe('1d');
    expect(yahooRefreshRange('15m', ago(2.5 * D), NOW)).toBe('5d'); // Wochenende
    expect(yahooRefreshRange('1h', ago(2 * H), NOW)).toBe('5d');
    expect(yahooRefreshRange('1h', ago(20 * D), NOW)).toBe('1mo');
    expect(yahooRefreshRange('1d', ago(2 * D), NOW)).toBe('1mo');
    expect(yahooRefreshRange('1d', ago(100 * D), NOW)).toBe('6mo');
  });

  it('nie größer als Yahoo je Intervall erlaubt; ohne Kerze = Erstlade-Fenster', () => {
    expect(yahooRefreshRange('15m', ago(200 * D), NOW)).toBe('60d');
    expect(yahooRefreshRange('1h', ago(900 * D), NOW)).toBe('1y');
    expect(yahooRefreshRange('1d', ago(4000 * D), NOW)).toBe('5y');
    expect(yahooRefreshRange('15m', null, NOW)).toBe('60d');
    expect(yahooRefreshRange('1h', null, NOW)).toBe('1y');
    expect(yahooRefreshRange('1d', null, NOW)).toBe('5y');
  });
});
