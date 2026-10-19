import { createHash } from 'node:crypto';
import type { MarketRules, TradingVenue, VenueOrderRequest, VenueOrderResult, VenuePosition, OrderState } from './venue.js';

/**
 * Live-Adapter für JEDE per CCXT verbundene Börse (Patricks Verbindungen aus
 * exchange_connections) — vorerst NUR Perpetuals: dort sind Stop/TP sauber
 * reduceOnly und einheitlich (stopLossPrice/takeProfitPrice). Spot-SL blockiert
 * Assets bzw. braucht OCO → bewusst noch nicht.
 *
 * Sicherheitsprinzipien (Recherche freqtrade / Hummingbot / nautilus, Session 10):
 * - createOrder wird NIE blind wiederholt. Nach Netz-Timeout wird der Status
 *   über die eigene clientOrderId geklärt; nicht auffindbar → Fehler „unklar“,
 *   der Abgleich (Reconciler) findet eine evtl. doch entstandene Position.
 * - InvalidOrder/InsufficientFunds → rejected (der Executor macht bei einem
 *   Stop daraus den Notausstieg).
 * - Binance-USDⓈ-M-Conditional-Orders laufen seit 12/2025 über den Algo-Service:
 *   Abfrage/Storno nur mit {trigger:true}.
 * - Kein Withdraw-Codepfad; der ccxt-Client wird injiziert (testbar ohne Netz).
 */

export type CcxtOrder = {
  id: string;
  clientOrderId?: string;
  status?: string;
  average?: number;
  price?: number;
  filled?: number;
  amount?: number;
};

type CcxtMarketLike = {
  symbol: string;
  contract?: boolean;
  linear?: boolean;
  contractSize?: number;
  precision?: { amount?: number; price?: number };
  limits?: { cost?: { min?: number } };
};

