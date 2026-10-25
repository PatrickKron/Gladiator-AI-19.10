import type { Db } from '@gladiator/db';
import type { DemoBookSource, MarketRules, OrderBookSnapshot } from '@gladiator/exchange';
import { latestFreshClose } from '@gladiator/market-data';

/**
 * Demo-Preisquelle für Aktien/ETF/Forex (Patricks Mängelliste 2026-10-22, Punkt 11): Für
 * Yahoo/Twelve Data gibt es kein Orderbuch — die Demo führt zum letzten echten Schlusskurs
 * aus der Kerzen-DB aus (ein Preisniveau, praktisch unbegrenzte Tiefe). Das ist ehrlich als
 * „Schlusskurs-Ausführung“ beschriftet; Spread/Slippage sind hier null, Gebühren gelten.
 * Keine Kerzen ⇒ Fehler (nie ein erfundener Kurs). Seit dem Asset-Register: neueste FRISCHE
 * Kerze über 5m/15m/1h/1d (`latestFreshClose`, Kerzen-Refresh alle 15 min) — nur veraltete
 * Kerzen ⇒ Fehler statt Ausführung zum alten Kurs.
 */
const DEPTH_QTY = 1e12;

export class CandleCloseBookSource implements DemoBookSource {
  constructor(
    private readonly db: Db,
    readonly venueId: string,
  ) {}

  async fetchBook(symbol: string): Promise<OrderBookSnapshot> {
    const best = await latestFreshClose(this.db, { venue: this.venueId, symbol });
    if (!best.ok) {
      if (best.reason === 'stale') throw new Error(`Kerzen für ${symbol} (${this.venueId}) veraltet (letzte ${best.lastTs?.toISOString() ?? '—'}) — kein Demo-Kurs.`);
      throw new Error(`Keine echten Kerzen für ${symbol} (${this.venueId}) — kein Demo-Kurs.`);
    }
    return { symbol, ts: best.ts.getTime(), bids: [{ price: best.price, qty: DEPTH_QTY }], asks: [{ price: best.price, qty: DEPTH_QTY }] };
  }

  async marketRules(): Promise<MarketRules> {
    return { tickSize: 0.01, lotSize: 0.0001, minNotional: 1 };
  }
}
