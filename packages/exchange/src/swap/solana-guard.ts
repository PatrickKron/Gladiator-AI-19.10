import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58Decode, base58Encode } from './keys.js';

/**
 * Prüft eine von Jupiter gebaute Swap-Transaktion VOR dem Signieren
 * (Sicherheitsprüfung 2026-10-21): Wir unterschreiben nur, was wir verstehen.
 * Erlaubt sind ausschließlich die Bausteine eines Jupiter-Swaps:
 *   - ComputeBudget: Limit und Preis (Prioritätsgebühr gedeckelt);
 *   - System: NUR Überweisung von uns an UNSER wSOL-Konto (SOL einpacken),
 *     höchstens in Höhe des Kaufbetrags;
 *   - Associated Token Account: Konto anlegen — zahlend und besitzend wir;
 *   - Token/Token-2022: NUR SyncNative und CloseAccount mit Auszahlung an uns
 *     (wSOL auspacken) — nie Transfer, Approve, SetAuthority …;
 *   - Jupiter v6 (der eigentliche Swap).
 * Alles andere — fremde Programme, Überweisungen an andere, Konto-Übergaben —
 * wird verweigert. Konten aus Adress-Lookup-Tabellen sind hier nicht
 * auflösbar; wo es auf das Ziel ankommt, verweigern wir dann (fail closed).
 */

export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EHFLp88EzTEbtKFFuh6';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const WSOL = 'So11111111111111111111111111111111111111112';

/** Höchste erlaubte Prioritätsgebühr (Lamports) — wir verlangen bei Jupiter höchstens 0,001 SOL. */
export const MAX_PRIORITY_FEE_LAMPORTS = 5_000_000n;

export type SolanaInstruction = { program: string; accounts: (string | null)[]; data: Uint8Array };
export type SolanaMessage = { version: 'legacy' | 0; staticKeys: string[]; instructions: SolanaInstruction[]; lookupTables: number };

function shortVec(buf: Uint8Array, offset: number): { value: number; size: number } {
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

/** Vollständige Nachricht (legacy/v0) aus einer serialisierten Transaktion; Lookup-Konten = null. */
export function parseSolanaMessage(tx: Uint8Array): SolanaMessage {
  const sigs = shortVec(tx, 0);
  let p = sigs.size + sigs.value * 64;
  let version: 'legacy' | 0 = 'legacy';
  if (tx[p]! & 0x80) {
    if ((tx[p]! & 0x7f) !== 0) throw new Error('Nicht unterstützte Transaktions-Version.');
    version = 0;
    p++;
  }
  p += 3; // Header
  const nKeys = shortVec(tx, p);
  p += nKeys.size;
  const staticKeys: string[] = [];
  for (let i = 0; i < nKeys.value; i++) staticKeys.push(base58Encode(tx.slice(p + i * 32, p + (i + 1) * 32)));
  p += nKeys.value * 32;
  p += 32; // recent blockhash
  const nIx = shortVec(tx, p);
  p += nIx.size;
  const raw: { programIndex: number; accounts: number[]; data: Uint8Array }[] = [];
  for (let i = 0; i < nIx.value; i++) {
    const programIndex = tx[p]!;
    p++;
    const nAcc = shortVec(tx, p);
    p += nAcc.size;
    const accounts = Array.from(tx.slice(p, p + nAcc.value));
    p += nAcc.value;
    const nData = shortVec(tx, p);
    p += nData.size;
    const data = tx.slice(p, p + nData.value);
    p += nData.value;
    if (p > tx.length) throw new Error('Transaktion abgeschnitten.');
    raw.push({ programIndex, accounts, data });
  }
  let lookupTables = 0;
  if (version === 0) {
    const nTables = shortVec(tx, p);
    lookupTables = nTables.value;
    p += nTables.size;
    for (let i = 0; i < nTables.value; i++) {
      p += 32;
      const w = shortVec(tx, p);
      p += w.size + w.value;
      const r = shortVec(tx, p);
      p += r.size + r.value;
    }
  }
  if (p !== tx.length) throw new Error('Transaktion hat unerwartete Zusatzdaten.');
  const key = (i: number) => (i < staticKeys.length ? staticKeys[i]! : null);
  const instructions = raw.map((ix) => {
    // Programme müssen statisch adressiert sein (Solana-Regel) — sonst verweigern
    const program = key(ix.programIndex);
    if (program === null) throw new Error('Transaktion verweigert: Programm aus Lookup-Tabelle.');
    return { program, accounts: ix.accounts.map(key), data: ix.data };
  });
  return { version, staticKeys, instructions, lookupTables };
}

function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Program Derived Address (wie `findProgramAddressSync`). */
export function findProgramAddress(seeds: Uint8Array[], programId: string): string {
  const pid = base58Decode(programId);
  const marker = new TextEncoder().encode('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), pid, marker];
    const buf = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
    let o = 0;
    for (const x of parts) {
      buf.set(x, o);
      o += x.length;
    }
    const h = sha256(buf);
    if (!isOnCurve(h)) return base58Encode(h);
  }
  throw new Error('Keine Programm-Adresse gefunden.');
}

/** Associated-Token-Account einer Wallet für einen Mint. */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram = TOKEN_PROGRAM): string {
  return findProgramAddress([base58Decode(owner), base58Decode(tokenProgram), base58Decode(mint)], ATA_PROGRAM);
}

