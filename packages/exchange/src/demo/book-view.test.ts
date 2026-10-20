import { describe, expect, it } from 'vitest';
import { summarizeBook } from './book-view.js';
import type { OrderBookSnapshot } from './fill-engine.js';

/** Orderbuch-Ansicht: echte Level bündeln, kumulieren, Spread + Ungleichgewicht. */
const book: OrderBookSnapshot = {
  symbol: 'BTC/USDT',
  ts: 1,
  bids: [
    { price: 100.0, qty: 1 },
    { price: 99.95, qty: 2 },
    { price: 99.4, qty: 3 },
    { price: 98.9, qty: 4 },
  ],
  asks: [
    { price: 100.1, qty: 0.5 },
    { price: 100.6, qty: 1.5 },
    { price: 101.2, qty: 2 },
  ],
};

describe('summarizeBook', () => {
  it('ohne Bündelung: Level 1:1, kumuliert, Spread und Mid', () => {
    const v = summarizeBook(book, { levels: 10 });
    expect(v.bids.map((l) => [l.price, l.qty, l.cum])).toEqual([
      [100, 1, 1],
      [99.95, 2, 3],
      [99.4, 3, 6],
      [98.9, 4, 10],
    ]);
    expect(v.asks.map((l) => l.cum)).toEqual([0.5, 2, 4]);
    expect(v.spread).toBeCloseTo(0.1, 9);
    expect(v.mid).toBeCloseTo(100.05, 9);
    expect(v.spreadBps).toBeCloseTo((0.1 / 100.05) * 10_000, 6);
  });

  it('Bündelung: Bids nach unten, Asks nach oben auf die Stufe gerundet', () => {
    const v = summarizeBook(book, { levels: 10, group: 1 });
    expect(v.bids.map((l) => [l.price, l.qty])).toEqual([
      [100, 1],
      [99, 5],
      [98, 4],
    ]);
    expect(v.asks.map((l) => [l.price, l.qty])).toEqual([
      [101, 2],
      [102, 2],
    ]);
  });

  it('levels begrenzt die Tiefe; Ungleichgewicht = Bid-Anteil am Volumen der gezeigten Level', () => {
    const v = summarizeBook(book, { levels: 2 });
    expect(v.bids).toHaveLength(2);
    expect(v.asks).toHaveLength(2);
    // bids 1+2=3, asks 0.5+1.5=2 → 3/5
    expect(v.imbalance).toBeCloseTo(0.6, 9);
    expect(v.maxCum).toBe(3);
  });

  it('leere Seite → Spread/Mid null, Ungleichgewicht ehrlich berechnet oder null', () => {
    const v = summarizeBook({ ...book, asks: [] }, { levels: 5 });
    expect(v.spread).toBeNull();
    expect(v.mid).toBeNull();
    expect(v.imbalance).toBe(1);
    expect(summarizeBook({ ...book, bids: [], asks: [] }, { levels: 5 }).imbalance).toBeNull();
  });

  it('ungültige Bündelung (≤ 0, NaN) wird ignoriert', () => {
    expect(summarizeBook(book, { levels: 10, group: 0 }).bids).toHaveLength(4);
    expect(summarizeBook(book, { levels: 10, group: Number.NaN }).bids).toHaveLength(4);
  });
});
