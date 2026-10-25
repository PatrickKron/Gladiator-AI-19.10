import { describe, expect, it } from 'vitest';
import type { Db } from '@gladiator/db';
import type { RegisteredAsset } from './asset-register.js';
import { CANDLE_REFRESH_MAX, refreshRegisteredCandles } from './candle-refresh.js';

/**
 * Kerzen-Refresh (alle 15 min, Asset-Register 2026-10-25): je registriertem Asset die neuesten
 * echten Kerzen nachladen — Binance über den bestehenden Ensure-Weg, Yahoo inkrementell mit
 * kurzem Fenster, Twelve Data nur mit Key. Sequentiell mit Pause, ein kaputtes Symbol stoppt
 * den Lauf nie. Netz-Quellen hier durch Test-Doubles ersetzt; die DB-Abfrage der letzten
 * Kerze liefert „keine Kerze“ (frisches Asset).
 */

const fakeDb = { execute: async () => ({ rows: [{ ts: null }] }) } as unknown as Db;
const asset = (symbol: string, venue: RegisteredAsset['venue']): RegisteredAsset => ({
  symbol,
  venue,
  assetType: venue === 'binance' ? 'CRYPTO' : 'STOCK',
  name: symbol,
  ticker: symbol,
  favoritedAt: null,
  userAdded: true,
  createdAt: new Date(0),
});

describe('refreshRegisteredCandles', () => {
  it('routet je Quelle, läuft sequentiell weiter, wenn ein Symbol scheitert, und sammelt Fehler', async () => {
    const calls: string[] = [];
    const res = await refreshRegisteredCandles(fakeDb, {
      list: async () => [asset('BTC/USDT', 'binance'), asset('BAD/USDT', 'binance'), asset('AAPL', 'yahoo'), asset('MSFT', 'twelvedata')],
      ensureBinance: async (_db, symbol) => {
        calls.push(`binance:${symbol}`);
        if (symbol === 'BAD/USDT') throw new Error('Binance 429');
        return { symbol, inserted: 3, errors: [] };
      },
      ingestYahoo: async (_db, o) => {
        calls.push(`yahoo:${o.symbol}@${o.timeframe}/${o.range}`);
        return { venue: 'yahoo', symbol: o.symbol, timeframe: o.timeframe!, fetched: 2, inserted: 2, rejected: 0 };
      },
      twelveDataConfigured: () => false,
      pauseMs: { binance: 0, yahoo: 0, twelvedata: 0 },
    });
    expect(calls).toEqual(['binance:BTC/USDT', 'binance:BAD/USDT', 'yahoo:AAPL@1d/5y', 'yahoo:AAPL@1h/1y', 'yahoo:AAPL@15m/60d']);
    expect(res.assets).toBe(4);
    expect(res.refreshed).toEqual({ binance: 1, yahoo: 1, twelvedata: 0 });
    expect(res.inserted).toBe(3 + 6);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/BAD\/USDT.*429/);
    // Twelve Data ohne Key: ehrlich übersprungen, nicht als Erfolg gezählt
    expect(res.skipped).toEqual(['twelvedata:MSFT — kein TWELVE_DATA_API_KEY']);
  });

  it('Teilfehler je Zeitrahmen (Yahoo) landen in errors, das Asset zählt trotzdem als aufgefrischt', async () => {
    const res = await refreshRegisteredCandles(fakeDb, {
      list: async () => [asset('SAP.DE', 'yahoo')],
      ingestYahoo: async (_db, o) =>
        o.timeframe === '15m'
          ? { venue: 'yahoo', symbol: o.symbol, timeframe: '15m', fetched: 0, inserted: 0, rejected: 0, error: 'Yahoo HTTP 429' }
          : { venue: 'yahoo', symbol: o.symbol, timeframe: o.timeframe!, fetched: 1, inserted: 1, rejected: 0 },
      pauseMs: { yahoo: 0 },
    });
    expect(res.refreshed.yahoo).toBe(1);
    expect(res.errors.every((e) => e.startsWith('yahoo:SAP.DE 15m'))).toBe(true);
    expect(res.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('Twelve Data mit Key: 1h + 1d mit kleinem outputsize; Cap begrenzt den Lauf auf die wichtigsten Assets', async () => {
    const td: string[] = [];
    const res = await refreshRegisteredCandles(fakeDb, {
      list: async () => [asset('MSFT', 'twelvedata'), asset('AAPL', 'twelvedata')],
      twelveDataConfigured: () => true,
      ingestTwelveData: async (_db, o) => {
        td.push(`${o.symbol}@${o.timeframe}/${o.outputsize}`);
        return { inserted: 1 };
      },
      pauseMs: { twelvedata: 0 },
      limit: 1,
    });
    expect(td).toEqual(['MSFT@1h/50', 'MSFT@1d/50']);
    expect(res.assets).toBe(1);
    expect(res.refreshed.twelvedata).toBe(1);
    expect(CANDLE_REFRESH_MAX).toBeGreaterThanOrEqual(100);
  });
});
