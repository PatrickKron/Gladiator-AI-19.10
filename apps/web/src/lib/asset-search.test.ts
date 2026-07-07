import { describe, expect, it } from 'vitest';
import { rankAssets } from './asset-search.js';

const A = [
  { ticker: 'BTC', name: 'Bitcoin' },
  { ticker: 'ETH', name: 'Ethereum' },
  { ticker: 'ETC', name: 'Ethereum Classic' },
  { ticker: 'WETH', name: 'Wrapped Ether' },
  { ticker: 'SOL', name: 'Solana' },
];

describe('rankAssets', () => {
  it('leere Eingabe → erste N in Listenreihenfolge', () => {
    expect(rankAssets(A, '', 3).map((a) => a.ticker)).toEqual(['BTC', 'ETH', 'ETC']);
  });

  it('findet über Ticker und Name (case-insensitive)', () => {
    const tickers = rankAssets(A, 'eth').map((a) => a.ticker);
    expect(tickers).toContain('ETH');
    expect(tickers).toContain('WETH'); // Ticker enthält "eth"
    expect(tickers).toContain('ETC'); // Name "Ethereum Classic" enthält "eth"
    expect(tickers).not.toContain('SOL');
  });

  it('rankt exakten Ticker vor Präfix vor Enthalten', () => {
    // 'eth' → ETH (exakt) zuerst, dann WETH (enthält im Ticker) bzw. ETC (nur Name).
    const ordered = rankAssets(A, 'eth').map((a) => a.ticker);
    expect(ordered[0]).toBe('ETH');
    expect(ordered.indexOf('WETH')).toBeLessThan(ordered.indexOf('ETC'));
  });

  it('respektiert das Limit', () => {
    expect(rankAssets(A, 'e', 2).length).toBe(2);
  });

  it('kein Treffer → leere Liste', () => {
    expect(rankAssets(A, 'xyz')).toEqual([]);
  });
});
