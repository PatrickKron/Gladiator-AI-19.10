import { describe, expect, it } from 'vitest';
import { clearPendingTradeSymbol, peekPendingTradeSymbol, setPendingTradeSymbol } from './trade-symbol.js';

/** In-Memory-Ersatz für sessionStorage — die Suite läuft in Node ohne window. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

describe('trade-symbol (Übergabe Dashboard → Demo-Ticket)', () => {
  it('setzen → peek liefert das Symbol normalisiert in Großschreibung', () => {
    const s = fakeStorage();
    setPendingTradeSymbol('eth/usdt', s);
    expect(peekPendingTradeSymbol(s)).toBe('ETH/USDT');
  });

  it('peek ist pur (StrictMode ruft Initialisierer doppelt) — erst clear räumt weg', () => {
    const s = fakeStorage();
    setPendingTradeSymbol('SOL/USDT', s);
    expect(peekPendingTradeSymbol(s)).toBe('SOL/USDT');
    expect(peekPendingTradeSymbol(s)).toBe('SOL/USDT'); // zweites Lesen unverändert
    clearPendingTradeSymbol(s);
    expect(peekPendingTradeSymbol(s)).toBeNull();
  });

  it('clear ist idempotent und ein gesperrter Storage (null) wirft nichts', () => {
    const s = fakeStorage();
    clearPendingTradeSymbol(s); // löschen ohne vorheriges Setzen: kein Fehler
    expect(() => {
      setPendingTradeSymbol('BTC/USDT', null);
      clearPendingTradeSymbol(null);
    }).not.toThrow();
    expect(peekPendingTradeSymbol(null)).toBeNull();
  });
});
