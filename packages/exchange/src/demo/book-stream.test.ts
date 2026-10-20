/**
 * Orderbuch-Stream (Plan §2 „nächste Stufe"): Websocket-Buch warm halten, bei
 * Problemen ehrlich auf REST zurückfallen, ohne Abfragen den Stream beenden.
 * Reine Tests mit injizierten Funktionen (kein Netz).
 */
import { describe, expect, it } from 'vitest';
import type { OrderBookSnapshot } from './fill-engine.js';
import { StreamingBookCache } from './book-stream.js';

const book = (price: number, ts = 0): OrderBookSnapshot => ({
  symbol: 'BTC/USDT',
  ts,
  bids: [{ price, qty: 1 }],
  asks: [{ price: price + 1, qty: 1 }],
});

/** Watch-Double: jede Runde liefert das nächste Buch, sobald `push` es freigibt. */
function controllableWatch() {
  const waiting: ((b: OrderBookSnapshot) => void)[] = [];
  const rejecters: ((e: Error) => void)[] = [];
  const calls: string[] = [];
  return {
    calls,
    watch: (symbol: string) => {
      calls.push(symbol);
      return new Promise<OrderBookSnapshot>((resolve, reject) => {
        waiting.push(resolve);
        rejecters.push(reject);
      });
    },
    push(b: OrderBookSnapshot) {
      rejecters.shift();
      waiting.shift()?.(b);
    },
    fail(e: Error) {
      waiting.shift();
      rejecters.shift()?.(e);
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('StreamingBookCache', () => {
  it('erste Abfrage: REST-Buch sofort, Stream startet im Hintergrund', async () => {
    const w = controllableWatch();
    let restCalls = 0;
    const c = new StreamingBookCache({ watch: w.watch, fetch: async () => (restCalls++, book(100)), now: () => 0 });
    const b = await c.get('BTC/USDT');
    expect(b.bids[0]!.price).toBe(100);
    expect(restCalls).toBe(1);
    expect(w.calls).toEqual(['BTC/USDT']);
    expect(c.status('BTC/USDT')).toBe('connecting');
  });

  it('sobald der Stream liefert: neuestes Stream-Buch, kein REST mehr', async () => {
    const w = controllableWatch();
    let restCalls = 0;
    let t = 0;
    const c = new StreamingBookCache({ watch: w.watch, fetch: async () => (restCalls++, book(100)), now: () => t });
    await c.get('BTC/USDT');
    w.push(book(200, 1));
    await tick();
    t = 500;
    expect((await c.get('BTC/USDT')).bids[0]!.price).toBe(200);
    w.push(book(201, 2));
    await tick();
    expect((await c.get('BTC/USDT')).bids[0]!.price).toBe(201);
    expect(restCalls).toBe(1);
    expect(c.status('BTC/USDT')).toBe('live');
  });

  it('veraltetes Stream-Buch (keine Updates) → REST statt alter Daten', async () => {
    const w = controllableWatch();
    let t = 0;
    let rest = 300;
    const c = new StreamingBookCache({ watch: w.watch, fetch: async () => book(rest++), now: () => t, staleMs: 5_000 });
    await c.get('BTC/USDT');
    w.push(book(200));
    await tick();
    t = 10_000; // Stream schweigt seit 10 s
    expect((await c.get('BTC/USDT')).bids[0]!.price).toBe(301);
  });

  it('Stream-Fehler → REST-Fallback, Neuversuch erst nach Pause', async () => {
    const w = controllableWatch();
    let t = 0;
    const c = new StreamingBookCache({ watch: w.watch, fetch: async () => book(100), now: () => t, retryMs: 30_000 });
    await c.get('BTC/USDT');
    w.fail(new Error('451'));
    await tick();
    expect(c.status('BTC/USDT')).toBe('error');
    t = 10_000;
    await c.get('BTC/USDT');
    expect(w.calls).toHaveLength(1); // noch in der Pause
    t = 40_000;
    await c.get('BTC/USDT');
    expect(w.calls).toHaveLength(2); // neuer Versuch
  });

  it('ohne Abfragen endet der Stream nach idleMs (unwatch wird aufgerufen)', async () => {
    const w = controllableWatch();
    let t = 0;
    const stopped: string[] = [];
    const c = new StreamingBookCache({
      watch: w.watch,
      fetch: async () => book(100),
      unwatch: async (s) => void stopped.push(s),
      now: () => t,
      idleMs: 60_000,
    });
    await c.get('BTC/USDT');
    t = 61_000;
    w.push(book(200));
    await tick();
    await tick();
    expect(stopped).toEqual(['BTC/USDT']);
    expect(c.status('BTC/USDT')).toBe('idle');
    expect(w.calls).toHaveLength(1);
  });

  it('REST-Fehler ohne Stream-Buch wird durchgereicht (nie ein erfundenes Buch)', async () => {
    const w = controllableWatch();
    const c = new StreamingBookCache({ watch: w.watch, fetch: async () => Promise.reject(new Error('nicht erreichbar')), now: () => 0 });
    await expect(c.get('BTC/USDT')).rejects.toThrow('nicht erreichbar');
  });

  it('leeres Stream-Buch zählt nicht als Daten', async () => {
    const w = controllableWatch();
    const c = new StreamingBookCache({ watch: w.watch, fetch: async () => book(100), now: () => 0 });
    await c.get('BTC/USDT');
    w.push({ symbol: 'BTC/USDT', ts: 0, bids: [], asks: [] });
    await tick();
    expect((await c.get('BTC/USDT')).bids[0]!.price).toBe(100);
  });
});
