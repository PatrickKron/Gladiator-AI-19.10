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

/**
 * ccxt-Precision → Schrittweite. Börsen im TICK_SIZE-Modus (z. B. Binance)
 * liefern die Schrittweite DIREKT (0.00001); DECIMAL_PLACES-Börsen liefern die
 * Nachkommastellen (5 → 10^-5). Wird das verwechselt, entsteht aus 0.00001
 * „10^-0.00001 ≈ 1" — und das Sizing rundet jede Order auf qty 0.
 */
export function stepFromPrecision(value: unknown, tickSizeMode: boolean, fallback: number): number {
  if (value === null || value === undefined) return fallback; // Number(null) wäre 0
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (tickSizeMode) return n > 0 ? n : fallback;
  return n >= 0 ? Math.pow(10, -n) : fallback; // 0 Nachkommastellen = Schrittweite 1
}

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