const u32 = (d: Uint8Array, o: number) => d[o]! | (d[o + 1]! << 8) | (d[o + 2]! << 16) | (d[o + 3]! * 2 ** 24);
const u64 = (d: Uint8Array, o: number) => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]!);
  return v;
};

/**
 * Wirft, wenn die Transaktion irgendetwas außer einem Jupiter-Swap für `owner`
 * enthält. `maxSolIn`: höchstens so viele Lamports dürfen eingepackt werden
 * (Kaufbetrag; beim Verkauf 0).
 */
export function assertJupiterSwapTx(tx: Uint8Array, owner: string, opts: { maxSolIn: bigint }): void {
  const msg = parseSolanaMessage(tx);
  const wsolAta = associatedTokenAddress(owner, WSOL);
  const deny = (why: string): never => {
    throw new Error(`Transaktion verweigert: ${why}`);
  };
  let cuLimit = 1_400_000n;
  let cuPrice = 0n;
  let wrapped = 0n;
  let hasJupiter = false;
  for (const ix of msg.instructions) {
    const d = ix.data;
    switch (ix.program) {
      case COMPUTE_BUDGET:
        if (d[0] === 2 && d.length === 5) cuLimit = BigInt(u32(d, 1));
        else if (d[0] === 3 && d.length === 9) cuPrice = u64(d, 1);
        else deny('unbekannte ComputeBudget-Anweisung.');
        break;
      case SYSTEM_PROGRAM: {
        // nur Transfer (2) von uns an unser wSOL-Konto
        if (d.length !== 12 || u32(d, 0) !== 2) deny('System-Anweisung außer Einpacken von SOL.');
        if (ix.accounts[0] !== owner || ix.accounts[1] !== wsolAta) deny('SOL-Überweisung an ein fremdes Konto.');
        wrapped += u64(d, 4);
        break;
      }
      case ATA_PROGRAM:
        // create (leer/0) bzw. createIdempotent (1): Zahler und Besitzer sind wir
        if (!(d.length === 0 || ((d[0] === 0 || d[0] === 1) && d.length === 1))) deny('unbekannte ATA-Anweisung.');
        if (ix.accounts[0] !== owner || ix.accounts[2] !== owner) deny('Token-Konto für eine fremde Wallet.');
        break;
      case TOKEN_PROGRAM:
      case TOKEN_2022_PROGRAM:
        if (d[0] === 17 && d.length === 1) break; // SyncNative
        if (d[0] === 9 && d.length === 1) {
          // CloseAccount: Rest geht an uns, Befugnis wir
          if (ix.accounts[1] !== owner || ix.accounts[2] !== owner) deny('Konto-Schließung zugunsten eines fremden Kontos.');
          break;
        }
        deny('Token-Anweisung außer Ein-/Auspacken (z. B. Transfer, Approve, SetAuthority).');
        break;
      case JUPITER_V6:
        hasJupiter = true;
        break;
      default:
        deny(`unbekanntes Programm ${ix.program}.`);
    }
  }
  if (!hasJupiter) deny('kein Jupiter-Swap enthalten.');
  if (wrapped > opts.maxSolIn) deny('es würde mehr SOL eingesetzt als bestätigt.');
  const priorityLamports = (cuLimit * cuPrice) / 1_000_000n;
  if (priorityLamports > MAX_PRIORITY_FEE_LAMPORTS) deny('Prioritätsgebühr über der Obergrenze.');
}
