import ccxt from 'ccxt';
import { CcxtLiveVenue, type CcxtLiveClient } from './ccxt-live-venue.js';
import type { MarketRules, OrderState, TradingVenue, VenueOrderRequest, VenueOrderResult, VenuePosition } from './venue.js';

/**
 * Binance-USDT-Perpetuals im DEMO-Trading (06_ §2). Aktiviert sich NUR, wenn
 * BINANCE_TESTNET_KEY/SECRET gesetzt sind — die Keys legt Patrick selbst an
 * (Binance Demo Trading, Futures). Ohne Keys meldet validate() ehrlich
 * „nicht verbunden".
 *
 * Session 10: läuft über denselben CCXT-Kern wie der Live-Adapter
 * (CcxtLiveVenue). Damit behoben (Recherche-Brief):
 * - kein blinder Retry der Market-Order nach Timeout (konnte doppelt kaufen),
 * - Duplikat/Timeout wird über die eigene clientOrderId geklärt (statt
 *   falschem Fehlercode -4015; Binance meldet Duplikate mit -4116),
 * - Stop/TP laufen seit 12/2025 über den Algo-Service → Abfrage/Storno mit
 *   {trigger:true},
 * - setSandboxMode ist für binanceusdm veraltet → enableDemoTrading.
 * Kein Withdraw-Codepfad — dieser Adapter kann ausschließlich handeln.
 */
export class BinanceTestnetVenue implements TradingVenue {
  readonly id = 'binance-testnet';
  readonly kind = 'testnet' as const;

  private inner: CcxtLiveVenue | null = null;

  /** `client` nur in Tests (Fake-Börse); Produktion baut den echten ccxt-Client. */
  constructor(apiKey?: string, secret?: string, client?: CcxtLiveClient) {
    if (apiKey && secret) {
      let c = client;
      if (!c) {
        const ex = new ccxt.binanceusdm({ apiKey, secret, enableRateLimit: true });
        ex.enableDemoTrading(true);
        c = ex as unknown as CcxtLiveClient;
      }
      this.inner = new CcxtLiveVenue({ connectionId: '', id: this.id, kind: 'testnet', exchangeId: 'binanceusdm', client: c });
    }
  }

  get configured(): boolean {
    return this.inner !== null;
  }

  private v(): CcxtLiveVenue {
    if (!this.inner) throw new Error('Binance-Testnet nicht konfiguriert (Keys fehlen).');
    return this.inner;
  }

  async validate(): Promise<{ ok: boolean; detail: string }> {
    if (!this.inner) {
      return { ok: false, detail: 'nicht verbunden — BINANCE_TESTNET_KEY/SECRET fehlen (Demo-Trading-Keys legt Patrick an).' };
    }
    return this.inner.validate();
  }

  async marketRules(symbol: string): Promise<MarketRules> {
    return this.v().marketRules(symbol);
  }

  async markPrice(symbol: string): Promise<number> {
    return this.v().markPrice(symbol);
  }

  async placeOrder(req: VenueOrderRequest): Promise<VenueOrderResult> {
    return this.v().placeOrder(req);
  }

  async cancelOrder(symbol: string, exchangeOrderId: string, opts?: { trigger?: boolean }): Promise<void> {
    return this.v().cancelOrder(symbol, exchangeOrderId, opts);
  }

  async fetchOrderState(symbol: string, exchangeOrderId: string, opts?: { trigger?: boolean }): Promise<OrderState> {
    return this.v().fetchOrderState(symbol, exchangeOrderId, opts);
  }

  async fetchPositions(): Promise<VenuePosition[]> {
    return this.v().fetchPositions();
  }

  async fetchOpenOrders(symbol?: string): Promise<{ clientOrderId: string; exchangeOrderId: string }[]> {
    return this.v().fetchOpenOrders(symbol);
  }
}
