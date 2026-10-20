/**
 * Börsen-Vergleich (Vision-Punkt 2): pro Symbol Kurse aller Börsen, gerankt nach
 * EFFEKTIVEM Preis (inkl. Taker-Gebühr). Reine Tests, Abruf ist injiziert.
 */
import { describe, expect, it } from 'vitest';
import { fetchVenueQuotes, rankVenueQuotes, venueSymbol, type VenueQuote } from './venue-quotes.js';

const q = (venue: string, bid: number, ask: number, takerFee: number, extra: Partial<VenueQuote> = {}): VenueQuote => ({
  venue,
  status: 'ok',
  marketSymbol: 'BTC/USDT',
  marketType: 'spot',
  bid,
  ask,
  takerFee,
  fundingRate: null,
  maxLeverage: null,
  error: null,
  ...extra,
});

describe('rankVenueQuotes', () => {
  it('Kauf: günstigster Ask NACH Gebühr gewinnt, nicht der nackte Ask', () => {
    const r = rankVenueQuotes([q('a', 99, 100, 0.002), q('b', 99, 100.1, 0.0005)], 'buy');
    // a: 100 × 1,002 = 100,2 · b: 100,1 × 1,0005 = 100,15005 → b ist effektiv billiger
    expect(r.map((x) => x.venue)).toEqual(['b', 'a']);
    expect(r[0]!.best).toBe(true);
    expect(r[0]!.effectivePrice).toBeCloseTo(100.15005, 8);
    expect(r[1]!.diffBps).toBeCloseTo(((100.2 - 100.15005) / 100.15005) * 10_000, 6);
  });

  it('Verkauf: höchster Bid NACH Gebühr gewinnt', () => {
    const r = rankVenueQuotes([q('a', 100, 101, 0.001), q('b', 100.2, 101, 0.004)], 'sell');
    // a: 100 × 0,999 = 99,9 · b: 100,2 × 0,996 = 99,7992 → a gewinnt
    expect(r[0]!.venue).toBe('a');
    expect(r[1]!.diffBps).toBeGreaterThan(0);
  });

  it('nicht erreichbare Börsen bleiben sichtbar, aber unten und ohne Preis', () => {
    const down: VenueQuote = { ...q('down', 0, 0, 0), status: 'unavailable', bid: null, ask: null, error: 'timeout' };
    const r = rankVenueQuotes([down, q('a', 99, 100, 0.001)], 'buy');
    expect(r.map((x) => x.venue)).toEqual(['a', 'down']);
    expect(r[1]!.effectivePrice).toBeNull();
    expect(r[1]!.best).toBe(false);
  });

  it('ohne Gebühren-Angabe wird nicht geraten: Rang nach nacktem Preis, Gebühr null', () => {
    const r = rankVenueQuotes([q('a', 99, 100, Number.NaN)], 'buy');
    expect(r[0]!.effectivePrice).toBe(100);
  });
});

describe('venueSymbol', () => {
  it('Hyperliquid notiert in USDC als Perp, andere Börsen Spot wie angefragt', () => {
    expect(venueSymbol('hyperliquid', 'BTC/USDT')).toEqual({ symbol: 'BTC/USDC:USDC', type: 'swap' });
    expect(venueSymbol('bybit', 'ETH/USDT')).toEqual({ symbol: 'ETH/USDT', type: 'spot' });
  });
});

describe('fetchVenueQuotes (Abruf injiziert)', () => {
  it('Fehler je Börse isoliert: eine kaputte Börse blockiert die anderen nie', async () => {
    const res = await fetchVenueQuotes('BTC/USDT', ['binance', 'okx'], async (venue) => {
      if (venue === 'okx') throw new Error('HTTP 503');
      return { bid: 100, ask: 100.5, takerFee: 0.001, fundingRate: null, maxLeverage: null, marketType: 'spot', marketSymbol: 'BTC/USDT' };
    });
    expect(res.find((r) => r.venue === 'binance')!.status).toBe('ok');
    expect(res.find((r) => r.venue === 'okx')).toMatchObject({ status: 'unavailable', error: 'HTTP 503' });
  });

  it('Börse ohne dieses Paar → not_listed statt Fehler', async () => {
    const res = await fetchVenueQuotes('PEPE/USDT', ['kraken'], async () => null);
    expect(res[0]!.status).toBe('not_listed');
  });
});
