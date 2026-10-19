import { describe, expect, it } from 'vitest';
import { CcxtLiveVenue, formatClientOrderId, type CcxtLiveClient, type CcxtOrder } from './ccxt-live-venue.js';

/**
 * Live-Adapter gegen eine skriptbare Fake-Börse (nur im Test erlaubt).
 * Geprüft wird genau das, was bei echtem Geld schiefgehen kann: Symbol-
 * Auflösung auf Perps, Präzision, Parameter-Mapping je Börse, KEIN blinder
 * Retry nach Timeout, Trigger-Orders bei Binance nur mit {trigger:true}.
 */

type Call = { fn: string; args: unknown[] };

function netErr(msg = 'timeout'): Error {
  const e = new Error(msg);
  e.name = 'RequestTimeout';
  return e;
}
function invalidErr(msg = 'invalid'): Error {
  const e = new Error(msg);
  e.name = 'InvalidOrder';
  return e;
}

class FakeCcxt implements CcxtLiveClient {
  calls: Call[] = [];
  last = 100;
  open: CcxtOrder[] = [];
  closed: CcxtOrder[] = [];
  createImpl: ((symbol: string, type: string, side: string, amount: number, price?: number, params?: Record<string, unknown>) => Promise<CcxtOrder>) | null = null;
  markets: Record<string, { symbol: string; contract?: boolean; linear?: boolean; contractSize?: number; precision?: { amount?: number; price?: number }; limits?: { cost?: { min?: number } } }> = {
    'BTC/USDT': { symbol: 'BTC/USDT', contract: false },
    'BTC/USDT:USDT': { symbol: 'BTC/USDT:USDT', contract: true, linear: true, contractSize: 1, precision: { amount: 0.001, price: 0.1 }, limits: { cost: { min: 5 } } },
    'ETH/USDT:USDT': { symbol: 'ETH/USDT:USDT', contract: true, linear: true, contractSize: 0.1, precision: { amount: 1, price: 0.01 } },
  };
  precisionMode = 4; // TICK_SIZE
  private rec(fn: string, ...args: unknown[]) {
    this.calls.push({ fn, args });
  }
  async loadMarkets() {
    return this.markets;
  }
  market(symbol: string) {
    const m = this.markets[symbol];
    if (!m) throw new Error(`unbekannt ${symbol}`);
    return m;
  }
  amountToPrecision(symbol: string, amount: number) {
    const step = this.markets[symbol]!.precision?.amount ?? 0.001;
    return String(Math.floor(amount / step + 1e-9) * step);
  }
  priceToPrecision(symbol: string, price: number) {
    const step = this.markets[symbol]!.precision?.price ?? 0.01;
    return String(Math.round(price / step) * step);
  }
  async fetchTicker(symbol: string) {
    this.rec('fetchTicker', symbol);
    return { last: this.last };
  }
  async fetchBalance() {
    return { total: { USDT: 1234.5 } };
  }
  async createOrder(symbol: string, type: string, side: string, amount: number, price?: number, params: Record<string, unknown> = {}) {
    this.rec('createOrder', symbol, type, side, amount, price, params);
    if (this.createImpl) return this.createImpl(symbol, type, side, amount, price, params);
    const isTrigger = 'stopLossPrice' in params || 'takeProfitPrice' in params;
    const o: CcxtOrder = {
      id: `ex-${this.calls.length}`,
      clientOrderId: params.clientOrderId as string,
      status: isTrigger ? 'open' : 'closed',
      average: isTrigger ? undefined : this.last,
      filled: isTrigger ? 0 : amount,
      amount,
    };
    if (isTrigger) this.open.push(o);
    return o;
  }
  async cancelOrder(id: string, symbol: string, params: Record<string, unknown> = {}) {
    this.rec('cancelOrder', id, symbol, params);
    this.open = this.open.filter((o) => o.id !== id);
    return {};
  }
  async fetchOrder(id: string, symbol: string, params: Record<string, unknown> = {}) {
    this.rec('fetchOrder', id, symbol, params);
    const o = [...this.open, ...this.closed].find((x) => x.id === id);
    if (!o) throw Object.assign(new Error('not found'), { name: 'OrderNotFound' });
    return o;
  }
  async fetchOpenOrders(symbol?: string, _s?: number, _l?: number, params: Record<string, unknown> = {}) {
    this.rec('fetchOpenOrders', symbol, params);
    return this.open;
  }
  async fetchClosedOrders(symbol?: string, _s?: number, _l?: number, params: Record<string, unknown> = {}) {
    this.rec('fetchClosedOrders', symbol, params);
    return this.closed;
  }
  async fetchPositions() {
    return [{ symbol: 'ETH/USDT:USDT', side: 'long', contracts: 30, contractSize: 0.1, entryPrice: 2000 }];
  }
}

