import { describe, expect, it } from 'vitest';
import {
  TWELVE_DATA_INTERVALS,
  appTimeframeForInterval,
  parseTwelveDataTimeSeries,
  twelveDataIntervalFor,
} from './twelvedata.js';

describe('Twelve Data Zeitreihen-Parser', () => {
  it('parst eine gültige Antwort chronologisch (die API liefert neueste zuerst → wir drehen)', () => {
    const json = {
      meta: { symbol: 'AAPL', interval: '1day', exchange: 'NASDAQ', type: 'Common Stock' },
      values: [
        { datetime: '2026-01-03', open: '190.0', high: '192.0', low: '189.0', close: '191.5', volume: '1000000' },
        { datetime: '2026-01-02', open: '188.0', high: '191.0', low: '187.5', close: '190.0', volume: '900000' },
      ],
      status: 'ok',
    };
    const res = parseTwelveDataTimeSeries(json);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.symbol).toBe('AAPL');
    // Aufsteigend nach Zeit sortiert (ältestes zuerst)
    expect(res.candles).toHaveLength(2);
    expect(res.candles[0]![1]).toBe(188.0); // open der älteren Kerze
    expect(res.candles[1]![4]).toBe(191.5); // close der neueren Kerze
    // Timestamp in ms
    expect(res.candles[1]![0]).toBe(new Date('2026-01-03').getTime());
  });

  it('meldet API-Fehler ehrlich (status error) statt Ersatzwerte zu erfinden', () => {
    const json = { code: 401, message: 'Invalid API key', status: 'error' };
    const res = parseTwelveDataTimeSeries(json);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('Invalid API key');
  });

  it('behandelt intraday-Zeitstempel (mit Uhrzeit) korrekt', () => {
    const json = {
      meta: { symbol: 'MSFT', interval: '15min' },
      values: [
        { datetime: '2026-01-02 15:45:00', open: '1', high: '2', low: '0.5', close: '1.5', volume: '10' },
        { datetime: '2026-01-02 15:30:00', open: '1', high: '2', low: '0.5', close: '1.4', volume: '10' },
      ],
      status: 'ok',
    };
    const res = parseTwelveDataTimeSeries(json);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 15:45 kommt nach 15:30
    expect(res.candles[0]![0]).toBeLessThan(res.candles[1]![0]);
  });

  it('leere/ungültige Antwort → ok:false, nie eine leere Kerzenliste als „ok"', () => {
    expect(parseTwelveDataTimeSeries(null).ok).toBe(false);
    expect(parseTwelveDataTimeSeries({ status: 'ok', values: [] }).ok).toBe(false);
  });
});

describe('Twelve Data Timeframe-Mapping', () => {
  it('bildet App-Timeframes auf Twelve-Data-Intervalle ab und zurück', () => {
    expect(twelveDataIntervalFor('15m')).toBe('15min');
    expect(twelveDataIntervalFor('1h')).toBe('1h');
    expect(twelveDataIntervalFor('1d')).toBe('1day');
    expect(appTimeframeForInterval('1day')).toBe('1d');
    expect(appTimeframeForInterval('5min')).toBe('5m');
  });

  it('deckt ALLE von Twelve Data angebotenen Intervalle ab (nicht künstlich limitiert)', () => {
    const appTfs = Object.keys(TWELVE_DATA_INTERVALS);
    // Twelve Data bietet 1min..1month — mindestens 11 Auflösungen
    expect(appTfs.length).toBeGreaterThanOrEqual(11);
    expect(appTfs).toContain('1m');
    expect(appTfs).toContain('1M'); // Monat
    expect(appTfs).toContain('1w'); // Woche
  });
});
