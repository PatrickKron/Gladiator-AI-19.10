/**
 * Token-Chart: GeckoTerminal-Kerzen parsen; „echte Daten“ holt die Kerzen des
 * liquidesten SOL/USDC-Pools (Pool aus DexScreener) live (in der CI).
 */
import { describe, expect, it } from 'vitest';
import { SOL_MINT } from './chains.js';
import { fetchTokenCandles, parseOhlcvList } from './token-candles.js';
import { fetchTokenInfo } from './token-info.js';

describe('parseOhlcvList', () => {
  it('neueste zuerst → aufsteigend, kaputte Zeilen und Doppelte raus', () => {
    const c = parseOhlcvList([
      [300, 3, 4, 2, 3.5, 10],
      [200, 2, 3, 1, 2.5, 5],
      [200, 2, 3, 1, 2.6, 5],
      [100, 'x', 2, 1, 1.5, 1],
      [150, 0, 2, 1, 1.5, 1],
      [160, 2, 1, 3, 1.5, 1],
      'kaputt',
    ]);
    expect(c.map((k) => k.time)).toEqual([200, 300]);
    expect(c[0]).toEqual({ time: 200, open: 2, high: 3, low: 1, close: 2.6, volume: 5 });
  });

  it('keine Liste → leer (nie aufgefüllt)', () => {
    expect(parseOhlcvList(undefined)).toEqual([]);
    expect(parseOhlcvList({})).toEqual([]);
  });

  it('unbekannter Pool (404) → leer, andere Fehler werfen', async () => {
    expect(await fetchTokenCandles('base', '0x1', '1h', (async () => new Response('', { status: 404 })) as typeof fetch)).toEqual([]);
    await expect(fetchTokenCandles('base', '0x1', '1h', (async () => new Response('', { status: 429 })) as typeof fetch)).rejects.toThrow(/429/);
  });
});

/**
 * Echte Daten: ein einzelner Zeitüberlauf des Anbieters (10 s im Produktivcode) ist kein
 * Befund über unseren Code — bis zu drei frische Versuche, jeder andere Fehler wirft sofort.
 */
async function retryOnTimeout<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!(e instanceof Error) || !/TimeoutError|AbortError/.test(e.name)) throw e;
    }
  }
  throw last;
}

describe('echte Daten (DexScreener-Pool → GeckoTerminal)', () => {
  it('SOL: liquidester Pool liefert echte, aufsteigende Stundenkerzen', async () => {
    const info = await retryOnTimeout(() => fetchTokenInfo('solana', SOL_MINT));
    expect(info.pairAddress).toBeTruthy();
    const candles = await retryOnTimeout(() => fetchTokenCandles('solana', info.pairAddress!, '1h'));
    expect(candles.length).toBeGreaterThan(24);
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.time).toBeGreaterThan(candles[i - 1]!.time);
    expect(candles.at(-1)!.close).toBeGreaterThan(1);
  }, 75_000);
});
