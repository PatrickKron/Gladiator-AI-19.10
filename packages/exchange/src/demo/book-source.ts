import ccxt from 'ccxt';
import { stepFromPrecision, type MarketRules } from '../venue.js';
import type { OrderBookSnapshot } from './fill-engine.js';

/**
 * Preisquelle des Demo-Modus: ECHTES Binance-Orderbuch (public REST, keyless).
 * Hinter einem Interface, damit Tests deterministische Bücher injizieren —
 * im Laufpfad gibt es ausschließlich echte Marktdaten.
 */
export interface DemoBookSource {
  fetchBook(symbol: string): Promise<OrderBookSnapshot>;
  marketRules(symbol: string): Promise<MarketRules>;
}

const BOOK_CACHE_MS = 3_000;
const BOOK_DEPTH = 100;

export class BinanceBookSource implements DemoBookSource {
  private exchange = new ccxt.binance({ enableRateLimit: true });
  /** Mini-Cache: mehrere Abfragen im selben Poll-Zyklus teilen sich EIN echtes Buch. */
  private cache = new Map<string, { book: OrderBookSnapshot; fetchedAt: number }>();

  async fetchBook(symbol: string): Promise<OrderBookSnapshot> {
    const hit = this.cache.get(symbol);
    if (hit && Date.now() - hit.fetchedAt < BOOK_CACHE_MS) return hit.book;
    const ob = await this.exchange.fetchOrderBook(symbol, BOOK_DEPTH);
    const book: OrderBookSnapshot = {
      symbol,
      ts: ob.timestamp ?? Date.now(),
      bids: ob.bids.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })),
      asks: ob.asks.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })),
    };
    if (book.bids.length === 0 && book.asks.length === 0) {
      throw new Error(`Kein echtes Orderbuch für ${symbol} verfügbar.`);
    }
    this.cache.set(symbol, { book, fetchedAt: Date.now() });
    return book;
  }

  async marketRules(symbol: string): Promise<MarketRules> {
    await this.exchange.loadMarkets();
    const m = this.exchange.market(symbol);
    const tickSizeMode = this.exchange.precisionMode === ccxt.TICK_SIZE;
    return {
      tickSize: stepFromPrecision(m.precision?.price, tickSizeMode, 0.01),
      lotSize: stepFromPrecision(m.precision?.amount, tickSizeMode, 0.000001),
      minNotional: Number(m.limits?.cost?.min ?? 10),
    };
  }
}

let singleton: BinanceBookSource | null = null;

/** Prozessweiter Singleton (ratelimit-freundlich, geteilter Markets-Cache). */
export function binanceBookSource(): DemoBookSource {
  singleton ??= new BinanceBookSource();
  return singleton;
}
