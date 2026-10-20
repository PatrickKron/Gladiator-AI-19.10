import { describe, expect, it } from 'vitest';
import { bookDigits } from './OrderBookPanel.js';

/** Preise im Orderbuch dürfen nie gröber gerundet werden als die echten Level (sonst doppelte Stufen). */
describe('bookDigits', () => {
  it('ohne Bündelung: feinste Nachkommastelle der echten Preise', () => {
    expect(bookDigits(0, [67250, 67250.5, 67251])).toBe(1);
    expect(bookDigits(0, [0.12345, 0.1235])).toBe(5);
    expect(bookDigits(0, [100, 101])).toBe(0);
  });
  it('mit Bündelung: Genauigkeit der Stufe', () => {
    expect(bookDigits(10, [67250.5])).toBe(0);
    expect(bookDigits(0.01, [1.23456])).toBe(2);
  });
  it('sehr kleine Preise in Exponentialschreibweise, gedeckelt bei 8', () => {
    expect(bookDigits(0, [0.00001234])).toBe(8);
    expect(bookDigits(0, [1e-7])).toBe(7);
  });
});
