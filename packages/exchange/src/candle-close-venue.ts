import type { Db } from '@gladiator/db';
import { latestFreshClose, type LatestClose } from '@gladiator/market-data';
import { CANDLE_CLOSE_VENUE_PREFIX, candleCloseSourceOf, isCandleCloseSource, type CandleCloseSource } from './signal-venue.js';
import type { MarketRules, TradingVenue, VenueOrderRequest, VenueOrderResult, VenuePosition } from './venue.js';

/**
 * Schlusskurs-Ausführung (A2, Übergabe 2026-10-27): Für Aktien/ETF/Forex/Rohstoffe aus Yahoo oder
 * Twelve Data gibt es keine Börse im System. Paper-Market-Orders füllen zum letzten ECHTEN,
 * FRISCHEN Kerzenschluss (`latestFreshClose`, 5m/15m/1h/1d; Kerzen-Refresh alle 15 min) und sind
 * im Order-Datensatz als `execution: 'candle_close'` beschriftet — Vorbild ist die Demo-Quelle
 * `CandleCloseBookSource` (api). Veraltet oder keine Kerze ⇒ Fehler, nie ein alter oder erfundener
 * Kurs. Stop/TP-Orders überwacht der PositionMonitor gegen denselben Schlusskurs. Nur Paper —
 * es gibt hier nichts, was an eine Börse geht.
 */
export class CandleCloseVenue implements TradingVenue {
  readonly id: string;
  readonly kind = 'paper' as const;

  private orderSeq = 0;
  private seenClientIds = new Map<string, VenueOrderResult>();

  constructor(
    readonly source: CandleCloseSource,
    private readonly closeOf: (symbol: string) => Promise<LatestClose>,
  ) {
    this.id = `${CANDLE_CLOSE_VENUE_PREFIX}${source}`;
  }

  static forDb(db: Db, source: CandleCloseSource): CandleCloseVenue {
    return new CandleCloseVenue(source, (symbol) => latestFreshClose(db, { venue: source, symbol }));
  }

  async validate(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: `Schlusskurs-Ausführung (${this.source}) — Paper-Fills zum letzten frischen Kerzenschluss.` };
  }

  async marketRules(): Promise<MarketRules> {
    // Kein Börsen-Regelwerk: Forex-taugliche Kursschritte, Bruchstücke erlaubt (Paper).
    return { tickSize: 0.0001, lotSize: 0.0001, minNotional: 1 };
  }

  async markPrice(symbol: string): Promise<number> {
    const best = await this.closeOf(symbol);
    if (!best.ok) {
      if (best.reason === 'stale') {
        throw new Error(`Kerzen für ${symbol} (${this.source}) veraltet (letzte ${best.lastTs?.toISOString() ?? '—'}) — kein Schlusskurs.`);
      }
      throw new Error(`Keine echten Kerzen für ${symbol} (${this.source}) — kein Schlusskurs.`);
    }
    return best.price;
  }

  async placeOrder(req: VenueOrderRequest): Promise<VenueOrderResult> {
    const seen = this.seenClientIds.get(req.clientOrderId);
    if (seen) return seen;

    let result: VenueOrderResult;
    if (req.type === 'market') {
      const price = await this.markPrice(req.symbol);
      result = {
        clientOrderId: req.clientOrderId,
        exchangeOrderId: `close-${Date.now()}-${++this.orderSeq}`,
        status: 'filled',
        fillPrice: price,
        filledQty: req.qty,
        raw: { execution: 'candle_close', source: this.source },
      };
    } else {
      if (req.triggerPrice === undefined) {
        return { clientOrderId: req.clientOrderId, exchangeOrderId: '', status: 'rejected' };
      }
      result = { clientOrderId: req.clientOrderId, exchangeOrderId: `close-${Date.now()}-${++this.orderSeq}`, status: 'open' };
    }
    this.seenClientIds.set(req.clientOrderId, result);
    return result;
  }

  async cancelOrder(): Promise<void> {
    // Paper: Orders leben in der DB; der Executor setzt dort den Status.
  }

  async fetchPositions(): Promise<VenuePosition[]> {
    return [];
  }

  async fetchOpenOrders(): Promise<{ clientOrderId: string; exchangeOrderId: string }[]> {
    return [];
  }
}

