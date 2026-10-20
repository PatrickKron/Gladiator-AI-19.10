import { describe, expect, it } from 'vitest';
import { BinanceTestnetVenue } from './binance-venue.js';
import type { CcxtLiveClient, CcxtOrder } from './ccxt-live-venue.js';

/**
 * Binance-USDⓈ-M Demo/Testnet über den gemeinsamen CCXT-Kern (Recherche
 * Session 10): kein blinder Market-Retry nach Timeout, Trigger-Orders mit
 * {trigger:true}, Venue-ID/Art bleiben 'binance-testnet'/'testnet'.
 */
class Fake implements Partial<CcxtLiveClient> {
  creates = 0;
  canceled: unknown[] = [];
  failCreate = false;
  async loadMarkets() {
    return { 'BTC/USDT:USDT': { symbol: 'BTC/USDT:USDT', contract: true, linear: true, contractSize: 1, precision: { amount: 0.001, price: 0.1 } } };
  }
  market(s: string) {
    return { symbol: s, contract: true, contractSize: 1 };
  }
  amountToPrecision(_s: string, a: number) {
    return String(a);
  }
  priceToPrecision(_s: string, p: number) {
    return String(p);
  }
  async fetchTicker() {
    return { last: 100 };
  }
  async fetchBalance() {
    return { total: { USDT: 5000 } };
  }
  async createOrder(_s: string, _t: string, _side: string, amount: number): Promise<CcxtOrder> {
    this.creates++;
    if (this.failCreate) throw Object.assign(new Error('timeout'), { name: 'RequestTimeout' });
    return { id: 'b-1', status: 'closed', average: 100, filled: amount, amount };
  }
  async cancelOrder(id: string, s: string, params?: Record<string, unknown>) {
    this.canceled.push([id, s, params]);
    return {};
  }
  async fetchOpenOrders() {
    return [];
  }
  async fetchClosedOrders() {
    return [];
  }
  async fetchPositions() {
    return [];
  }
}

describe('BinanceTestnetVenue (Demo-Trading, gemeinsamer CCXT-Kern)', () => {
  it('ohne Keys: ehrlich nicht verbunden, keine Order möglich', async () => {
    const v = new BinanceTestnetVenue();
    expect(v.configured).toBe(false);
    expect((await v.validate()).ok).toBe(false);
    await expect(v.markPrice('BTC/USDT')).rejects.toThrow(/nicht konfiguriert/);
  });

  it('ID und Art bleiben stabil (Freigaben/Positionen hängen daran)', () => {
    const v = new BinanceTestnetVenue('k', 's', new Fake() as unknown as CcxtLiveClient);
    expect(v.id).toBe('binance-testnet');
    expect(v.kind).toBe('testnet');
  });

  it('Market-Order nach Timeout wird NICHT blind wiederholt (Doppelkauf-Schutz)', async () => {
    const fake = new Fake();
    fake.failCreate = true;
    const v = new BinanceTestnetVenue('k', 's', fake as unknown as CcxtLiveClient);
    await expect(v.placeOrder({ clientOrderId: 'gld-x-e', symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 0.01 })).rejects.toThrow(/unklar/);
    expect(fake.creates).toBe(1);
  });

  it('Stop/TP-Storno geht an den Algo-Service ({trigger:true})', async () => {
    const fake = new Fake();
    const v = new BinanceTestnetVenue('k', 's', fake as unknown as CcxtLiveClient);
    await v.cancelOrder('BTC/USDT', 'algo-7', { trigger: true });
    expect(fake.canceled[0]).toEqual(['algo-7', 'BTC/USDT:USDT', { trigger: true }]);
  });
});
