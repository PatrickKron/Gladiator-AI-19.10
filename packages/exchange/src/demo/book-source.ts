import ccxt from 'ccxt';
import { stepFromPrecision, type MarketRules } from '../venue.js';
import { venueSymbol } from '../venue-quotes.js';
import type { OrderBookSnapshot } from './fill-engine.js';

/**
 * Preisquelle des Demo-Modus: ECHTE Orderbücher (public REST, keyless) — seit
 * Vision-Punkt 2 je Börse wählbar (Standard Binance). Hinter einem Interface,
 * damit Tests deterministische Bücher injizieren — im Laufpfad gibt es
 * ausschließlich echte Marktdaten.
 */
export interface DemoBookSource {
  fetchBook(symbol: string, venue?: string): Promise<OrderBookSnapshot>;
  marketRules(symbol: string, venue?: string): Promise<MarketRules>;
}

/** Standard-Börse des Demo-Modus (und aller Altdaten ohne Börsen-Angabe). */
export const DEMO_DEFAULT_VENUE = 'binance';

const BOOK_CACHE_MS = 3_000;
const BOOK_DEPTH = 100;

type CcxtBookClient = {
  fetchOrderBook(symbol: string, limit?: number): Promise<{ timestamp?: number; bids: [number, number][]; asks: [number, number][] }>;
  loadMarkets(): Promise<unknown>;
  market(symbol: string): { precision?: { price?: number; amount?: number }; limits?: { cost?: { min?: number } } };
  precisionMode: number;
};

/** Echtes Orderbuch einer beliebigen CCXT-Börse (Symbol je Börse über venueSymbol). */
export class CcxtBookSource implements DemoBookSource {
  private exchange: CcxtBookClient;
  /** Mini-Cache: mehrere Abfragen im selben Poll-Zyklus teilen sich EIN echtes Buch. */
  private cache = new Map<string, { book: OrderBookSnapshot; fetchedAt: number }>();

  constructor(readonly venueId: string = DEMO_DEFAULT_VENUE) {
    const Ctor = (ccxt as unknown as Record<string, new (opts: object) => CcxtBookClient>)[venueId];
    if (!Ctor) throw new Error(`Börse ${venueId} unbekannt.`);
    this.exchange = new Ctor({ enableRateLimit: true, timeout: 8_000 });
  }

  async fetchBook(symbol: string): Promise<OrderBookSnapshot> {
    const hit = this.cache.get(symbol);
    if (hit && Date.now() - hit.fetchedAt < BOOK_CACHE_MS) return hit.book;
    const ob = await this.exchange.fetchOrderBook(venueSymbol(this.venueId, symbol).symbol, BOOK_DEPTH);
    const book: OrderBookSnapshot = {
      symbol,
      ts: ob.timestamp ?? Date.now(),
      bids: ob.bids.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })),
      asks: ob.asks.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })),
    };
    if (book.bids.length === 0 && book.asks.length === 0) {
      throw new Error(`Kein echtes Orderbuch für ${symbol} auf ${this.venueId} verfügbar.`);
    }
    this.cache.set(symbol, { book, fetchedAt: Date.now() });
    return book;
  }

  async marketRules(symbol: string): Promise<MarketRules> {
    await this.exchange.loadMarkets();
    const m = this.exchange.market(venueSymbol(this.venueId, symbol).symbol);
    const tickSizeMode = this.exchange.precisionMode === ccxt.TICK_SIZE;
    return {
      tickSize: stepFromPrecision(m.precision?.price, tickSizeMode, 0.01),
      lotSize: stepFromPrecision(m.precision?.amount, tickSizeMode, 0.000001),
      minNotional: Number(m.limits?.cost?.min ?? 10),
    };
  }
}

export class BinanceBookSource extends CcxtBookSource {
  constructor() {
    super('binance');
  }
}

/** Verteilt Abfragen je Börse auf eine (lazy angelegte) CcxtBookSource. */
export class MultiVenueBookSource implements DemoBookSource {
  private sources = new Map<string, DemoBookSource>();

  constructor(private factory: (venue: string) => DemoBookSource = (v) => new CcxtBookSource(v)) {}

  private source(venue: string | undefined): DemoBookSource {
    const id = venue ?? DEMO_DEFAULT_VENUE;
    let s = this.sources.get(id);
    if (!s) {
      s = this.factory(id);
      this.sources.set(id, s);
    }
    return s;
  }

  fetchBook(symbol: string, venue?: string): Promise<OrderBookSnapshot> {
    return this.source(venue).fetchBook(symbol);
  }

  marketRules(symbol: string, venue?: string): Promise<MarketRules> {
    return this.source(venue).marketRules(symbol);
  }
}

let singleton: BinanceBookSource | null = null;

/** Prozessweiter Binance-Singleton (ratelimit-freundlich, geteilter Markets-Cache). */
export function binanceBookSource(): DemoBookSource {
  singleton ??= new BinanceBookSource();
  return singleton;
}

let multi: MultiVenueBookSource | null = null;

/** Demo-Modus: echte Bücher aller Börsen; Binance teilt sich den Singleton. */
export function demoBookSource(): DemoBookSource {
  multi ??= new MultiVenueBookSource((v) => (v === 'binance' ? binanceBookSource() : new CcxtBookSource(v)));
  return multi;
}
