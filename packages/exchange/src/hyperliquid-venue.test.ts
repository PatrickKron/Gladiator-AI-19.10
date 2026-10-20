import { describe, expect, it } from 'vitest';
import { HyperliquidTestnetVenue } from './hyperliquid-venue.js';

describe('Hyperliquid-Testnet-Venue (DEX, Agent-Wallet)', () => {
  it('ohne Agent-Wallet: ehrlich „nicht verbunden", keine Fantasie-Verbindung', async () => {
    const v = new HyperliquidTestnetVenue();
    expect(v.configured).toBe(false);
    const res = await v.validate();
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/nicht verbunden/);
    expect(res.detail).toMatch(/Agent-Wallet/);
  });

  it('Aufrufe ohne Konfiguration werfen sofort (kein stiller Fallback)', async () => {
    const v = new HyperliquidTestnetVenue();
    await expect(v.markPrice('BTC/USDT')).rejects.toThrow(/nicht konfiguriert/);
    await expect(
      v.placeOrder({ clientOrderId: 'x', symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 1 }),
    ).rejects.toThrow(/nicht konfiguriert/);
  });

  it('Symbol-Mapping: Binance-Notation → Hyperliquid-Perp (USDC-quoted)', () => {
    expect(HyperliquidTestnetVenue.mapSymbol('BTC/USDT')).toBe('BTC/USDC:USDC');
    expect(HyperliquidTestnetVenue.mapSymbol('SOL/USDT')).toBe('SOL/USDC:USDC');
  });

  it('Haupt-Wallet-Key wird verweigert — validate und Order', async () => {
    const key = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
    const main = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23'; // Adresse genau dieses Keys
    const v = new HyperliquidTestnetVenue(main, key);
    const res = await v.validate();
    expect(res).toMatchObject({ ok: false });
    expect(res.detail).toMatch(/HAUPT-Wallet/);
    await expect(v.placeOrder({ clientOrderId: 'x', symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 1 })).rejects.toThrow(
      /verweigert/,
    );
  });

  it('Order nur nach bestandener Agent-Prüfung (keine Order bei „keine Agent-Wallet")', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ role: 'missing' }))) as typeof fetch;
    const v = new HyperliquidTestnetVenue('0x0000000000000000000000000000000000000001', '0x' + '11'.repeat(32), fetchFn);
    await expect(v.placeOrder({ clientOrderId: 'x', symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 1 })).rejects.toThrow(
      /keine freigegebene Agent-Wallet/,
    );
  });

  it('echtes Testnet: ein nicht autorisierter Key wird nie als verbunden gemeldet', async () => {
    const v = new HyperliquidTestnetVenue('0x0000000000000000000000000000000000000001', '0x' + '11'.repeat(32));
    expect(v.configured).toBe(true);
    const res = await v.validate();
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/keine freigegebene Agent-Wallet|nicht erreichbar/);
  }, 30_000);
});
