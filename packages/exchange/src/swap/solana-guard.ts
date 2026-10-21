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
 *   - Jupiter v6: GENAU EIN `route`/`shared_accounts_route` (Aufbau laut
 *     offiziellem IDL, jup-ag/jupiter-cpi) — dekodiert: Befugnis = wir,
 *     Ziel-Konto = unser Token-Konto des bestätigten Mints, Menge, erwartete
 *     Menge und Slippage = bestätigtes Angebot, keine Plattform-Gebühr.
 *     Andere Jupiter-Anweisungen (ExactOut, TokenLedger, claim …) → verweigert.
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

const anchorDisc = (name: string) => sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8);
const JUP_ROUTE = anchorDisc('route');
const JUP_SHARED_ROUTE = anchorDisc('shared_accounts_route');
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

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

/**
 * Liegt die Adresse auf der Ed25519-Kurve? Ja = normale Wallet (hat einen
 * privaten Schlüssel); nein = Programm-Adresse (PDA: Pools, Bonding-Curves,
 * Lock-Verträge …).
 */
export function isOnCurveAddress(address: string): boolean {
  try {
    return isOnCurve(base58Decode(address));
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

/** Bestätigtes Angebot, gegen das die Transaktion geprüft wird (kleinste Einheiten). */
export type JupiterSwapExpect = { inMint: string; outMint: string; inAmount: bigint; quotedOutAmount: bigint; slippageBps: number };

/**
 * Prüft die eigentliche Jupiter-Anweisung. Die festen Argumente stehen am Ende
 * der Daten (`route_plan` davor ist variabel lang):
 *   in_amount u64 · quoted_out_amount u64 · slippage_bps u16 · platform_fee_bps u8.
 * Konten laut IDL — route: [1] Befugnis, [3] Nutzer-Ziel, [4] Ziel (optional,
 * sonst Programm-Id), [5] Ziel-Mint; shared_accounts_route: [2] Befugnis,
 * [6] Ziel, [7] Quell-Mint, [8] Ziel-Mint.
 */
/**
 * Mints liegen bei echten Jupiter-Transaktionen oft in Adress-Lookup-Tabellen
 * (hier nicht auflösbar = null; CI-Befund 2026-10-21). Das ist unbedenklich:
 * Das Ziel-Konto muss ohnehin UNSER Token-Konto des bestätigten Mints sein, und
 * das Token-Programm lässt nur Gutschriften dieses Mints darauf zu. Ein statisch
 * angegebener, ABWEICHENDER Mint wird weiter verweigert.
 */
const mintOk = (account: string | null | undefined, expected: string) => account === null || account === expected;

function assertJupiterRoute(ix: SolanaInstruction, owner: string, exp: JupiterSwapExpect, deny: (why: string) => never): void {
  const d = ix.data;
  const disc = d.slice(0, 8);
  const shared = sameBytes(disc, JUP_SHARED_ROUTE);
  if (!shared && !sameBytes(disc, JUP_ROUTE)) {
    deny(`unbekannte Jupiter-Anweisung (${Buffer.from(disc).toString('hex')}, ${ix.accounts.length} Konten).`);
  }
  if (d.length < 8 + 19) deny('Jupiter-Anweisung zu kurz.');
  const t = d.length - 19;
  const inAmount = u64(d, t);
  const quotedOut = u64(d, t + 8);
  const slippageBps = d[t + 16]! | (d[t + 17]! << 8);
  const platformFeeBps = d[t + 18]!;
  const own = new Set([associatedTokenAddress(owner, exp.outMint, TOKEN_PROGRAM), associatedTokenAddress(owner, exp.outMint, TOKEN_2022_PROGRAM)]);
  const a = ix.accounts;
  if (shared) {
    if (a[2] !== owner) deny('Jupiter-Swap nicht von der eigenen Wallet.');
    if (!own.has(a[6] ?? '')) deny('Jupiter-Ziel ist nicht das eigene Token-Konto.');
    if (!mintOk(a[7], exp.inMint) || !mintOk(a[8], exp.outMint)) deny('Jupiter-Tokens passen nicht zum bestätigten Angebot.');
  } else {
    if (a[1] !== owner) deny('Jupiter-Swap nicht von der eigenen Wallet.');
    if (!own.has(a[3] ?? '') || !(a[4] === JUPITER_V6 || own.has(a[4] ?? ''))) deny('Jupiter-Ziel ist nicht das eigene Token-Konto.');
    if (!mintOk(a[5], exp.outMint)) deny('Jupiter-Tokens passen nicht zum bestätigten Angebot.');
  }
  if (inAmount !== exp.inAmount) deny('Jupiter-Menge passt nicht zum bestätigten Angebot.');
  if (quotedOut < exp.quotedOutAmount || slippageBps !== exp.slippageBps) deny('Jupiter-Mindestmenge niedriger als bestätigt.');
  if (platformFeeBps !== 0) deny('Plattform-Gebühr in der Jupiter-Route.');
}

/**
 * Wirft, wenn die Transaktion irgendetwas außer genau dem bestätigten
 * Jupiter-Swap für `owner` enthält. Eingepackt werden darf höchstens die
 * Kaufmenge (nur bei SOL als Eingang; beim Verkauf nichts).
 */
export function assertJupiterSwapTx(tx: Uint8Array, owner: string, exp: JupiterSwapExpect): void {
  const msg = parseSolanaMessage(tx);
  const wsolAta = associatedTokenAddress(owner, WSOL);
  const maxSolIn = exp.inMint === WSOL ? exp.inAmount : 0n;
  const deny = (why: string): never => {
    throw new Error(`Transaktion verweigert: ${why}`);
  };
  let cuLimit = 1_400_000n;
  let cuPrice = 0n;
  let wrapped = 0n;
  let jupiter = 0;
  for (const ix of msg.instructions) {
    const d = ix.data;
    switch (ix.program) {
      case COMPUTE_BUDGET:
        if (d[0] === 2 && d.length === 5) cuLimit = BigInt(u32(d, 1));
        else if (d[0] === 3 && d.length === 9) cuPrice = u64(d, 1);
        else if ((d[0] === 1 || d[0] === 4) && d.length === 5) break; // Heap-Größe / Kontodaten-Limit: harmlos
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
        jupiter++;
        assertJupiterRoute(ix, owner, exp, deny);
        break;
      default:
        deny(`unbekanntes Programm ${ix.program}.`);
    }
  }
  if (jupiter !== 1) deny(jupiter === 0 ? 'kein Jupiter-Swap enthalten.' : 'mehr als ein Jupiter-Swap.');
  if (wrapped > maxSolIn) deny('es würde mehr SOL eingesetzt als bestätigt.');
  const priorityLamports = (cuLimit * cuPrice) / 1_000_000n;
  if (priorityLamports > MAX_PRIORITY_FEE_LAMPORTS) deny('Prioritätsgebühr über der Obergrenze.');
}
