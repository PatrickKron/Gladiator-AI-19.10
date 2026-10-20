import { describe, expect, it } from 'vitest';
import { buildWatchlist, isTypingTarget, keyDirection, stepSymbol } from './watchlist.js';

describe('Watchlist der Markt-Bühne', () => {
  it('Favoriten zuerst, keine Doppelten, aktuelles Symbol immer enthalten', () => {
    expect(buildWatchlist(['BTC/USDT', 'ETH/USDT', 'SOL/USDT'], ['SOL/USDT'], 'BTC/USDT')).toEqual(['SOL/USDT', 'BTC/USDT', 'ETH/USDT']);
    expect(buildWatchlist(['BTC/USDT'], [], 'DOGE/USDT')).toEqual(['BTC/USDT', 'DOGE/USDT']);
    expect(buildWatchlist(['BTC/USDT', 'BTC/USDT'], ['BTC/USDT'], 'BTC/USDT')).toEqual(['BTC/USDT']);
  });

  it('Tastatur: Schritt mit Umlauf, unbekanntes Symbol → erstes', () => {
    const l = ['A', 'B', 'C'];
    expect(stepSymbol(l, 'A', 1)).toBe('B');
    expect(stepSymbol(l, 'C', 1)).toBe('A');
    expect(stepSymbol(l, 'A', -1)).toBe('C');
    expect(stepSymbol(l, 'X', 1)).toBe('A');
    expect(stepSymbol([], 'X', 1)).toBe('X');
  });

  it('Tasten und Eingabefelder', () => {
    expect(keyDirection('ArrowDown')).toBe(1);
    expect(keyDirection('j')).toBe(1);
    expect(keyDirection('ArrowUp')).toBe(-1);
    expect(keyDirection('k')).toBe(-1);
    expect(keyDirection('Enter')).toBeNull();
    expect(isTypingTarget({ tagName: 'input' })).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
