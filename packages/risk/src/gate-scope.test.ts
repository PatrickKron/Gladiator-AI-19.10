import { describe, expect, it } from 'vitest';
import { gatesForSymbol } from './gate-scope.js';

describe('gatesForSymbol (Risiko-Tab je Asset: symbol IS NULL OR symbol = X)', () => {
  const gates = [
    { id: 'a', symbol: null },
    { id: 'b', symbol: 'BTC/USDT' },
    { id: 'c', symbol: 'ETH/USDT' },
    { id: 'd', symbol: undefined },
  ];
  it('globale Gates (ohne Symbol) + Gates genau dieses Symbols', () => {
    expect(gatesForSymbol(gates, 'BTC/USDT').map((g) => g.id)).toEqual(['a', 'b', 'd']);
  });
  it('exakter Vergleich wie gateMatches der Engine (kein Präfix: BTC/USDT ≠ BTC/USDC)', () => {
    expect(gatesForSymbol(gates, 'BTC/USDC').map((g) => g.id)).toEqual(['a', 'd']);
  });
  it('Groß/Klein der Eingabe egal (Chart-Symbole sind groß)', () => {
    expect(gatesForSymbol(gates, 'eth/usdt').map((g) => g.id)).toEqual(['a', 'c', 'd']);
  });
  it('ohne Symbol: alle Gates (Marktlage-Ansicht)', () => {
    expect(gatesForSymbol(gates, undefined)).toHaveLength(4);
  });
});
