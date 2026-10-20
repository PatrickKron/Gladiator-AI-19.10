/**
 * Wallet-Schlüssel + Solana-Signatur (Vision-Punkt 5c): Base58, Erzeugen,
 * Import (Phantom-Base58, solana-keygen-JSON, MetaMask-Hex), Signieren einer
 * v0-Transaktion nur als alleiniger Gebührenzahler.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { base58Decode, base58Encode, generateWalletKey, importWalletKey } from './keys.js';
import { parseSolanaTx, signSolanaTx } from './solana-tx.js';

describe('Base58', () => {
  it('bekannte Werte (führende Nullen = „1“)', () => {
    expect(base58Encode(Uint8Array.from([0, 0, 1]))).toBe('112');
    expect(base58Encode(new TextEncoder().encode('hello world'))).toBe('StV1DL6CwTryKyV');
    expect(new TextDecoder().decode(base58Decode('StV1DL6CwTryKyV'))).toBe('hello world');
    // System-Programm von Solana = 32 Null-Bytes
    expect(base58Encode(new Uint8Array(32))).toBe('11111111111111111111111111111111');
    expect(() => base58Decode('0OIl')).toThrow(/Base58/);
  });
});

describe('Wallet-Schlüssel', () => {
  it('Solana: erzeugt, als Base58 und als JSON-Array wieder importierbar', () => {
    const k = generateWalletKey('solana');
    expect(k.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(importWalletKey('solana', k.secret)).toEqual(k);
    expect(importWalletKey('solana', JSON.stringify([...base58Decode(k.secret)]))).toEqual(k);
  });

  it('Solana: manipulierter öffentlicher Teil wird erkannt', () => {
    const a = base58Decode(generateWalletKey('solana').secret);
    const b = base58Decode(generateWalletKey('solana').secret);
    const mixed = new Uint8Array(64);
    mixed.set(a.slice(0, 32), 0);
    mixed.set(b.slice(32), 32);
    expect(() => importWalletKey('solana', base58Encode(mixed))).toThrow(/passt nicht/);
  });

  it('EVM: erzeugt + Import mit/ohne 0x, Testvektor', () => {
    const k = generateWalletKey('evm');
    expect(k.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(importWalletKey('evm', k.secret.slice(2))).toEqual(k);
    expect(importWalletKey('evm', '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318').address).toBe(
      '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23',
    );
    expect(() => importWalletKey('evm', '0x1234')).toThrow(/64 Hex/);
  });
});

/** Baut eine minimale v0-Transaktion: n Unterzeichner, leere Signaturen, Dummy-Rest. */
function buildTx(signers: Uint8Array[], extraKeys = 2): Uint8Array {
  const keys = [...signers, ...Array.from({ length: extraKeys }, (_, i) => new Uint8Array(32).fill(i + 7))];
  const message = [0x80, signers.length, 0, 1, keys.length, ...keys.flatMap((k) => [...k]), ...new Uint8Array(32).fill(9), 0, 0];
  return Uint8Array.from([signers.length, ...new Uint8Array(64 * signers.length), ...message]);
}

describe('Solana-Transaktion signieren', () => {
  const k = generateWalletKey('solana');
  const pub = base58Decode(k.address);

  it('parst v0 und signiert die Nachricht korrekt (prüfbar mit dem öffentlichen Schlüssel)', () => {
    const tx = buildTx([pub]);
    const parsed = parseSolanaTx(tx);
    expect(parsed).toMatchObject({ version: 0, requiredSignatures: 1, signers: [k.address], messageOffset: 65 });
    const signed = signSolanaTx(Buffer.from(tx).toString('base64'), k.secret, k.address);
    const bytes = Buffer.from(signed.tx, 'base64');
    const sig = bytes.subarray(1, 65);
    expect(ed25519.verify(sig, bytes.subarray(65), pub)).toBe(true);
    expect(signed.signature).toBe(base58Encode(sig));
  });

  it('verweigert, wenn wir nicht Gebührenzahler sind oder weitere Unterzeichner nötig sind', () => {
    const other = base58Decode(generateWalletKey('solana').address);
    expect(() => signSolanaTx(Buffer.from(buildTx([other])).toString('base64'), k.secret, k.address)).toThrow(/Gebührenzahler/);
    expect(() => signSolanaTx(Buffer.from(buildTx([pub, other])).toString('base64'), k.secret, k.address)).toThrow(/weitere Unterzeichner/);
  });

  it('verweigert einen Schlüssel, der nicht zur Adresse passt', () => {
    const tx = Buffer.from(buildTx([pub])).toString('base64');
    expect(() => signSolanaTx(tx, generateWalletKey('solana').secret, k.address)).toThrow(/passt nicht/);
  });
});
