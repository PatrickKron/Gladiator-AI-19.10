import { describe, expect, it } from 'vitest';
import type { FetchLike } from './fx.js';
import { valueBalancesUsd } from './valuation.js';

function batchFetch(prices: Record<string, number>): FetchLike {
  return async (url: string) => {
    if (url.includes('symbols=')) {
      const symbols = JSON.parse(decodeURIComponent(url.split('symbols=')[1]!)) as string[];
      const known = symbols.filter((s) => prices[s] !== undefined);
      // Binance-Verhalten: unbekanntes Symbol im Batch ⇒ ganzer Batch 400
      if (known.length !== symbols.length) return { ok: false, status: 400, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => known.map((s) => ({ symbol: s, price: String(prices[s]) })) };
    }
    const symbol = url.split('symbol=')[1]!;
    if (prices[symbol] === undefined) return { ok: false, status: 400, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ price: String(prices[symbol]) }) };
  };
}

describe('valueBalancesUsd', () => {
  it('Stablecoins 1:1, Krypto mit echtem Kurs, Summe stimmt', async () => {
    const v = await valueBalancesUsd(
      { USDT: 1000, BTC: 0.5, ETH: 2 },
      batchFetch({ BTCUSDT: 100_000, ETHUSDT: 3000 }),
    );
    expect(v.valuedUsd.USDT).toBe(1000);
    expect(v.valuedUsd.BTC).toBe(50_000);
    expect(v.valuedUsd.ETH).toBe(6000);
    expect(v.totalUsd).toBe(57_000);
    expect(v.unvalued).toEqual([]);
  });

  it('Währung ohne Kurs bleibt ehrlich unbewertet (kein erfundener Preis)', async () => {
    const v = await valueBalancesUsd({ USDT: 100, EXOTIC: 5 }, batchFetch({}));
    expect(v.valuedUsd.USDT).toBe(100);
    expect(v.valuedUsd.EXOTIC).toBeUndefined();
    expect(v.totalUsd).toBe(100);
    expect(v.unvalued).toEqual(['EXOTIC']);
  });

  it('Batch mit unbekanntem Symbol → Einzel-Fallback bewertet den Rest trotzdem', async () => {
    const v = await valueBalancesUsd({ BTC: 1, EXOTIC: 5 }, batchFetch({ BTCUSDT: 100_000 }));
    expect(v.valuedUsd.BTC).toBe(100_000);
    expect(v.unvalued).toEqual(['EXOTIC']);
  });

  it('Null-/Negativ-Bestände werden ignoriert', async () => {
    const v = await valueBalancesUsd({ USDT: 0, BTC: -1 }, batchFetch({}));
    expect(v.totalUsd).toBe(0);
    expect(v.unvalued).toEqual([]);
  });
});
