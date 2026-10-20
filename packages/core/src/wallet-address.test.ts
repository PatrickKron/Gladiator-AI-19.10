import { describe, expect, it } from 'vitest';
import { normalizeWalletAddress, walletAddressKind } from './wallet-address.js';

const EVM = '0x' + 'aB'.repeat(20);
// Gültiger bech32-Zeichensatz (ohne 1, b, i, o), 38 Zeichen nach „dydx1"
const DYDX = 'dydx1' + 'qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9'.slice(0, 38);

describe('walletAddressKind', () => {
  it('dYdX nutzt Cosmos-Adressen (dydx1…), alle anderen EVM (0x…)', () => {
    expect(walletAddressKind('dydx')).toBe('dydx');
    expect(walletAddressKind('hyperliquid')).toBe('evm');
    expect(walletAddressKind('paradex')).toBe('evm');
  });
});

describe('normalizeWalletAddress', () => {
  it('EVM: 0x + 40 Hex, klein geschrieben', () => {
    expect(normalizeWalletAddress('hyperliquid', ` ${EVM} `)).toBe(EVM.toLowerCase());
    expect(normalizeWalletAddress('hyperliquid', '0x123')).toBeNull();
    expect(normalizeWalletAddress('hyperliquid', DYDX)).toBeNull();
  });

  it('dYdX: dydx1 + 38 bech32-Zeichen; Großschreibung wird vereinheitlicht', () => {
    expect(DYDX).toHaveLength(43);
    expect(normalizeWalletAddress('dydx', DYDX)).toBe(DYDX);
    expect(normalizeWalletAddress('dydx', DYDX.toUpperCase())).toBe(DYDX);
    expect(normalizeWalletAddress('dydx', EVM)).toBeNull();
  });

  it('dYdX: Zeichen außerhalb von bech32 (1, b, i, o) und falsche Länge werden abgelehnt', () => {
    expect(normalizeWalletAddress('dydx', DYDX.slice(0, -1) + 'b')).toBeNull();
    expect(normalizeWalletAddress('dydx', DYDX.slice(0, -1) + 'o')).toBeNull();
    expect(normalizeWalletAddress('dydx', DYDX + 'q')).toBeNull();
    expect(normalizeWalletAddress('dydx', 'cosmos1' + DYDX.slice(5))).toBeNull();
  });

  it('gemischte Groß-/Kleinschreibung ist bei bech32 ungültig', () => {
    expect(normalizeWalletAddress('dydx', 'dydx1' + DYDX.slice(5, 10).toUpperCase() + DYDX.slice(10))).toBeNull();
  });
});
