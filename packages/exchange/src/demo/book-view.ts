import type { OrderBookSnapshot } from './fill-engine.js';

/**
 * Orderbuch-Ansicht (OFFENER_PLAN §2): echtes Buch für die Anzeige aufbereiten —
 * optional auf Preisstufen bündeln (Bids abrunden, Asks aufrunden, damit keine
 * Seite in die andere rutscht), kumulierte Mengen, Spread und Ungleichgewicht.
 * Rein, testbar; erfindet keine Level.
 */
export type BookViewLevel = { price: number; qty: number; cum: number };

export type BookView = {
  symbol: string;
  ts: number;
  bids: BookViewLevel[];
  asks: BookViewLevel[];
  spread: number | null;
  spreadBps: number | null;
  mid: number | null;
  /** Bid-Anteil am Volumen der gezeigten Level (0..1); null ohne Volumen. */
  imbalance: number | null;
  /** Größte kumulierte Menge beider Seiten (für Tiefenbalken). */
  maxCum: number;
};

function round(n: number): number {
  return Number(n.toPrecision(12));
}

function aggregate(levels: { price: number; qty: number }[], group: number | null, side: 'bid' | 'ask', limit: number): BookViewLevel[] {
  const out: BookViewLevel[] = [];
  for (const l of levels) {
    if (!(l.qty > 0) || !(l.price > 0)) continue;
    const price = group ? round((side === 'bid' ? Math.floor(l.price / group) : Math.ceil(l.price / group)) * group) : l.price;
    const last = out[out.length - 1];
    if (last && last.price === price) last.qty = round(last.qty + l.qty);
    else {
      if (out.length >= limit) break;
      out.push({ price, qty: l.qty, cum: 0 });
    }
  }
  let cum = 0;
  for (const l of out) {
    cum = round(cum + l.qty);
    l.cum = cum;
  }
  return out;
}

export function summarizeBook(book: OrderBookSnapshot, opts: { levels: number; group?: number }): BookView {
  const group = opts.group !== undefined && Number.isFinite(opts.group) && opts.group > 0 ? opts.group : null;
  const bids = aggregate(book.bids, group, 'bid', opts.levels);
  const asks = aggregate(book.asks, group, 'ask', opts.levels);
  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  const spread = bestBid !== undefined && bestAsk !== undefined ? round(bestAsk - bestBid) : null;
  const mid = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : null;
  const bidVol = bids[bids.length - 1]?.cum ?? 0;
  const askVol = asks[asks.length - 1]?.cum ?? 0;
  return {
    symbol: book.symbol,
    ts: book.ts,
    bids,
    asks,
    spread,
    spreadBps: spread !== null && mid ? (spread / mid) * 10_000 : null,
    mid,
    imbalance: bidVol + askVol > 0 ? bidVol / (bidVol + askVol) : null,
    maxCum: Math.max(bidVol, askVol),
  };
}
