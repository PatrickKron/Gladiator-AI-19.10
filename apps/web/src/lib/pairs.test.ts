import { describe, expect, it } from 'vitest';
import { feedSymbol } from './pairs.js';

/** Regression Patrick-Befund: Pakete zeigten „kein Live-Kurs" für BTC/ETH/SOL,
 * obwohl der Binance-WebSocket lief — der Lookup-Key wurde zu "BTC//USDT". */
describe('feedSymbol (Trading-Pair → Live-Feed-Key)', () => {
  it('lässt Paare mit Slash unverändert', () => {
    expect(feedSymbol('BTC/USDT')).toBe('BTC/USDT');
    expect(feedSymbol('sol/usdt')).toBe('SOL/USDT');
  });

  it('ergänzt den Slash bei kompakten Paaren', () => {
    expect(feedSymbol('BTCUSDT')).toBe('BTC/USDT');
    expect(feedSymbol('ETHUSDC')).toBe('ETH/USDC');
  });

  it('Nicht-Krypto/leer → ehrlich null (kein geratener Kurs)', () => {
    expect(feedSymbol('AAPL')).toBeNull();
    expect(feedSymbol(null)).toBeNull();
    expect(feedSymbol(undefined)).toBeNull();
    expect(feedSymbol('USDT')).toBeNull();
  });
});