/**
 * Aktiver Venue mit Schlusskurs-Weiche (A2): delegiert alles an den Basis-Venue (Binance-Paper,
 * Testnet …) und liefert für Yahoo/Twelve Data den `CandleCloseVenue`. Nur der Serverstart baut
 * ihn (`withCandleClose`) — Test-Venues ohne Weiche sehen Schlusskurs-Positionen nie (der Monitor
 * überspringt sie), damit Tests gegen die echte DB keine echten Positionen bewerten.
 */
export class SourceRoutingVenue implements TradingVenue {
  readonly fetchOrderState?: TradingVenue['fetchOrderState'];
  private readonly closeVenues = new Map<CandleCloseSource, CandleCloseVenue>();

  constructor(
    readonly base: TradingVenue,
    private readonly db: Db,
  ) {
    if (base.fetchOrderState) this.fetchOrderState = base.fetchOrderState.bind(base);
  }

  get id(): string {
    return this.base.id;
  }
  get kind(): TradingVenue['kind'] {
    return this.base.kind;
  }
  validate() {
    return this.base.validate();
  }
  marketRules(symbol: string) {
    return this.base.marketRules(symbol);
  }
  markPrice(symbol: string) {
    return this.base.markPrice(symbol);
  }
  placeOrder(req: VenueOrderRequest) {
    return this.base.placeOrder(req);
  }
  cancelOrder(symbol: string, exchangeOrderId: string, opts?: { trigger?: boolean }) {
    return this.base.cancelOrder(symbol, exchangeOrderId, opts);
  }
  fetchPositions() {
    return this.base.fetchPositions();
  }
  fetchOpenOrders(symbol?: string) {
    return this.base.fetchOpenOrders(symbol);
  }

  private closeVenue(source: CandleCloseSource): CandleCloseVenue {
    let v = this.closeVenues.get(source);
    if (!v) {
      v = CandleCloseVenue.forDb(this.db, source);
      this.closeVenues.set(source, v);
    }
    return v;
  }

  /** Signal-Quelle → Venue: Yahoo/Twelve Data → Schlusskurs, sonst dieser Venue. */
  forSource(source: string): TradingVenue {
    return isCandleCloseSource(source) ? this.closeVenue(source) : this;
  }

  /** Positions-Kennung → Venue: `paper-close:…` → Schlusskurs, sonst dieser Venue. */
  forPosition(venueId: string): TradingVenue {
    const source = candleCloseSourceOf(venueId);
    return source ? this.closeVenue(source) : this;
  }
}

/** Serverstart: aktiven Venue um die Schlusskurs-Weiche ergänzen. */
export function withCandleClose(db: Db, base: TradingVenue): SourceRoutingVenue {
  return base instanceof SourceRoutingVenue ? base : new SourceRoutingVenue(base, db);
}

/** Venue für ein Signal nach Kerzenquelle. Ohne Weiche: Börsen-Quellen ⇒ ehrlicher Fehler. */
export function venueForSource(venue: TradingVenue, source: string): TradingVenue {
  if (venue instanceof SourceRoutingVenue) return venue.forSource(source);
  if (isCandleCloseSource(source)) throw new Error(`Schlusskurs-Ausführung (${source}) ist auf diesem Venue nicht eingerichtet.`);
  return venue;
}

/** Venue einer offenen Position (`positions.venue`). null = Schlusskurs-Position ohne Weiche. */
export function venueForPosition(venue: TradingVenue, venueId: string): TradingVenue | null {
  if (venue instanceof SourceRoutingVenue) return venue.forPosition(venueId);
  return candleCloseSourceOf(venueId) ? null : venue;
}
