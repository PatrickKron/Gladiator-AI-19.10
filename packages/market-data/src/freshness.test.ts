import { describe, expect, it } from 'vitest';
import { FRESH_INTERVALS, freshCutoff, freshnessLimitMs, isCandleFresh, pickLatestClose } from './freshness.js';

/**
 * Frische-Regel (Asset-Register 2026-10-25): Screener, Screen-Alarme und Preis-Alarme
 * handeln nur auf Kerzen, deren neueste Kerze jünger als N Intervalle ist — 24/7-Quellen
 * mit 1-h-Untergrenze (Refresh alle 15 min), Börsenzeiten-Quellen mit 4 Tagen (Wochenende +
 * Feiertag). Pur, ohne DB.
 */

const NOW = new Date('2026-10-25T12:00:00Z');
const H = 3_600_000;
const D = 24 * H;

describe('freshnessLimitMs', () => {
  it('N Intervalle, aber nie unter der Untergrenze der Quelle', () => {
    expect(FRESH_INTERVALS).toBe(3);
    expect(freshnessLimitMs('4h', 'binance')).toBe(12 * H);
    expect(freshnessLimitMs('1d', 'binance')).toBe(3 * D);
    // 5m × 3 = 15 min < 1 h Untergrenze (Refresh-Takt 15 min + Puffer)
    expect(freshnessLimitMs('5m', 'binance')).toBe(H);
    // Aktien: Wochenende/Feiertag — 1h × 3 wäre am Montagmorgen schon „veraltet“
    expect(freshnessLimitMs('1h', 'yahoo')).toBe(4 * D);
    expect(freshnessLimitMs('15m', 'twelvedata')).toBe(4 * D);
    expect(freshnessLimitMs('1w', 'yahoo')).toBe(21 * D);
  });

  it('unbekannte Quelle = 24/7-Regel (streng), unbekannter Zeitrahmen = 1h-Intervall', () => {
    expect(freshnessLimitMs('1h', 'sca-123')).toBe(3 * H);
    expect(freshnessLimitMs('7m', 'binance')).toBe(3 * H);
  });
});

describe('isCandleFresh / freshCutoff', () => {
  it('jünger als die Grenze → frisch, älter → veraltet, fehlend → veraltet', () => {
    expect(isCandleFresh(new Date(NOW.getTime() - 2 * H), '1h', 'binance', NOW)).toBe(true);
    expect(isCandleFresh(new Date(NOW.getTime() - 3 * H), '1h', 'binance', NOW)).toBe(true); // genau auf der Grenze
    expect(isCandleFresh(new Date(NOW.getTime() - 3 * H - 1), '1h', 'binance', NOW)).toBe(false);
    expect(isCandleFresh(null, '1h', 'binance', NOW)).toBe(false);
    expect(isCandleFresh(undefined, '1h', 'binance', NOW)).toBe(false);
    expect(isCandleFresh('kaputt', '1h', 'binance', NOW)).toBe(false);
  });

  it('Freitags-Schluss ist am Montagmorgen für Aktien noch frisch, eine Woche alt nicht', () => {
    const fridayClose = new Date('2026-10-23T19:45:00Z');
    const mondayMorning = new Date('2026-10-26T08:00:00Z');
    expect(isCandleFresh(fridayClose, '15m', 'yahoo', mondayMorning)).toBe(true);
    expect(isCandleFresh(new Date('2026-10-16T19:45:00Z'), '15m', 'yahoo', mondayMorning)).toBe(false);
    // ISO-String und Millisekunden werden gleich behandelt
    expect(isCandleFresh(fridayClose.toISOString(), '15m', 'yahoo', mondayMorning)).toBe(true);
    expect(isCandleFresh(fridayClose.getTime(), '15m', 'yahoo', mondayMorning)).toBe(true);
  });

  it('freshCutoff = jetzt − Grenze', () => {
    expect(freshCutoff('1h', 'binance', NOW).toISOString()).toBe(new Date(NOW.getTime() - 3 * H).toISOString());
  });
});

describe('pickLatestClose', () => {
  it('nimmt die neueste FRISCHE Kerze über alle Zeitrahmen', () => {
    const r = pickLatestClose(
      [
        { timeframe: '1d', ts: new Date(NOW.getTime() - 12 * H), close: 100 },
        { timeframe: '15m', ts: new Date(NOW.getTime() - 20 * 60_000), close: 101.5 },
        { timeframe: '1h', ts: new Date(NOW.getTime() - H), close: 101 },
      ],
      'yahoo',
      NOW,
    );
    expect(r).toEqual({ ok: true, price: 101.5, timeframe: '15m', ts: new Date(NOW.getTime() - 20 * 60_000) });
  });

  it('keine Kerzen → no_candles; nur veraltete → stale mit letztem Zeitpunkt (nie ein alter Kurs)', () => {
    expect(pickLatestClose([], 'yahoo', NOW)).toEqual({ ok: false, reason: 'no_candles', lastTs: null });
    const old = new Date(NOW.getTime() - 10 * D);
    expect(pickLatestClose([{ timeframe: '1h', ts: old, close: 50 }], 'yahoo', NOW)).toEqual({ ok: false, reason: 'stale', lastTs: old });
  });

  it('ungültige Schlusskurse (0, NaN) zählen nicht', () => {
    const r = pickLatestClose(
      [
        { timeframe: '15m', ts: new Date(NOW.getTime() - 60_000), close: 0 },
        { timeframe: '1h', ts: new Date(NOW.getTime() - H), close: Number.NaN },
        { timeframe: '1d', ts: new Date(NOW.getTime() - 2 * H), close: 99 },
      ],
      'yahoo',
      NOW,
    );
    expect(r).toMatchObject({ ok: true, price: 99, timeframe: '1d' });
  });
});
