/**
 * Token entdecken: GeckoTerminal-Antwort sauber übersetzen (fehlende Werte
 * bleiben null, nativer Token und Doppelte raus) + echte Daten (CI).
 */
import { describe, expect, it } from 'vitest';
import { SOL_MINT } from './chains.js';
import { fetchTokenDiscovery, parseDiscovery } from './discovery.js';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

const pool = (addr: string, baseId: string, extra: Record<string, unknown> = {}) => ({
  id: `solana_${addr}`,
  attributes: {
    address: addr,
    base_token_price_usd: '0.0000213',
    reserve_in_usd: '1250000.5',
    fdv_usd: '1900000000',
    market_cap_usd: null,
    pool_created_at: '2026-10-20T12:00:00Z',
    price_change_percentage: { h1: '-1.5', h24: '12.25' },
    volume_usd: { h24: '845000' },
    transactions: { h24: { buys: 1200, sells: 900 } },
    ...extra,
  },
  relationships: { base_token: { data: { id: baseId } }, dex: { data: { id: 'raydium' } } },
});

describe('parseDiscovery', () => {
  it('übersetzt Pool + Token; Marktkapitalisierung fällt auf FDV zurück', () => {
    const r = parseDiscovery('solana', {
      data: [pool('PoolA', `solana_${BONK}`)],
      included: [{ id: `solana_${BONK}`, type: 'token', attributes: { address: BONK, name: 'Bonk', symbol: 'Bonk', image_url: 'missing.png' } }],
    });
    expect(r).toEqual([
      {
        address: BONK,
        symbol: 'Bonk',
        name: 'Bonk',
        imageUrl: null,
        pool: 'PoolA',
        dex: 'raydium',
        priceUsd: 0.0000213,
        change1hPct: -1.5,
        change24hPct: 12.25,
        volume24hUsd: 845000,
        liquidityUsd: 1250000.5,
        marketCapUsd: 1_900_000_000,
        buys24h: 1200,
        sells24h: 900,
        poolCreatedAt: '2026-10-20T12:00:00Z',
      },
    ]);
  });

  it('SOL als Basis raus, jeder Token einmal, fehlende Werte null statt 0', () => {
    const r = parseDiscovery('solana', {
      data: [
        pool('SolUsdc', `solana_${SOL_MINT}`),
        pool('PoolA', `solana_${BONK}`),
        pool('PoolB', `solana_${BONK}`),
        pool('PoolC', 'solana_Neu1111111111111111111111111111111111111', { base_token_price_usd: null, volume_usd: {}, transactions: {} }),
      ],
      included: [],
    });
    expect(r.map((x) => x.pool)).toEqual(['PoolA', 'PoolC']);
    expect(r[1]).toMatchObject({ address: 'Neu1111111111111111111111111111111111111', symbol: '?', priceUsd: null, volume24hUsd: null, buys24h: null });
  });

  it('kaputte Antwort → leer', () => {
    expect(parseDiscovery('base', null)).toEqual([]);
    expect(parseDiscovery('base', { data: [{}] })).toEqual([]);
  });
});

describe('echte Daten (GeckoTerminal)', () => {
  it.each(['trending', 'new'] as const)('Solana %s: echte Tokens mit Adresse und Pool', async (kind) => {
    const r = await fetchTokenDiscovery('solana', kind);
    expect(r.length).toBeGreaterThan(0);
    for (const t of r) {
      expect(t.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(t.address).not.toBe(SOL_MINT);
      expect(t.pool.length).toBeGreaterThan(30);
    }
  }, 30_000);
});
