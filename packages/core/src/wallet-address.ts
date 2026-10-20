/**
 * Öffentliche Wallet-Adressen für den NUR-LESENDEN Börsen-Anschluss — eine
 * Regel für Server und Formular. Geprüft wird nur das Format; ob die Adresse
 * dort ein Konto hat, beweist erst der echte Abruf (fetchBalance).
 *
 * - EVM-Börsen (Hyperliquid, Paradex, Derive, Aftermath): `0x` + 40 Hex.
 * - dYdX v4 (Cosmos): `dydx1` + 38 bech32-Zeichen (ohne 1, b, i, o); bech32
 *   erlaubt nur durchgehend klein oder durchgehend groß.
 */

export type WalletAddressKind = 'evm' | 'dydx';

export function walletAddressKind(exchangeId: string): WalletAddressKind {
  return exchangeId.trim().toLowerCase() === 'dydx' ? 'dydx' : 'evm';
}

const EVM_RE = /^0x[0-9a-f]{40}$/;
const DYDX_RE = /^dydx1[02-9ac-hj-np-z]{38}$/;

/** Gültig → normalisierte (kleingeschriebene) Adresse, sonst null. */
export function normalizeWalletAddress(exchangeId: string, raw: string): string | null {
  const trimmed = raw.trim();
  if (walletAddressKind(exchangeId) === 'dydx') {
    if (trimmed !== trimmed.toLowerCase() && trimmed !== trimmed.toUpperCase()) return null;
    const lower = trimmed.toLowerCase();
    return DYDX_RE.test(lower) ? lower : null;
  }
  const lower = trimmed.toLowerCase();
  return EVM_RE.test(lower) ? lower : null;
}