const venueFor = (exchangeId: string, fake: FakeCcxt) => new CcxtLiveVenue({ connectionId: 'c0ffee00-0000-4000-8000-000000000000', exchangeId, client: fake });

describe('CcxtLiveVenue (Live-Pfad, Perpetuals)', () => {
  it('Venue-ID kodiert die Verbindung; Art = live', () => {
    const v = venueFor('binanceusdm', new FakeCcxt());
    expect(v.id).toBe('live:c0ffee00-0000-4000-8000-000000000000');
    expect(v.kind).toBe('live');
  });

  it('löst Spot-Symbol auf den linearen Perp auf und rundet die Menge auf die Lot-Größe', async () => {
    const fake = new FakeCcxt();
    const res = await venueFor('binanceusdm', fake).placeOrder({ clientOrderId: 'gld-abc-e', symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 0.12345 });
    const call = fake.calls.find((c) => c.fn === 'createOrder')!;
    expect(call.args[0]).toBe('BTC/USDT:USDT');
    expect(call.args[3]).toBeCloseTo(0.123, 9);
    expect(res).toMatchObject({ status: 'filled', fillPrice: 100 });
  });

  it('Kontraktgröße ≠ 1 (OKX-artig): Menge wird in Kontrakte umgerechnet, Positionen zurück in Basis-Einheiten', async () => {
    const fake = new FakeCcxt();
    const v = venueFor('okx', fake);
    await v.placeOrder({ clientOrderId: 'gld-x', symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 3 });
    expect(fake.calls.find((c) => c.fn === 'createOrder')!.args[3]).toBe(30);
    expect(await v.fetchPositions()).toEqual([{ symbol: 'ETH/USDT:USDT', direction: 'long', qty: 3, entryPrice: 2000 }]);
  });

  it('kein Perp für das Symbol → ehrlich abgelehnt, nichts gesendet', async () => {
    const fake = new FakeCcxt();
    delete fake.markets['BTC/USDT:USDT'];
    await expect(venueFor('kraken', fake).placeOrder({ clientOrderId: 'x', symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 1 })).rejects.toThrow(/Perpetual/);
    expect(fake.calls.some((c) => c.fn === 'createOrder')).toBe(false);
  });

  it('Stop/TP: stopLossPrice/takeProfitPrice + reduceOnly, Trigger auf Tick gerundet', async () => {
    const fake = new FakeCcxt();
    const v = venueFor('bybit', fake);
    await v.placeOrder({ clientOrderId: 'gld-1-sl', symbol: 'BTC/USDT', side: 'sell', type: 'stop_market', qty: 0.1, triggerPrice: 95.04, reduceOnly: true });
    await v.placeOrder({ clientOrderId: 'gld-1-tp1', symbol: 'BTC/USDT', side: 'sell', type: 'take_profit_market', qty: 0.05, triggerPrice: 110, reduceOnly: true });
    const [sl, tp] = fake.calls.filter((c) => c.fn === 'createOrder');
    expect(sl!.args[5]).toMatchObject({ stopLossPrice: 95, reduceOnly: true });
    expect(tp!.args[5]).toMatchObject({ takeProfitPrice: 110, reduceOnly: true });
    expect(sl!.args[1]).toBe('market');
  });

  it('Hyperliquid braucht einen Preis auch bei Market-Orders (Worst-Price) → Live-Kurs wird mitgegeben', async () => {
    const fake = new FakeCcxt();
    fake.last = 101;
    await venueFor('hyperliquid', fake).placeOrder({ clientOrderId: 'gld-h', symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 0.1 });
    expect(fake.calls.find((c) => c.fn === 'createOrder')!.args[4]).toBe(101);
  });

  it('Timeout beim Senden → KEIN zweiter createOrder; Order wird über die clientOrderId gefunden', async () => {
    const fake = new FakeCcxt();
    fake.createImpl = async (_s, _t, _side, amount, _p, params) => {
      fake.closed.push({ id: 'ex-real', clientOrderId: params!.clientOrderId as string, status: 'closed', average: 100.5, filled: amount, amount });
      throw netErr();
    };
    const res = await venueFor('binanceusdm', fake).placeOrder({ clientOrderId: 'gld-t-e', symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 0.1 });
    expect(fake.calls.filter((c) => c.fn === 'createOrder')).toHaveLength(1);
    expect(res).toMatchObject({ status: 'filled', exchangeOrderId: 'ex-real', fillPrice: 100.5 });
  });

  it('Timeout und Order nirgends auffindbar → Fehler „Status unklar“, trotzdem kein zweiter Versuch', async () => {
    const fake = new FakeCcxt();
    fake.createImpl = async () => {
      throw netErr();
    };
    await expect(
      venueFor('binanceusdm', fake).placeOrder({ clientOrderId: 'gld-u-e', symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 0.1 }),
    ).rejects.toThrow(/unklar/);
    expect(fake.calls.filter((c) => c.fn === 'createOrder')).toHaveLength(1);
  });

  it('InvalidOrder/InsufficientFunds → rejected ohne Retry (Executor entscheidet: bei Stop = Notausstieg)', async () => {
    const fake = new FakeCcxt();
    fake.createImpl = async () => {
      throw invalidErr('trigger price invalid');
    };
    const res = await venueFor('binanceusdm', fake).placeOrder({ clientOrderId: 'gld-r-sl', symbol: 'BTC/USDT', side: 'sell', type: 'stop_market', qty: 0.1, triggerPrice: 90, reduceOnly: true });
    expect(res.status).toBe('rejected');
    expect(fake.calls.filter((c) => c.fn === 'createOrder')).toHaveLength(1);
  });

  it('Binance: Trigger-Orders nur mit {trigger:true} stornieren/abfragen (Algo-Service seit 12/2025)', async () => {
    const fake = new FakeCcxt();
    const v = venueFor('binanceusdm', fake);
    await v.cancelOrder('BTC/USDT', 'ex-9', { trigger: true });
    await v.fetchOrderState('BTC/USDT', 'ex-9', { trigger: true }).catch(() => undefined);
    expect(fake.calls.find((c) => c.fn === 'cancelOrder')!.args[2]).toEqual({ trigger: true });
    expect(fake.calls.find((c) => c.fn === 'fetchOrder')!.args[2]).toEqual({ trigger: true });
  });

  it('fetchOrderState meldet Fill mit echtem Durchschnittspreis', async () => {
    const fake = new FakeCcxt();
    fake.closed.push({ id: 'ex-5', status: 'closed', average: 94.8, filled: 0.1, amount: 0.1 });
    expect(await venueFor('bybit', fake).fetchOrderState('BTC/USDT', 'ex-5', { trigger: true })).toEqual({ status: 'filled', filled: 0.1, average: 94.8 });
  });
});

describe('formatClientOrderId: Format je Börse', () => {
  it.each([
    ['binanceusdm', 'gld-3f2a9c1e-7b44-4a-sl', /^[A-Za-z0-9._:/-]{1,36}$/],
    ['bybit', 'gld-3f2a9c1e-7b44-4a-sl', /^[A-Za-z0-9._:/-]{1,36}$/],
    ['okx', 'gld-3f2a9c1e-7b44-4a-sl', /^[A-Za-z0-9]{1,32}$/],
    ['hyperliquid', 'gld-3f2a9c1e-7b44-4a-sl', /^0x[0-9a-f]{32}$/],
  ])('%s', (ex, raw, re) => {
    const id = formatClientOrderId(ex, raw);
    expect(id).toMatch(re);
    expect(formatClientOrderId(ex, raw)).toBe(id); // deterministisch
    expect(formatClientOrderId(ex, `${raw}x`)).not.toBe(id); // eindeutig je Leg
  });
});
