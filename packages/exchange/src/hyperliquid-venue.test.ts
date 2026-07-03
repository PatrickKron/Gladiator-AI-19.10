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

  it('validate ist ehrlich über seine Grenze: Erreichbarkeit ja, Key-Beweis erst bei Order', async () => {
    // Hyperliquids Balance-Abfrage ist adressbasiert ÖFFENTLICH — validate darf
    // deshalb keine Signierfähigkeit behaupten, nur Erreichbarkeit + Vorbehalt.
    const v = new HyperliquidTestnetVenue('0x0000000000000000000000000000000000000001', '0x' + '11'.repeat(32));
    expect(v.configured).toBe(true);
    const res = await v.validate();
    if (res.ok) {
      expect(res.detail).toMatch(/erste[nr]? Order verifiziert/);
    } else {
      expect(res.detail).toMatch(/fehlgeschlagen/);
    }
  }, 30_000);
});
