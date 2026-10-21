import { base58Decode } from '../keys.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ATA_PROGRAM, associatedTokenAddress, COMPUTE_BUDGET, JUPITER_V6, SYSTEM_PROGRAM, TOKEN_PROGRAM, type JupiterSwapExpect } from '../solana-guard.js';

/**
 * NUR für Tests: baut serialisierte Solana-v0-Transaktionen (unsigniert, eine
 * leere Signatur), um den Transaktions-Wächter und das Signieren zu prüfen.
 */

export type TestIx = { program: string; accounts: string[]; data: number[] };

const shortVec = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  for (;;) {
    let b = v & 0x7f;
    v >>= 7;
    if (v) b |= 0x80;
    out.push(b);
    if (!v) return out;
  }
};

export function buildV0Tx(feePayer: string, ixs: TestIx[]): string {
  const keys: string[] = [feePayer];
  const add = (k: string) => {
    if (!keys.includes(k)) keys.push(k);
    return keys.indexOf(k);
  };
  for (const ix of ixs) ix.accounts.forEach(add);
  for (const ix of ixs) add(ix.program);
  const body: number[] = [
    0x80,
    1, // ein Unterzeichner (Gebührenzahler)
    0,
    0,
    ...shortVec(keys.length),
    ...keys.flatMap((k) => [...base58Decode(k)]),
    ...new Array(32).fill(9), // recent blockhash
    ...shortVec(ixs.length),
    ...ixs.flatMap((ix) => [keys.indexOf(ix.program), ...shortVec(ix.accounts.length), ...ix.accounts.map((a) => keys.indexOf(a)), ...shortVec(ix.data.length), ...ix.data]),
    0, // keine Lookup-Tabellen
  ];
  return Buffer.from(Uint8Array.from([1, ...new Array(64).fill(0), ...body])).toString('base64');
}

const le = (v: bigint, bytes: number) => Array.from({ length: bytes }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));

const WSOL = 'So11111111111111111111111111111111111111112';

export type JupiterRouteOpts = {
  cuPrice?: bigint;
  /** 'shared' = shared_accounts_route, sonst route */
  kind?: 'route' | 'shared';
  authority?: string;
  destination?: string;
  inAmount?: bigint;
  quotedOut?: bigint;
  slippageBps?: number;
  platformFeeBps?: number;
  discriminator?: number[];
};

/** Anchor-Diskriminator wie im Programm: sha256("global:<name>")[0..8]. */
const disc = (name: string) => [...sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8)];

/**
 * Bausteine eines echten Jupiter-Swaps (SOL einpacken → Route → auspacken),
 * Route-Anweisung im Aufbau des offiziellen IDL (Konten + Argumente am Ende).
 */
export function jupiterLikeIxs(owner: string, swap: JupiterSwapExpect, o: JupiterRouteOpts = {}): TestIx[] {
  const wsolAta = associatedTokenAddress(owner, WSOL);
  const outAta = associatedTokenAddress(owner, swap.outMint);
  const srcAta = associatedTokenAddress(owner, swap.inMint);
  const dest = o.destination ?? outAta;
  const auth = o.authority ?? owner;
  const tail = [
    ...le(o.inAmount ?? swap.inAmount, 8),
    ...le(o.quotedOut ?? swap.quotedOutAmount, 8),
    ...le(BigInt(o.slippageBps ?? swap.slippageBps), 2),
    o.platformFeeBps ?? 0,
  ];
  const routePlan = [1, 0, 0, 0, 7, 0x10, 0x27, 0, 1]; // 1 Schritt (Inhalt für den Wächter egal)
  const jup: TestIx =
    o.kind === 'shared'
      ? {
          program: JUPITER_V6,
          accounts: [TOKEN_PROGRAM, JUPITER_V6, auth, srcAta, srcAta, dest, dest, swap.inMint, swap.outMint, JUPITER_V6, JUPITER_V6, JUPITER_V6, JUPITER_V6],
          data: [...(o.discriminator ?? disc('shared_accounts_route')), 3, ...routePlan, ...tail],
        }
      : {
          program: JUPITER_V6,
          accounts: [TOKEN_PROGRAM, auth, srcAta, dest, JUPITER_V6, swap.outMint, JUPITER_V6, JUPITER_V6, JUPITER_V6],
          data: [...(o.discriminator ?? disc('route')), ...routePlan, ...tail],
        };
  const solIn = swap.inMint === WSOL;
  const solOut = swap.outMint === WSOL;
  return [
    { program: COMPUTE_BUDGET, accounts: [], data: [2, ...le(200_000n, 4)] },
    { program: COMPUTE_BUDGET, accounts: [], data: [3, ...le(o.cuPrice ?? 1_000n, 8)] },
    ...(solIn || solOut ? [{ program: ATA_PROGRAM, accounts: [owner, wsolAta, owner, WSOL, SYSTEM_PROGRAM, TOKEN_PROGRAM], data: [1] }] : []),
    ...(solIn ? [systemTransfer(owner, wsolAta, swap.inAmount), { program: TOKEN_PROGRAM, accounts: [wsolAta], data: [17] }] : []),
    ...(solOut ? [] : [{ program: ATA_PROGRAM, accounts: [owner, outAta, owner, swap.outMint, SYSTEM_PROGRAM, TOKEN_PROGRAM], data: [1] }]),
    jup,
    ...(solIn || solOut ? [{ program: TOKEN_PROGRAM, accounts: [wsolAta, owner, owner], data: [9] }] : []),
  ];
}

export const systemTransfer = (from: string, to: string, lamports: bigint): TestIx => ({ program: SYSTEM_PROGRAM, accounts: [from, to], data: [2, 0, 0, 0, ...le(lamports, 8)] });
