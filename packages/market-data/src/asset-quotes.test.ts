import { describe, it, expect } from 'vitest';
import {
  binanceRestSymbol,
  parseBinanceTickers,
  parseCboeQuote,
  parseTvScanResponse,
  quoteSourceFor,
} from './asset-quotes.js';
import { TV_SYMBOL_MAP, CBOE_SYMBOL_MAP } from './tv-symbol-map.js';

describe('quoteSourceFor', () => {
  it('CRYPTO mit Handelspaar → Binance-REST-Symbol', () => {
    expect(quoteSourceFor({ ticker: 'BTC', assetType: 'CRYPTO', tradingPair: 'BTC/USDT' })).toEqual({ kind: 'binance', symbol: 'BTCUSDT' });
  });

  it('Aktie → TradingView-Symbol aus der verifizierten Map', () => {
    expect(quoteSourceFor({ ticker: 'AAPL', assetType: 'STOCK', tradingPair: null })).toEqual({ kind: 'tradingview', symbol: 'NASDAQ:AAPL' });
  });

  it('Ticker-Kollision ZS: Aktie ≠ Sojabohnen-Future (Composite-Key)', () => {
    expect(quoteSourceFor({ ticker: 'ZS', assetType: 'STOCK', tradingPair: null })).toEqual({ kind: 'tradingview', symbol: 'NASDAQ:ZS' });
    expect(quoteSourceFor({ ticker: 'ZS', assetType: 'FUTURE', tradingPair: null })).toEqual({ kind: 'tradingview', symbol: 'CBOT:ZS1!' });
  });

  it('VVIX/GVZ → CBOE (fehlen im TV-Scanner)', () => {
    expect(quoteSourceFor({ ticker: 'VVIX', assetType: 'INDEX', tradingPair: null })).toEqual({ kind: 'cboe', symbol: '_VVIX' });
    expect(quoteSourceFor({ ticker: 'GVZ', assetType: 'INDEX', tradingPair: null })).toEqual({ kind: 'cboe', symbol: '_GVZ' });
  });

  it('unbekanntes Asset → ehrlich null (keine erfundene Quelle)', () => {
    expect(quoteSourceFor({ ticker: 'GIBTSNICHT', assetType: 'STOCK', tradingPair: null })).toBeNull();
  });

  it('Katalog-Vollständigkeit: Map deckt alle Klassen ab (Stichproben je Klasse)', () => {
    for (const key of ['STOCK:AAPL', 'ETF:TLT', 'INDEX:VIX', 'FUTURE:CL', 'COMMODITY:XAUUSD', 'STOCK:7203', 'STOCK:SAP']) {
      expect(TV_SYMBOL_MAP[key], key).toBeTruthy();
    }
    expect(Object.keys(TV_SYMBOL_MAP).length).toBeGreaterThanOrEqual(190);
    expect(Object.keys(CBOE_SYMBOL_MAP)).toEqual(['INDEX:VVIX', 'INDEX:GVZ']);
  });
});

describe('binanceRestSymbol', () => {
  it('normalisiert Paare mit und ohne Slash', () => {
    expect(binanceRestSymbol('BTC/USDT')).toBe('BTCUSDT');
    expect(binanceRestSymbol('ethusdt')).toBe('ETHUSDT');
  });
  it('lehnt Unbrauchbares ab', () => {
    expect(binanceRestSymbol(null)).toBeNull();
    expect(binanceRestSymbol('XAU/USD $pot')).toBeNull();
  });
});

describe('parseTvScanResponse', () => {
  it('parst echte Scanner-Zeilen (Format vom 2026-07-08 verifiziert)', () => {
    const json = {
      data: [
        { s: 'NASDAQ:AAPL', d: ['AAPL', 311.5, 0.27, 'USD', 'Apple Inc.'] },
        { s: 'TVC:US10Y', d: ['US10Y', 4.585, 0.747, null, 'US 10Y Yield'] },
      ],
    };
    const m = parseTvScanResponse(json);
    expect(m.get('NASDAQ:AAPL')).toEqual({ price: 311.5, changePct: 0.27, currency: 'USD' });
    expect(m.get('TVC:US10Y')).toEqual({ price: 4.585, changePct: 0.747, currency: null });
  });

  it('überspringt kaputte Zeilen statt zu werfen', () => {
    const m = parseTvScanResponse({ data: [{ s: 'X:Y' }, { d: [null, 'kein-preis'] }, null] });
    expect(m.size).toBe(0);
    expect(parseTvScanResponse(null).size).toBe(0);
    expect(parseTvScanResponse({ totalCount: 0 }).size).toBe(0);
  });
});

describe('parseBinanceTickers', () => {
  it('parst das 24hr-Batch-Format', () => {
    const m = parseBinanceTickers([
      { symbol: 'BTCUSDT', lastPrice: '61880.58000000', priceChangePercent: '-1.234' },
      { symbol: 'PEPEUSDT', lastPrice: '0.00001234', priceChangePercent: '5.6' },
    ]);
    expect(m.get('BTCUSDT')).toEqual({ price: 61880.58, changePct: -1.234, currency: 'USDT' });
    expect(m.get('PEPEUSDT')!.price).toBeCloseTo(0.00001234);
  });

  it('verwirft Preis 0 / kaputte Einträge / Nicht-Arrays', () => {
    expect(parseBinanceTickers([{ symbol: 'XUSDT', lastPrice: '0' }]).size).toBe(0);
    expect(parseBinanceTickers({ code: -1100 }).size).toBe(0);
  });
});

describe('parseCboeQuote', () => {
  it('parst das echte CBOE-Format (Live-Antwort 2026-07-08)', () => {
    const q = parseCboeQuote({ data: { symbol: '^VVIX', current_price: 94.26, price_change_percent: 7.2355 } });
    expect(q).toEqual({ price: 94.26, changePct: 7.2355, currency: 'USD' });
  });
  it('null bei fehlenden/kaputten Daten', () => {
    expect(parseCboeQuote({ data: { current_price: 0 } })).toBeNull();
    expect(parseCboeQuote({})).toBeNull();
    expect(parseCboeQuote(null)).toBeNull();
  });
});
