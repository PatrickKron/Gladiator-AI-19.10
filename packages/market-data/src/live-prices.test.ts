import { describe, expect, it } from 'vitest';
import { FEED_SYMBOL_CAP, LivePriceFeed, feedPairsFrom } from './live-prices.js';

/**
 * Live-Preis-Feed (SSE) mit nachziehender Symbol-Liste (Asset-Register 2026-10-25): neu
 * hinzugefügte Binance-Paare streamen ohne Neustart, entfernte hören auf. Ohne start() keine
 * Verbindung — hier wird nur die Listen-Logik geprüft (kein Netz).
 */

describe('feedPairsFrom', () => {
  it('normalisiert (mit/ohne Slash), dedupliziert, verwirft Nicht-Paare, Fallback bei leer', () => {
    expect(feedPairsFrom(['btc/usdt', 'BTCUSDT', 'ETHUSDT', 'AAPL', null, ' sol/usdt '], ['X/USDT'])).toEqual(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
    expect(feedPairsFrom([], ['BTC/USDT'])).toEqual(['BTC/USDT']);
    expect(feedPairsFrom(['AAPL'], ['BTC/USDT'])).toEqual(['BTC/USDT']);
  });
  it('deckelt die Abos (Cap)', () => {
    const many = Array.from({ length: FEED_SYMBOL_CAP + 20 }, (_, i) => `T${i}USDT`);
    expect(feedPairsFrom(many, [])).toHaveLength(FEED_SYMBOL_CAP);
  });
});

describe('LivePriceFeed.setSymbols', () => {
  it('ergänzt neue Symbole (connecting) und entfernt weggefallene samt Status', () => {
    const feed = new LivePriceFeed(['BTC/USDT', 'ETH/USDT']);
    expect(feed.setSymbols(['BTC/USDT', 'ETH/USDT', 'PEPE/USDT'])).toEqual({ added: ['PEPE/USDT'], removed: [] });
    expect(feed.symbols).toEqual(['BTC/USDT', 'ETH/USDT', 'PEPE/USDT']);
    expect(feed.snapshot().status['PEPE/USDT']).toBe('connecting');
    expect(feed.setSymbols(['BTC/USDT', 'PEPE/USDT'])).toEqual({ added: [], removed: ['ETH/USDT'] });
    expect(feed.symbols).toEqual(['BTC/USDT', 'PEPE/USDT']);
    expect(feed.snapshot().status['ETH/USDT']).toBeUndefined();
    // gleiche Liste → nichts zu tun
    expect(feed.setSymbols(['PEPE/USDT', 'BTC/USDT'])).toEqual({ added: [], removed: [] });
  });
});
