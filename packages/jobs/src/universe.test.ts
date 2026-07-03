import { describe, expect, it } from 'vitest';
import { normalizeTradingPair, buildUniverse } from './universe.js';
import { alertTriggered } from './alerts.js';

/** Scan-Universum aus Favoriten (Patrick-Lücke 1/5) + Alert-Trigger-Logik (Lücke 7) — pur, TDD. */

describe('normalizeTradingPair', () => {
  it.each([
    ['BTCUSDT', 'BTC/USDT'],
    ['btc/usdt', 'BTC/USDT'],
    ['SOLUSDC', 'SOL/USDC'],
    ['AAPL', null], // kein Krypto-Paar → ehrlich null
    ['', null],
  ])('%s → %s', (input, expected) => {
    expect(normalizeTradingPair(input)).toBe(expected);
  });
});

describe('buildUniverse', () => {
  it('Basis-Symbole immer enthalten; Favoriten-Paare ergänzt, dedupliziert, Cap 12', () => {
    const u = buildUniverse(['BTCUSDT', 'DOGEUSDT', 'DOGEUSDT', 'AAPL', 'LINKUSDT']);
    expect(u.slice(0, 3)).toEqual(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
    expect(u).toContain('DOGE/USDT');
    expect(u).toContain('LINK/USDT');
    expect(new Set(u).size).toBe(u.length); // dedupe
    expect(u.length).toBeLessThanOrEqual(12);
  });

  it('nicht-Krypto-Favoriten (Aktien) werden ehrlich ignoriert (kein Binance-Feed)', () => {
    const u = buildUniverse(['AAPL', 'MSFT']);
    expect(u).toEqual(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
  });
});

describe('alertTriggered', () => {
  it('above: löst bei Preis ≥ Ziel aus', () => {
    expect(alertTriggered('above', 100, 100)).toBe(true);
    expect(alertTriggered('above', 100, 101.5)).toBe(true);
    expect(alertTriggered('above', 100, 99.99)).toBe(false);
  });
  it('below: löst bei Preis ≤ Ziel aus', () => {
    expect(alertTriggered('below', 100, 100)).toBe(true);
    expect(alertTriggered('below', 100, 98)).toBe(true);
    expect(alertTriggered('below', 100, 100.01)).toBe(false);
  });
});
