import { EventEmitter } from 'node:events';
import ccxt from 'ccxt';

export type Ticker = {
  symbol: string;
  price: number;
  changePct24h: number | null;
  ts: string; // ISO
};

export type FeedStatus = 'connecting' | 'connected' | 'disconnected' | 'stopped';

/**
 * Live-Preise über echte Binance-WebSockets (ccxt pro, im ccxt-Paket enthalten).
 * EHRLICH: bei Verbindungsverlust wird der Status 'disconnected' gemeldet und
 * es werden KEINE Werte erfunden — die UI zeigt den echten Zustand.
 */
export class LivePriceFeed extends EventEmitter {
  private exchange: InstanceType<typeof ccxt.pro.binance> | null = null;
  private tickers = new Map<string, Ticker>();
  private statuses = new Map<string, FeedStatus>();
  private running = false;

  constructor(public readonly symbols: string[]) {
    super();
    for (const s of symbols) this.statuses.set(s, 'connecting');
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.exchange = new ccxt.pro.binance({ enableRateLimit: true });
    for (const symbol of this.symbols) void this.watchLoop(symbol);
  }

  private async watchLoop(symbol: string): Promise<void> {
    while (this.running && this.exchange) {
      try {
        const t = await this.exchange.watchTicker(symbol);
        const last = t.last ?? t.close;
        if (typeof last !== 'number' || !Number.isFinite(last)) continue;
        const ticker: Ticker = {
          symbol,
          price: last,
          changePct24h: typeof t.percentage === 'number' ? t.percentage : null,
          ts: new Date(t.timestamp ?? Date.now()).toISOString(),
        };
        this.tickers.set(symbol, ticker);
        if (this.statuses.get(symbol) !== 'connected') {
          this.statuses.set(symbol, 'connected');
          this.emit('status', { symbol, status: 'connected' satisfies FeedStatus });
        }
        this.emit('tick', ticker);
      } catch (err) {
        if (!this.running) break;
        this.statuses.set(symbol, 'disconnected');
        this.emit('status', { symbol, status: 'disconnected' satisfies FeedStatus, error: String(err) });
        // Backoff, dann erneut versuchen (ccxt pro reconnectet intern ebenfalls)
        await new Promise((r) => setTimeout(r, 5000));
        this.statuses.set(symbol, 'connecting');
      }
    }
  }

  /** Aktueller Stand (letzter echter Tick je Symbol + Verbindungsstatus). */
  snapshot(): { tickers: Ticker[]; status: Record<string, FeedStatus> } {
    return {
      tickers: [...this.tickers.values()],
      status: Object.fromEntries(this.statuses),
    };
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const s of this.symbols) this.statuses.set(s, 'stopped');
    await this.exchange?.close();
    this.exchange = null;
  }
}
