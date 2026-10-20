import ccxt from 'ccxt';
import { binanceBookSource } from './book-source.js';
import type { OrderBookSnapshot } from './fill-engine.js';

/**
 * Orderbuch-Stream für die Orderbuch-Ansicht (Plan §2, „nächste Stufe"):
 * pro angezeigtem Symbol hält ein ccxt.pro-Websocket (`watchOrderBook`) das
 * ECHTE Binance-Buch warm; Abfragen bekommen den neuesten Stand ohne REST-Last.
 *
 * Ehrlich in jedem Zustand: solange der Stream nicht liefert, veraltet ist oder
 * ausfällt, kommt das REST-Buch (3-s-Cache der bestehenden Quelle); ohne beides
 * ein Fehler — nie ein erfundenes Buch. Ohne Abfragen endet der Stream nach
 * `idleMs` (kein ewiger Hintergrund-Loop). Bewusst NICHT für den Demo-Takt im
 * Worker (1×/min — dort würde der Stream ständig auf- und abgebaut).
 */

export type BookStreamStatus = 'idle' | 'connecting' | 'live' | 'error';

export type StreamingBookDeps = {
  /** Nächstes Buch-Update (ccxt.pro: resolved bei jeder Änderung). */
  watch: (symbol: string) => Promise<OrderBookSnapshot>;
  /** Fallback (REST). */
  fetch: (symbol: string) => Promise<OrderBookSnapshot>;
  unwatch?: (symbol: string) => Promise<void>;
  now?: () => number;
  /** Stream-Buch älter als das → REST. */
  staleMs?: number;
  /** So lange ohne Abfrage → Stream beenden. */
  idleMs?: number;
  /** Pause nach einem Stream-Fehler bis zum Neuversuch. */
  retryMs?: number;
};

type SymbolState = {
  status: BookStreamStatus;
  running: boolean;
  book: OrderBookSnapshot | null;
  bookAt: number;
  lastRequest: number;
  errorAt: number | null;
};

export class StreamingBookCache {
  private states = new Map<string, SymbolState>();
  private now: () => number;
  private staleMs: number;
  private idleMs: number;
  private retryMs: number;

  constructor(private deps: StreamingBookDeps) {
    this.now = deps.now ?? Date.now;
    this.staleMs = deps.staleMs ?? 5_000;
    this.idleMs = deps.idleMs ?? 60_000;
    this.retryMs = deps.retryMs ?? 30_000;
  }

  status(symbol: string): BookStreamStatus {
    return this.states.get(symbol)?.status ?? 'idle';
  }

  async get(symbol: string): Promise<OrderBookSnapshot> {
    let st = this.states.get(symbol);
    if (!st) {
      st = { status: 'idle', running: false, book: null, bookAt: 0, lastRequest: 0, errorAt: null };
      this.states.set(symbol, st);
    }
    const t = this.now();
    st.lastRequest = t;
    if (!st.running && (st.errorAt === null || t - st.errorAt >= this.retryMs)) this.start(symbol, st);
    if (st.book && t - st.bookAt <= this.staleMs) return st.book;
    return this.deps.fetch(symbol);
  }

  private start(symbol: string, st: SymbolState): void {
    st.running = true;
    st.status = 'connecting';
    st.errorAt = null;
    void (async () => {
      for (;;) {
        let b: OrderBookSnapshot;
        try {
          b = await this.deps.watch(symbol);
        } catch {
          st.running = false;
          st.status = 'error';
          st.errorAt = this.now();
          st.book = null;
          return;
        }
        if (this.now() - st.lastRequest > this.idleMs) {
          st.running = false;
          st.status = 'idle';
          st.book = null;
          try {
            await this.deps.unwatch?.(symbol);
          } catch {
            /* Verbindung ohnehin weg — ignorieren */
          }
          return;
        }
        if (b.bids.length > 0 || b.asks.length > 0) {
          st.book = b;
          st.bookAt = this.now();
          st.status = 'live';
        }
      }
    })();
  }
}

const BOOK_DEPTH = 100;
let singleton: StreamingBookCache | null = null;

/** Prozessweiter Stream-Cache für die Orderbuch-Ansicht (echtes Binance-Buch). */
export function binanceStreamingBook(): StreamingBookCache {
  if (!singleton) {
    const ws = new ccxt.pro.binance({ enableRateLimit: true });
    const rest = binanceBookSource();
    singleton = new StreamingBookCache({
      watch: async (symbol) => {
        const ob = await ws.watchOrderBook(symbol, BOOK_DEPTH);
        return {
          symbol,
          ts: ob.timestamp ?? Date.now(),
          bids: ob.bids.slice(0, BOOK_DEPTH).map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })),
          asks: ob.asks.slice(0, BOOK_DEPTH).map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })),
        };
      },
      fetch: (symbol) => rest.fetchBook(symbol),
      unwatch: async (symbol) => {
        await ws.unWatchOrderBook(symbol);
      },
    });
  }
  return singleton;
}