/** Genau die ccxt-Methoden, die der Live-Pfad braucht (schmal = prüfbar). */
export type CcxtLiveClient = {
  loadMarkets(): Promise<Record<string, CcxtMarketLike>>;
  market(symbol: string): CcxtMarketLike;
  amountToPrecision(symbol: string, amount: number): string;
  priceToPrecision(symbol: string, price: number): string;
  fetchTicker(symbol: string): Promise<{ last?: number; close?: number }>;
  fetchBalance(): Promise<{ total?: Record<string, number> }>;
  createOrder(symbol: string, type: string, side: string, amount: number, price?: number, params?: Record<string, unknown>): Promise<CcxtOrder>;
  cancelOrder(id: string, symbol: string, params?: Record<string, unknown>): Promise<unknown>;
  fetchOrder?(id: string, symbol: string, params?: Record<string, unknown>): Promise<CcxtOrder>;
  fetchOpenOrders(symbol?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<CcxtOrder[]>;
  fetchClosedOrders?(symbol?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<CcxtOrder[]>;
  fetchPositions(symbols?: string[]): Promise<{ symbol: string; side?: string; contracts?: number; contractSize?: number; entryPrice?: number }[]>;
  precisionMode?: number;
};

/** Börsen-Profile (Recherche-Brief §1). Unbekannte Börsen: konservativer Default. */
type ExchangeProfile = {
  /** Market-/Trigger-Market-Orders brauchen einen Referenzpreis (Hyperliquid: IOC-Limit mit Worst-Price). */
  needsPriceForMarket: boolean;
  /** Parameter, um Trigger-Orders abzufragen/zu stornieren. */
  triggerQuery: Record<string, unknown>;
};

const PROFILES: Record<string, ExchangeProfile> = {
  binance: { needsPriceForMarket: false, triggerQuery: { trigger: true } },
  binanceusdm: { needsPriceForMarket: false, triggerQuery: { trigger: true } },
  bybit: { needsPriceForMarket: false, triggerQuery: { trigger: true } },
  okx: { needsPriceForMarket: false, triggerQuery: { trigger: true } },
  hyperliquid: { needsPriceForMarket: true, triggerQuery: {} },
};
const DEFAULT_PROFILE: ExchangeProfile = { needsPriceForMarket: false, triggerQuery: { trigger: true } };

const NETWORK_ERRORS = new Set(['NetworkError', 'RequestTimeout', 'ExchangeNotAvailable', 'DDoSProtection', 'RateLimitExceeded', 'OnMaintenance']);

function isNetworkError(err: unknown): boolean {
  return err instanceof Error && NETWORK_ERRORS.has(err.name);
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * clientOrderId im Format der Börse — deterministisch (gleiches Leg = gleiche ID,
 * Idempotenz) und eindeutig je Leg. Binance/Bybit ≤ 36 [A-Za-z0-9._:/-],
 * OKX ≤ 32 alphanumerisch, Hyperliquid cloid = 0x + 32 Hex.
 */
export function formatClientOrderId(exchangeId: string, raw: string): string {
  if (exchangeId === 'hyperliquid') return `0x${hash(raw).slice(0, 32)}`;
  if (exchangeId === 'okx') {
    const alnum = raw.replace(/[^A-Za-z0-9]/g, '');
    return alnum.length <= 32 ? alnum : `g${hash(raw).slice(0, 31)}`;
  }
  const safe = raw.replace(/[^A-Za-z0-9._:/-]/g, '-');
  return safe.length <= 36 ? safe : `gld-${hash(raw).slice(0, 32)}`;
}

function mapStatus(s: string | undefined): OrderState['status'] {
  if (s === 'closed') return 'filled';
  if (s === 'open') return 'open';
  if (s === 'canceled' || s === 'cancelled' || s === 'rejected' || s === 'expired') return 'canceled';
  return 'unknown';
}

export class CcxtLiveVenue implements TradingVenue {
  readonly id: string;
  readonly kind: 'live' | 'testnet';
  readonly exchangeId: string;
  private readonly client: CcxtLiveClient;
  private readonly profile: ExchangeProfile;
  private marketsLoaded = false;

  constructor(cfg: {
    connectionId: string;
    exchangeId: string;
    client: CcxtLiveClient;
    /** Nur für Testnet/Demo-Venues mit fester ID (z. B. 'binance-testnet'). */
    id?: string;
    kind?: 'live' | 'testnet';
  }) {
    this.id = cfg.id ?? `live:${cfg.connectionId}`;
    this.kind = cfg.kind ?? 'live';
    this.exchangeId = cfg.exchangeId;
    this.client = cfg.client;
    this.profile = PROFILES[cfg.exchangeId] ?? DEFAULT_PROFILE;
  }

  /** Signal-Symbol ('BTC/USDT') → linearer Perp der Börse ('BTC/USDT:USDT'). Kein Perp → Fehler. */
  private async perp(symbol: string): Promise<CcxtMarketLike> {
    const markets = await this.client.loadMarkets();
    this.marketsLoaded = true;
    const direct = markets[symbol];
    if (direct?.contract) return direct;
    const quote = symbol.split('/')[1]?.split(':')[0];
    const linear = quote ? markets[`${symbol.split(':')[0]}:${quote}`] : undefined;
    if (linear?.contract) return linear;
    throw new Error(`${symbol}: kein Perpetual auf ${this.exchangeId} — Live-Handel ist vorerst nur für Perpetuals freigeschaltet.`);
  }

  async validate(): Promise<{ ok: boolean; detail: string }> {
    try {
      const bal = await this.client.fetchBalance();
      const usdt = bal.total?.USDT ?? bal.total?.USDC ?? null;
      return { ok: true, detail: `${this.exchangeId} live verbunden${usdt !== null ? ` · Guthaben ${usdt} USD(T)` : ''}.` };
    } catch (err) {
      return { ok: false, detail: `Live-Zugang ${this.exchangeId} fehlgeschlagen: ${String(err)}` };
    }
  }

  /** Echtes Konto-Equity in USD(T) — Basis für das Risk-Sizing im Live-Modus. */
  async equityUsd(): Promise<number | null> {
    const bal = await this.client.fetchBalance();
    const v = bal.total?.USDT ?? bal.total?.USDC ?? bal.total?.USD;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  async marketRules(symbol: string): Promise<MarketRules> {
    const m = await this.perp(symbol);
    const size = m.contractSize ?? 1;
    return {
      tickSize: m.precision?.price ?? 0.01,
      // Lot in BASIS-Einheiten (Kontraktgröße eingerechnet), wie der Risk-Sizer rechnet.
      lotSize: (m.precision?.amount ?? 0.001) * size,
      minNotional: Number(m.limits?.cost?.min ?? 5),
    };
  }

  async markPrice(symbol: string): Promise<number> {
    const m = await this.perp(symbol);
    const t = await this.client.fetchTicker(m.symbol);
    const price = t.last ?? t.close;
    if (typeof price !== 'number' || !Number.isFinite(price)) throw new Error(`Kein echter Preis für ${m.symbol}.`);
    return price;
  }

  async placeOrder(req: VenueOrderRequest): Promise<VenueOrderResult> {
    const m = await this.perp(req.symbol);
    const sym = m.symbol;
    const size = m.contractSize ?? 1;
    const amount = Number(this.client.amountToPrecision(sym, req.qty / size));
    if (!(amount > 0)) return { clientOrderId: req.clientOrderId, exchangeOrderId: '', status: 'rejected', raw: 'Menge unter Lot-Größe' };

    const trigger = req.type !== 'market';
    const cid = formatClientOrderId(this.exchangeId, req.clientOrderId);
    const params: Record<string, unknown> = { clientOrderId: cid };
    if (req.reduceOnly) params.reduceOnly = true;
    if (trigger) {
      if (req.triggerPrice === undefined) return { clientOrderId: req.clientOrderId, exchangeOrderId: '', status: 'rejected', raw: 'Trigger fehlt' };
      const tp = Number(this.client.priceToPrecision(sym, req.triggerPrice));
      if (req.type === 'stop_market') params.stopLossPrice = tp;
      else params.takeProfitPrice = tp;
    }
    const price = this.profile.needsPriceForMarket ? await this.markPrice(req.symbol) : undefined;

    let order: CcxtOrder;
    try {
      order = await this.client.createOrder(sym, 'market', req.side, amount, price, params);
    } catch (err) {
      if (isNetworkError(err)) {
        // NIE blind neu senden: über die eigene clientOrderId klären, ob die Order existiert.
        const found = await this.findByClientId(sym, cid, trigger);
        if (found) return this.toResult(req, sym, found, size);
        throw new Error(`Order-Status unklar nach Netzfehler (${String(err)}) — nicht erneut gesendet; der Abgleich prüft die Börse.`);
      }
      return { clientOrderId: req.clientOrderId, exchangeOrderId: '', status: 'rejected', raw: String(err) };
    }
    return this.toResult(req, sym, order, size);
  }

  private async toResult(req: VenueOrderRequest, sym: string, order: CcxtOrder, size: number): Promise<VenueOrderResult> {
    let o = order;
    // Market-Fill ohne Durchschnittspreis in der Antwort → einmal echt nachfragen (nie schätzen).
    if (req.type === 'market' && (typeof o.average !== 'number' || o.status !== 'closed') && this.client.fetchOrder) {
      try {
        o = await this.client.fetchOrder(o.id, sym);
      } catch {
        /* bleibt bei der Erstantwort */
      }
    }
    const status = mapStatus(o.status);
    return {
      clientOrderId: req.clientOrderId,
      exchangeOrderId: String(o.id),
      status: status === 'filled' ? 'filled' : status === 'canceled' ? 'rejected' : 'open',
      fillPrice: typeof o.average === 'number' ? o.average : undefined,
      filledQty: typeof o.filled === 'number' ? o.filled * size : undefined,
      raw: o,
    };
  }

  private async findByClientId(sym: string, cid: string, trigger: boolean): Promise<CcxtOrder | null> {
    const q = trigger ? this.profile.triggerQuery : {};
    for (const fetch of [
      () => this.client.fetchOpenOrders(sym, undefined, undefined, q),
      () => (this.client.fetchClosedOrders ? this.client.fetchClosedOrders(sym, Date.now() - 10 * 60_000, undefined, q) : Promise.resolve([])),
    ]) {
      try {
        const hit = (await fetch()).find((o) => o.clientOrderId === cid);
        if (hit) return hit;
      } catch {
        /* nächste Quelle */
      }
    }
    return null;
  }

  async cancelOrder(symbol: string, exchangeOrderId: string, opts: { trigger?: boolean } = {}): Promise<void> {
    const m = await this.perp(symbol);
    await this.client.cancelOrder(exchangeOrderId, m.symbol, opts.trigger ? this.profile.triggerQuery : {});
  }

  async fetchOrderState(symbol: string, exchangeOrderId: string, opts: { trigger?: boolean } = {}): Promise<OrderState> {
    const m = await this.perp(symbol);
    if (!this.client.fetchOrder) throw new Error(`${this.exchangeId}: fetchOrder nicht unterstützt.`);
    const o = await this.client.fetchOrder(exchangeOrderId, m.symbol, opts.trigger ? this.profile.triggerQuery : {});
    const size = m.contractSize ?? 1;
    return {
      status: mapStatus(o.status),
      filled: typeof o.filled === 'number' ? o.filled * size : 0,
      average: typeof o.average === 'number' ? o.average : null,
    };
  }

  async fetchPositions(): Promise<VenuePosition[]> {
    const raw = await this.client.fetchPositions();
    return raw
      .filter((p) => Math.abs(Number(p.contracts ?? 0)) > 0)
      .map((p) => ({
        symbol: String(p.symbol),
        direction: p.side === 'short' ? 'short' : 'long',
        qty: Math.abs(Number(p.contracts)) * Number(p.contractSize ?? 1),
        entryPrice: Number(p.entryPrice),
      }));
  }

  async fetchOpenOrders(symbol?: string): Promise<{ clientOrderId: string; exchangeOrderId: string }[]> {
    const sym = symbol ? (await this.perp(symbol)).symbol : undefined;
    const lists = await Promise.all([
      this.client.fetchOpenOrders(sym),
      this.client.fetchOpenOrders(sym, undefined, undefined, this.profile.triggerQuery).catch(() => [] as CcxtOrder[]),
    ]);
    const seen = new Set<string>();
    return lists
      .flat()
      .filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true)))
      .map((o) => ({ clientOrderId: String(o.clientOrderId ?? ''), exchangeOrderId: String(o.id) }));
  }

  get loaded(): boolean {
    return this.marketsLoaded;
  }
}
