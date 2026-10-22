import type { Db } from '@gladiator/db';
import type { DemoBookSource, MarketRules, OrderBookSnapshot } from '@gladiator/exchange';
import { getOhlcv } from '@gladiator/market-data';

/**
 * Demo-Preisquelle für Aktien/ETF/Forex (Patricks Mängelliste 2026-10-22, Punkt 11): Für
 * Yahoo/Twelve Data gibt es kein Orderbuch — die Demo führt zum letzten echten Schlusskurs
 * aus der Kerzen-DB aus (ein Preisniveau, praktisch unbegrenzte Tiefe). Das ist ehrlich als
 * „Schlusskurs-Ausführung“ beschriftet; Spread/Slippage sind hier null, Gebühren gelten.
 * Keine Kerzen ⇒ Fehler (nie ein erfundener Kurs).
 */
const TIMEFRAMES = ['5m', '15m', '1h', '1d'] as const;
const DEPTH_QTY = 1e12;

export class CandleCloseBookSource implements DemoBookSource {
  constructor(
    private readonly db: Db,
    readonly venueId: string,
  ) {}

  async fetchBook(symbol: string): Promise<OrderBookSnapshot> {
    let best: { ts: Date; close: number } | null = null;
    for (const timeframe of TIMEFRAMES) {
      const [c] = await getOhlcv(this.db, { venue: this.venueId, symbol, timeframe, limit: 1 });
      if (c && (!best || c.ts > best.ts)) best = { ts: c.ts, close: c.close };
    }
    if (!best || !(best.close > 0)) throw new Error(`Keine echten Kerzen für ${symbol} (${this.venueId}) — kein Demo-Kurs.`);
    return { symbol, ts: best.ts.getTime(), bids: [{ price: best.close, qty: DEPTH_QTY }], asks: [{ price: best.close, qty: DEPTH_QTY }] };
  }

  async marketRules(): Promise<MarketRules> {
    return { tickSize: 0.01, lotSize: 0.0001, minNotional: 1 };
  }
}
