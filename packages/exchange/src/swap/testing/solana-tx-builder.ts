import { base58Decode } from '../keys.js';
import { ATA_PROGRAM, associatedTokenAddress, COMPUTE_BUDGET, JUPITER_V6, SYSTEM_PROGRAM, TOKEN_PROGRAM } from '../solana-guard.js';

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

/** Bausteine eines echten Jupiter-Swaps (SOL einpacken → Route → auspacken). */
export function jupiterLikeIxs(owner: string, lamportsIn: bigint, opts: { cuPrice?: bigint } = {}): TestIx[] {
  const WSOL = 'So11111111111111111111111111111111111111112';
  const ata = associatedTokenAddress(owner, WSOL);
  return [
    { program: COMPUTE_BUDGET, accounts: [], data: [2, ...le(200_000n, 4)] },
    { program: COMPUTE_BUDGET, accounts: [], data: [3, ...le(opts.cuPrice ?? 1_000n, 8)] },
    { program: ATA_PROGRAM, accounts: [owner, ata, owner, WSOL, SYSTEM_PROGRAM, TOKEN_PROGRAM], data: [1] },
    ...(lamportsIn > 0n ? [{ program: SYSTEM_PROGRAM, accounts: [owner, ata], data: [2, 0, 0, 0, ...le(lamportsIn, 8)] }] : []),
    { program: TOKEN_PROGRAM, accounts: [ata], data: [17] },
    { program: JUPITER_V6, accounts: [TOKEN_PROGRAM, owner, ata], data: [0xe5, 0x17, 1, 2, 3] },
    { program: TOKEN_PROGRAM, accounts: [ata, owner, owner], data: [9] },
  ];
}

export const systemTransfer = (from: string, to: string, lamports: bigint): TestIx => ({ program: SYSTEM_PROGRAM, accounts: [from, to], data: [2, 0, 0, 0, ...le(lamports, 8)] });
