import { afterEach, describe, expect, it } from 'vitest';
import { DERIVATIVE_SYMBOLS, filterLinearPerps, listBinancePerps, perpSymbolFor, resetPerpCache, selectDerivativePerps } from './derivatives.js';

describe('perpSymbolFor', () => {
  it('Spot-Paar → gleichnamiger USDⓈ-M-Perp (USDT/USDC-margined)', () => {
    expect(perpSymbolFor('BTC/USDT')).toBe('BTC/USDT:USDT');
    expect(perpSymbolFor('eth/usdc')).toBe('ETH/USDC:USDC');
    expect(perpSymbolFor('SOL/USDT:USDT')).toBe('SOL/USDT:USDT');
  });
  it('kein USDⓈ-M-Kandidat → null', () => {
    expect(perpSymbolFor('BTC/EUR')).toBeNull();
    expect(perpSymbolFor('AAPL')).toBeNull();
    expect(perpSymbolFor('ETH/BTC')).toBeNull();
    expect(perpSymbolFor('')).toBeNull();
  });
});

describe('filterLinearPerps', () => {
  it('nur aktive lineare Perpetuals mit USDT/USDC-Settle — keine Quartals-Futures', () => {
    const set = filterLinearPerps([
      { symbol: 'BTC/USDT:USDT', swap: true, linear: true, settle: 'USDT', active: true },
      { symbol: 'ETH/USDC:USDC', swap: true, linear: true, settle: 'USDC' },
      { symbol: 'BTC/USDT:USDT-261225', swap: false, future: true, linear: true, settle: 'USDT' },
      { symbol: 'OLD/USDT:USDT', swap: true, linear: true, settle: 'USDT', active: false },
      { symbol: 'BTC/USD:BTC', swap: true, linear: false, inverse: true, settle: 'BTC' },
      undefined,
    ]);
    expect([...set].sort()).toEqual(['BTC/USDT:USDT', 'ETH/USDC:USDC']);
  });
});

describe('selectDerivativePerps (Basis + Universum ∩ echte Perps)', () => {
  const listed = new Set(['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'DOGE/USDT:USDT', 'BTC/USDC:USDC']);
  it('Basis zuerst, dann Kandidaten, die es als Perp gibt; dedupliziert', () => {
    expect(selectDerivativePerps(['DOGE/USDT', 'PEPE/USDT', 'BTC/USDT', 'AAPL', 'BTC/USDC'], listed)).toEqual([
      'BTC/USDT:USDT',
      'ETH/USDT:USDT',
      'SOL/USDT:USDT',
      'DOGE/USDT:USDT',
      'BTC/USDC:USDC',
    ]);
  });
  it('Perp-Liste unbekannt (Börse nicht erreichbar) → nur die festen Basis-Perps', () => {
    expect(selectDerivativePerps(['DOGE/USDT'], null)).toEqual(DERIVATIVE_SYMBOLS);
  });
  it('Cap gegen ausufernde Abrufe', () => {
    const many = Array.from({ length: 80 }, (_, i) => `C${i}/USDT`);
    const all = new Set([...DERIVATIVE_SYMBOLS, ...many.map((s) => `${s}:USDT`)]);
    expect(selectDerivativePerps(many, all, 10)).toHaveLength(10);
  });
});

describe('listBinancePerps (gemerkt)', () => {
  afterEach(() => resetPerpCache());
  it('lädt einmal und merkt sich die Liste', async () => {
    let calls = 0;
    const fetchMarkets = async () => {
      calls++;
      return [{ symbol: 'BTC/USDT:USDT', swap: true, linear: true, settle: 'USDT' }];
    };
    expect([...(await listBinancePerps(fetchMarkets))]).toEqual(['BTC/USDT:USDT']);
    await listBinancePerps(fetchMarkets);
    expect(calls).toBe(1);
  });
  it('leere Antwort ist ein Fehler, nie eine leere Wahrheit', async () => {
    await expect(listBinancePerps(async () => [])).rejects.toThrow(/keine Perpetual/);
  });
  it('Fehler wird kurz gemerkt (kein Timeout je Seitenaufruf), danach neuer Versuch', async () => {
    let calls = 0;
    const down = async () => {
      calls++;
      throw new Error('451 restricted location');
    };
    await expect(listBinancePerps(down, 1_000)).rejects.toThrow(/451/);
    await expect(listBinancePerps(down, 1_500)).rejects.toThrow(/451/);
    expect(calls).toBe(1);
    await expect(listBinancePerps(down, 1_000 + 5 * 60_000 + 1)).rejects.toThrow(/451/);
    expect(calls).toBe(2);
  });
});
