import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { addressFromPrivateKey } from '../hyperliquid-agent.js';

/**
 * Schlüssel eigener Trading-Wallets (Vision-Punkt 5c, Freigabe Patrick 2026-10-20:
 * nur beim Selbsthosten, wenn der Betreiber `WALLET_KEYS_ENABLED=1` setzt).
 * Empfohlen ist eine NEU erzeugte, eigene Trading-Wallet — nie die Haupt-Wallet.
 * Formate wie in gängigen Wallets, damit der Nutzer sie dort jederzeit selbst
 * öffnen (und Geld abziehen) kann: Solana = Base58 des 64-Byte-Secret-Keys
 * (Phantom/Solflare), EVM = 0x + 64 Hex (MetaMask).
 */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error('Ungültiges Base58-Zeichen.');
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export type WalletKind = 'solana' | 'evm';
export type WalletKey = { address: string; secret: string };

function solanaFromSeed(seed: Uint8Array): WalletKey {
  const pub = ed25519.getPublicKey(seed);
  const full = new Uint8Array(64);
  full.set(seed, 0);
  full.set(pub, 32);
  return { address: base58Encode(pub), secret: base58Encode(full) };
}

export function generateWalletKey(kind: WalletKind): WalletKey {
  if (kind === 'solana') return solanaFromSeed(randomBytes(32));
  const secret = `0x${randomBytes(32).toString('hex')}`;
  return { address: addressFromPrivateKey(secret), secret };
}

/**
 * Import: Solana als Base58-Secret (64 Byte) oder JSON-Array (solana-keygen),
 * EVM als 0x+64 Hex. Der öffentliche Teil eines Solana-Keys wird geprüft —
 * ein manipulierter/kaputter Schlüssel fällt hier auf, nicht erst bei der Order.
 */
export function importWalletKey(kind: WalletKind, input: string): WalletKey {
  const raw = input.trim();
  if (kind === 'evm') {
    const hex = raw.startsWith('0x') ? raw : `0x${raw}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error('EVM-Schlüssel: 0x + 64 Hex-Zeichen erwartet.');
    return { address: addressFromPrivateKey(hex), secret: hex.toLowerCase() };
  }
  let bytes: Uint8Array;
  if (raw.startsWith('[')) {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr) || !arr.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) throw new Error('Solana-Schlüssel: ungültiges JSON-Array.');
    bytes = Uint8Array.from(arr as number[]);
  } else {
    bytes = base58Decode(raw);
  }
  if (bytes.length !== 64) throw new Error('Solana-Schlüssel: 64 Byte erwartet (Base58 oder JSON-Array).');
  const key = solanaFromSeed(bytes.slice(0, 32));
  if (base58Encode(bytes.slice(32)) !== key.address) throw new Error('Solana-Schlüssel: öffentlicher Teil passt nicht zum geheimen Teil.');
  return key;
}

/** Solana-Secret (Base58, 64 Byte) → 32-Byte-Seed zum Signieren. */
export function solanaSeed(secret: string): Uint8Array {
  const bytes = base58Decode(secret);
  if (bytes.length !== 64) throw new Error('Solana-Schlüssel beschädigt.');
  return bytes.slice(0, 32);
}
