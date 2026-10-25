import { EventEmitter } from 'node:events';
import ccxt from 'ccxt';

export type Ticker = {
  symbol: string;
  price: number;
  changePct24h: number | null;
  ts: string; // ISO
};

export type FeedStatus = 'connecting' | 'connected' | 'disconnected' | 'stopped';

/** Höchstens so viele Ticker-Abos (ein WebSocket, Binance erlaubt deutlich mehr Streams). */
export const FEED_SYMBOL_CAP = 200;

/**
 * Feed-Symbole aus Katalog/Register (rein): Paare mit oder ohne Slash ("BTCUSDT" → "BTC/USDT"),
 * dedupliziert, Nicht-Paare (Aktien-Ticker) raus, gedeckelt; leer → Fallback.
 */
export function feedPairsFrom(raw: (string | null | undefined)[], fallback: string[], cap = FEED_SYMBOL_CAP): string[] {
  const out: string[] = [];
  for (const r of raw) {
    const p = String(r ?? '').toUpperCase().trim();
    const pair = /^[A-Z0-9]+\/[A-Z0-9]+$/.test(p) ? p : /^[A-Z0-9]+(USDT|USDC)$/.test(p) ? `${p.slice(0, -4)}/${p.slice(-4)}` : null;
    if (pair && !out.includes(pair)) out.push(pair);
    if (out.length >= cap) break;
  }
  return out.length > 0 ? out : [...fallback];
}

/**
 * Live-Preise über echte Binance-WebSockets (ccxt pro, im ccxt-Paket enthalten).
 * EHRLICH: bei Verbindungsverlust wird der Status 'disconnected' gemeldet und
 * es werden KEINE Werte erfunden — die UI zeigt den echten Zustand.
 * Die Symbol-Liste zieht nach (setSymbols, Asset-Register): neue Paare streamen ohne
 * Neustart, weggefallene hören auf.
 */
export class LivePriceFeed extends EventEmitter {
  private exchange: InstanceType<typeof ccxt.pro.binance> | null = null;
  private tickers = new Map<string, Ticker>();
  private statuses = new Map<string, FeedStatus>();
  private active: Set<string>;
  /** Laufende watch-Schleifen — ein wieder hinzugefügtes Symbol bekommt nie eine zweite. */
  private loops = new Set<string>();
  private running = false;

  constructor(symbols: string[]) {
    super();
    this.active = new Set(symbols);
    for (const s of symbols) this.statuses.set(s, 'connecting');
  }

  /** Aktuell abonnierte Symbole. */
  get symbols(): string[] {
    return [...this.active];
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.exchange = new ccxt.pro.binance({ enableRateLimit: true });
    for (const symbol of this.active) void this.watchLoop(symbol);
  }

  /** Symbol-Liste ersetzen: neue abonnieren (läuft der Feed, sofort), entfernte samt Status/Tick verwerfen. */
  setSymbols(next: string[]): { added: string[]; removed: string[] } {
    const want = new Set(next);
    const added = next.filter((s, i) => !this.active.has(s) && next.indexOf(s) === i);
    const removed = [...this.active].filter((s) => !want.has(s));
    for (const s of removed) {
      this.active.delete(s);
      this.statuses.delete(s);
      this.tickers.delete(s);
    }
    for (const s of added) {
      this.active.add(s);
      this.statuses.set(s, 'connecting');
      if (this.running && !this.loops.has(s)) void this.watchLoop(s);
    }
    return { added, removed };
  }

  private async watchLoop(symbol: string): Promise<void> {
    this.loops.add(symbol);
    try {
      await this.watchUntilRemoved(symbol);
    } finally {
      this.loops.delete(symbol);
    }
  }

  private async watchUntilRemoved(symbol: string): Promise<void> {
    while (this.running && this.exchange && this.active.has(symbol)) {
      try {
        const t = await this.exchange.watchTicker(symbol);
        if (!this.active.has(symbol)) break; // während des Wartens abbestellt
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
        if (!this.running || !this.active.has(symbol)) break;
        this.statuses.set(symbol, 'disconnected');
        this.emit('status', { symbol, status: 'disconnected' satisfies FeedStatus, error: String(err) });
        // Backoff, dann erneut versuchen (ccxt pro reconnectet intern ebenfalls)
        await new Promise((r) => setTimeout(r, 5000));
        if (this.active.has(symbol)) this.statuses.set(symbol, 'connecting');
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
    for (const s of this.active) this.statuses.set(s, 'stopped');
    await this.exchange?.close();
    this.exchange = null;
  }
}
