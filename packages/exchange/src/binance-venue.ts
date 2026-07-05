import ccxt from 'ccxt';
import { stepFromPrecision, type MarketRules, type TradingVenue, type VenueOrderRequest, type VenueOrderResult, type VenuePosition } from './venue.js';

/**
 * Binance-USDT-Perpetuals im TESTNET (06_ §2). Aktiviert sich NUR, wenn
 * BINANCE_TESTNET_KEY/SECRET gesetzt sind — die Keys legt Patrick selbst an
 * (testnet.binancefuture.com); der Agent erzeugt nie Schlüssel.
 * Ohne Keys meldet validate() ehrlich „nicht verbunden".
 * Kein Withdraw-Codepfad — dieser Adapter kann ausschließlich handeln.
 */
export class BinanceTestnetVenue implements TradingVenue {
  readonly id = 'binance-testnet';
  readonly kind = 'testnet' as const;

  private exchange: InstanceType<typeof ccxt.binanceusdm> | null = null;

  constructor(private apiKey?: string, private secret?: string) {
    if (apiKey && secret) {
      this.exchange = new ccxt.binanceusdm({ apiKey, secret, enableRateLimit: true });
      this.exchange.setSandboxMode(true);
    }
  }

  get configured(): boolean {
    return this.exchange !== null;
  }

  private ex(): InstanceType<typeof ccxt.binanceusdm> {
    if (!this.exchange) throw new Error('Binance-Testnet nicht konfiguriert (Keys fehlen).');
    return this.exchange;
  }

  async validate(): Promise<{ ok: boolean; detail: string }> {
    if (!this.exchange) {
      return { ok: false, detail: 'nicht verbunden — BINANCE_TESTNET_KEY/SECRET fehlen (legt Patrick an).' };
    }
    try {
      await this.exchange.fetchBalance();
      return { ok: true, detail: 'Binance-Testnet verbunden.' };
    } catch (err) {
      return { ok: false, detail: `Testnet-Zugang fehlgeschlagen: ${String(err)}` };
    }
  }

  async marketRules(symbol: string): Promise<MarketRules> {
    const ex = this.ex();
    await ex.loadMarkets();
    const m = ex.market(symbol);
    const tickSizeMode = ex.precisionMode === ccxt.TICK_SIZE;
    return {
      tickSize: stepFromPrecision(m.precision?.price, tickSizeMode, 0.01),
      lotSize: stepFromPrecision(m.precision?.amount, tickSizeMode, 0.001),
      minNotional: Number(m.limits?.cost?.min ?? 5),
    };
  }

  async markPrice(symbol: string): Promise<number> {
    const t = await this.ex().fetchTicker(symbol);
    const price = t.last ?? t.close;
    if (typeof price !== 'number') throw new Error(`Kein Preis für ${symbol}.`);
    return price;
  }

  /** Order mit Retry (3 Versuche, exponentielles Backoff) — besonders für TP/SL Pflicht (06_ §5). */
  async placeOrder(req: VenueOrderRequest): Promise<VenueOrderResult> {
    const ex = this.ex();
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const params: Record<string, unknown> = { clientOrderId: req.clientOrderId };
        if (req.reduceOnly) params.reduceOnly = true;
        if (req.type !== 'market') params.stopPrice = req.triggerPrice;
        const type = req.type === 'market' ? 'market' : req.type === 'stop_market' ? 'stop_market' : 'take_profit_market';
        const o = await ex.createOrder(req.symbol, type, req.side, req.qty, undefined, params);
        return {
          clientOrderId: req.clientOrderId,
          exchangeOrderId: String(o.id),
          status: o.status === 'closed' ? 'filled' : 'open',
          fillPrice: typeof o.average === 'number' ? o.average : undefined,
          filledQty: typeof o.filled === 'number' ? o.filled : undefined,
          raw: o,
        };
      } catch (err) {
        lastErr = err;
        // Idempotenz: „Duplicate clientOrderId" heißt: Order existiert bereits → nachschlagen
        if (String(err).includes('Duplicate') || String(err).includes('-4015')) {
          const open = await this.fetchOpenOrders(req.symbol);
          const existing = open.find((x) => x.clientOrderId === req.clientOrderId);
          if (existing) {
            return { clientOrderId: req.clientOrderId, exchangeOrderId: existing.exchangeOrderId, status: 'open' };
          }
        }
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      }
    }
    throw new Error(`Order fehlgeschlagen nach 3 Versuchen: ${String(lastErr)}`);
  }

  async cancelOrder(symbol: string, exchangeOrderId: string): Promise<void> {
    await this.ex().cancelOrder(exchangeOrderId, symbol);
  }

  async fetchPositions(): Promise<VenuePosition[]> {
    const raw = await this.ex().fetchPositions();
    return raw
      .filter((p) => Math.abs(Number(p.contracts ?? 0)) > 0)
      .map((p) => ({
        symbol: String(p.symbol),
        direction: p.side === 'long' ? 'long' : 'short',
        qty: Math.abs(Number(p.contracts)),
        entryPrice: Number(p.entryPrice),
      }));
  }

  async fetchOpenOrders(symbol?: string): Promise<{ clientOrderId: string; exchangeOrderId: string }[]> {
    const raw = await this.ex().fetchOpenOrders(symbol);
    return raw.map((o) => ({
      clientOrderId: String(o.clientOrderId ?? ''),
      exchangeOrderId: String(o.id),
    }));
  }
}
