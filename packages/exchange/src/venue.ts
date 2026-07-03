/**
 * Einheitliches Trading-Interface für ALLE Börsen (06_ §1) — CEX wie DEX.
 * Strategien und Executor sind venue-agnostisch; nur der Adapter unterscheidet
 * Paper/Testnet/Live. Kein Adapter hat Auszahlungs-Fähigkeiten (by design).
 */

export type VenueOrderRequest = {
  /** Idempotenz-Schlüssel: gleiche clientOrderId ⇒ Börse/Engine dedupliziert. */
  clientOrderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'stop_market' | 'take_profit_market';
  qty: number;
  /** Trigger-Preis für stop/take_profit. */
  triggerPrice?: number;
  reduceOnly?: boolean;
};

export type VenueOrderResult = {
  clientOrderId: string;
  exchangeOrderId: string;
  status: 'filled' | 'open' | 'rejected';
  /** Tatsächlicher Fill-Preis (bei market sofort, sonst später). */
  fillPrice?: number;
  filledQty?: number;
  raw?: unknown;
};

export type VenuePosition = {
  symbol: string;
  direction: 'long' | 'short';
  qty: number;
  entryPrice: number;
};

export type MarketRules = { tickSize: number; lotSize: number; minNotional: number };

export interface TradingVenue {
  readonly id: string;
  readonly kind: 'paper' | 'testnet' | 'live';
  /** Verbindung/Zugang prüfen — ehrlich: false, wenn Keys fehlen o. Ä. */
  validate(): Promise<{ ok: boolean; detail: string }>;
  marketRules(symbol: string): Promise<MarketRules>;
  /** Aktueller Marktpreis (für Paper-Fills und Monitoring). IMMER echt. */
  markPrice(symbol: string): Promise<number>;
  placeOrder(req: VenueOrderRequest): Promise<VenueOrderResult>;
  cancelOrder(symbol: string, exchangeOrderId: string): Promise<void>;
  fetchPositions(): Promise<VenuePosition[]>;
  fetchOpenOrders(symbol?: string): Promise<{ clientOrderId: string; exchangeOrderId: string }[]>;
}
