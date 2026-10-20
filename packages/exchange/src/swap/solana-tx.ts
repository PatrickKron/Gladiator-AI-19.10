import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Encode, solanaSeed } from './keys.js';

/**
 * Signieren einer Solana-Transaktion (legacy oder v0), wie Jupiter sie unter
 * `/swap` fertig gebaut liefert. Aufbau: shortvec(Signaturanzahl) ‖ Signaturen
 * (je 64 Byte) ‖ Nachricht. Signiert wird die Nachricht; unsere Signatur gehört
 * an die Stelle unseres Schlüssels unter den signierenden Konten. Wir signieren
 * NUR, wenn unsere Wallet der Gebührenzahler (erstes Konto) und der einzige
 * erforderliche Unterzeichner ist — so kann keine fremd gebaute Transaktion mit
 * unserer Unterschrift „mitlaufen“.
 */

function readShortVec(buf: Uint8Array, offset: number): { value: number; size: number } {
  let value = 0;
  let size = 0;
  for (;;) {
    const b = buf[offset + size];
    if (b === undefined) throw new Error('Transaktion abgeschnitten.');
    value |= (b & 0x7f) << (7 * size);
    size++;
    if ((b & 0x80) === 0) break;
    if (size > 3) throw new Error('Ungültige Längenangabe.');
  }
  return { value, size };
}

export type ParsedSolanaTx = {
  signatureCount: number;
  messageOffset: number;
  version: 'legacy' | 0;
  requiredSignatures: number;
  signers: string[];
};

export function parseSolanaTx(tx: Uint8Array): ParsedSolanaTx {
  const sigs = readShortVec(tx, 0);
  const messageOffset = sigs.size + sigs.value * 64;
  let p = messageOffset;
  let version: 'legacy' | 0 = 'legacy';
  if (tx[p]! & 0x80) {
    const v = tx[p]! & 0x7f;
    if (v !== 0) throw new Error(`Nicht unterstützte Transaktions-Version ${v}.`);
    version = 0;
    p++;
  }
  const requiredSignatures = tx[p]!;
  p += 3; // Header: Unterzeichner, davon nur-lesend, nur-lesend ohne Unterschrift
  const keys = readShortVec(tx, p);
  p += keys.size;
  if (requiredSignatures > keys.value) throw new Error('Ungültiger Transaktions-Kopf.');
  const signers: string[] = [];
  for (let i = 0; i < requiredSignatures; i++) signers.push(base58Encode(tx.slice(p + i * 32, p + (i + 1) * 32)));
  if (sigs.value !== requiredSignatures) throw new Error('Signaturanzahl passt nicht zum Transaktions-Kopf.');
  return { signatureCount: sigs.value, messageOffset, version, requiredSignatures, signers };
}

/** Signiert eine base64-Transaktion mit dem Wallet-Schlüssel; liefert base64 + Signatur (Base58 = Transaktions-Id). */
export function signSolanaTx(base64: string, secret: string, expectedSigner: string): { tx: string; signature: string } {
  const tx = Uint8Array.from(Buffer.from(base64, 'base64'));
  const parsed = parseSolanaTx(tx);
  if (parsed.signers[0] !== expectedSigner) throw new Error('Transaktion verweigert: eigene Wallet ist nicht der Gebührenzahler.');
  if (parsed.requiredSignatures !== 1) throw new Error('Transaktion verweigert: verlangt weitere Unterzeichner.');
  const seed = solanaSeed(secret);
  if (base58Encode(ed25519.getPublicKey(seed)) !== expectedSigner) throw new Error('Schlüssel passt nicht zur Wallet-Adresse.');
  const signature = ed25519.sign(tx.slice(parsed.messageOffset), seed);
  const out = Uint8Array.from(tx);
  out.set(signature, 1); // eine Signatur: shortvec(1) belegt 1 Byte
  return { tx: Buffer.from(out).toString('base64'), signature: base58Encode(signature) };
}
