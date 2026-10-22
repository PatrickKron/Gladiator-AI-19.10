import { afterEach, describe, expect, it } from 'vitest';
import { filterSpotPairs, listBinanceSpotPairs, resetSpotPairCache, searchSpotPairs } from './symbols.js';

const MARKETS = [
  { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true },
  { symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', spot: true, active: true },
  { symbol: 'ETH/BTC', base: 'ETH', quote: 'BTC', spot: true, active: true },
  { symbol: 'ETHUP/USDT', base: 'ETHUP', quote: 'USDT', spot: true, active: true },
  { symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', spot: true, active: true },
  { symbol: 'ADA/USDT', base: 'ADA', quote: 'USDT', spot: true, active: false },
  { symbol: 'BTC/USDT:USDT', base: 'BTC', quote: 'USDT', spot: false, active: true },
  { symbol: 'LINK/USDT', base: 'LINK', quote: 'USDT', spot: true, active: true },
  { symbol: 'PEPE/USDT', base: 'PEPE', quote: 'USDT', spot: true, active: true },
  undefined,
];

describe('filterSpotPairs', () => {
  it('nur aktive USDT-Spot-Paare, ohne Hebel-Token und Stable-Basis, sortiert und ohne Doppelte', () => {
    expect(filterSpotPairs(MARKETS).map((p) => p.symbol)).toEqual(['BTC/USDT', 'ETH/USDT', 'LINK/USDT', 'PEPE/USDT']);
  });
});

describe('searchSpotPairs', () => {
  const pairs = filterSpotPairs(MARKETS);
  it('„beginnt mit“ vor „enthält“, Groß/Klein egal, Schrägstrich-Schreibweise erlaubt', () => {
    expect(searchSpotPairs(pairs, 'e').map((p) => p.base)).toEqual(['ETH', 'PEPE']);
    expect(searchSpotPairs(pairs, 'eth/usdt').map((p) => p.base)).toEqual(['ETH']);
    expect(searchSpotPairs(pairs, 'xyz')).toEqual([]);
  });
  it('leer → Anfang der Liste bis zum Limit', () => {
    expect(searchSpotPairs(pairs, '', 2).map((p) => p.base)).toEqual(['BTC', 'ETH']);
  });
});

describe('listBinanceSpotPairs', () => {
  afterEach(() => resetSpotPairCache());
  it('merkt sich die Liste und wirft bei leerer Antwort (nie raten)', async () => {
    let calls = 0;
    const fetchMarkets = async () => {
      calls++;
      return MARKETS;
    };
    expect((await listBinanceSpotPairs(fetchMarkets)).length).toBe(4);
    expect((await listBinanceSpotPairs(fetchMarkets)).length).toBe(4);
    expect(calls).toBe(1);
    resetSpotPairCache();
    await expect(listBinanceSpotPairs(async () => [])).rejects.toThrow(/keine Spot-Paare/);
  });
});

describe('echte Daten (Binance Spot-Märkte)', () => {
  it('liefert hunderte USDT-Paare inkl. BTC/ETH/SOL', async () => {
    resetSpotPairCache();
    const pairs = await listBinanceSpotPairs();
    expect(pairs.length).toBeGreaterThan(200);
    for (const s of ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']) expect(pairs.some((p) => p.symbol === s)).toBe(true);
  }, 60_000);
});
