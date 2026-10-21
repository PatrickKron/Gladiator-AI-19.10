import { isStablecoin, rpcUrl, SOL_MINT } from './chains.js';

/**
 * Swaps einer fremden Solana-Wallet von der Kette lesen (Vision-Punkt 5,
 * „Copy-Trading wie Trojan“): Signaturen der Adresse → Transaktionen
 * (jsonParsed) → Saldo-Differenzen der Wallet je Token. Ein Swap ist eine
 * Transaktion, in der genau ein Token zunimmt und SOL bzw. ein anderer Token
 * abnimmt. Alles andere (Überweisungen, Airdrops, fehlgeschlagene Tx) wird
 * ignoriert — nie geraten.
 */

type Fetch = typeof fetch;

export type ObservedSwap = {
  signature: string;
  /** Unix-Sekunden */
  time: number | null;
  side: 'buy' | 'sell';
  /** gekaufter bzw. verkaufter Token (Mint) */
  token: string;
  /** Menge des Tokens (kleinste Einheit) */
  tokenAtomic: bigint;
  tokenDecimals: number;
  /** Gegenwert in nativer Währung (kleinste Einheit, ohne Netzwerkgebühr); null, wenn gegen einen anderen Token getauscht oder nicht sichtbar */
  nativeAtomic: bigint | null;
  /** Gegen-Token, wenn nicht SOL (z. B. USDC) */
  counterToken: string | null;
};

type TokenBalance = { accountIndex?: number; mint?: string; owner?: string; uiTokenAmount?: { amount?: string; decimals?: number } };

export type ParsedTx = {
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction?: { message?: { accountKeys?: ({ pubkey?: string; signer?: boolean } | string)[] } };
};

const WSOL = SOL_MINT;

function keyOf(k: { pubkey?: string } | string | undefined): string | undefined {
  return typeof k === 'string' ? k : k?.pubkey;
}

/** Reine Auswertung einer Transaktion aus Sicht von `owner` (getestet). */
export function deriveSwapFromTx(signature: string, tx: ParsedTx, owner: string): ObservedSwap | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const idx = keys.findIndex((k) => keyOf(k) === owner);

  // Token-Differenzen (wrapped SOL zählt als SOL)
  const deltas = new Map<string, { delta: bigint; decimals: number }>();
  const add = (b: TokenBalance, sign: 1n | -1n) => {
    if (b.owner !== owner || !b.mint || b.uiTokenAmount?.amount === undefined) return;
    const cur = deltas.get(b.mint) ?? { delta: 0n, decimals: b.uiTokenAmount.decimals ?? 0 };
    cur.delta += sign * BigInt(b.uiTokenAmount.amount);
    deltas.set(b.mint, cur);
  };
  for (const b of meta.preTokenBalances ?? []) add(b, -1n);
  for (const b of meta.postTokenBalances ?? []) add(b, 1n);

  // SOL-Differenz der Wallet (native + wrapped), Netzwerkgebühr herausgerechnet, wenn sie zahlt
  let sol = 0n;
  if (idx >= 0 && meta.preBalances?.[idx] !== undefined && meta.postBalances?.[idx] !== undefined) {
    sol = BigInt(meta.postBalances[idx]!) - BigInt(meta.preBalances[idx]!);
    if (idx === 0 && meta.fee) sol += BigInt(meta.fee);
  }
  const wsol = deltas.get(WSOL);
  if (wsol) {
    sol += wsol.delta;
    deltas.delete(WSOL);
  }
  // Konto-Mieten (≈0,002 SOL für neue Token-Konten) sind kein Handel: kleine SOL-Bewegungen ignorieren
  const RENT_NOISE = 3_000_000n;
  const solSide = sol > RENT_NOISE ? 'in' : sol < -RENT_NOISE ? 'out' : null;

  const changed = [...deltas.entries()].filter(([, d]) => d.delta !== 0n);
  const ups = changed.filter(([, d]) => d.delta > 0n);
  const downs = changed.filter(([, d]) => d.delta < 0n);

  // SOL → Token
  if (solSide === 'out' && ups.length === 1 && downs.length === 0) {
    const [mint, d] = ups[0]!;
    return { signature, time: tx.blockTime ?? null, side: 'buy', token: mint, tokenAtomic: d.delta, tokenDecimals: d.decimals, nativeAtomic: -sol, counterToken: null };
  }
  // Token → SOL
  if (solSide === 'in' && downs.length === 1 && ups.length === 0) {
    const [mint, d] = downs[0]!;
    return { signature, time: tx.blockTime ?? null, side: 'sell', token: mint, tokenAtomic: -d.delta, tokenDecimals: d.decimals, nativeAtomic: sol, counterToken: null };
  }
  return tokenVsStable(signature, tx.blockTime ?? null, solSide === null, ups, downs, (m) => isStablecoin('solana', m));
}

/**
 * Token ↔ Token nur mit Stablecoin als Gegenseite eindeutig: Stable → Token =
 * Kauf, Token → Stable = Verkauf. Meme ↔ Meme ist weder noch → kein Swap
 * (sonst würde ein Verkauf gegen USDC als „Kauf von USDC“ kopiert).
 */
export function tokenVsStable(
  signature: string,
  time: number | null,
  noNative: boolean,
  ups: [string, { delta: bigint; decimals: number }][],
  downs: [string, { delta: bigint; decimals: number }][],
  stable: (token: string) => boolean,
): ObservedSwap | null {
  if (!noNative || ups.length !== 1 || downs.length !== 1) return null;
  const [upMint, up] = ups[0]!;
  const [downMint, down] = downs[0]!;
  if (stable(downMint) && !stable(upMint)) {
    return { signature, time, side: 'buy', token: upMint, tokenAtomic: up.delta, tokenDecimals: up.decimals, nativeAtomic: null, counterToken: downMint };
  }
  if (stable(upMint) && !stable(downMint)) {
    return { signature, time, side: 'sell', token: downMint, tokenAtomic: -down.delta, tokenDecimals: down.decimals, nativeAtomic: null, counterToken: upMint };
  }
  return null;
}

async function rpc(method: string, params: unknown[], fetchFn: Fetch): Promise<unknown> {
  const res = await fetchFn(rpcUrl('solana'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`RPC solana ${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`RPC solana ${method}: ${body.error.message ?? 'Fehler'}`);
  return body.result;
}

/** Signaturen je Abruf (eine billige Abfrage); mehr neue → Wallet zu aktiv, Lücke wird gemeldet. */
export const SOLANA_SIG_PAGE = 100;

export type WalletSwapsPage = {
  /** neueste zuerst */
  swaps: ObservedSwap[];
  /** neuer Lese-Cursor; '' = Wallet hatte noch keine Transaktion (kein „erster Lauf“ mehr) */
  newestSignature: string;
  /** true = es gab mehr neue Transaktionen, als gelesen werden konnten → Lücke */
  gap: boolean;
};

/**
 * Swaps einer Solana-Wallet seit der Signatur `until`. Verarbeitet die
 * ÄLTESTEN `limit` neuen Transaktionen und setzt den Cursor auf die zuletzt
 * verarbeitete — der Rest kommt im nächsten Takt, nichts wird still
 * übersprungen. Erster Lauf (ohne `until`): nur die jüngsten als Verlauf.
 * Mehr als eine Seite neuer Signaturen: Wallet zu aktiv → jüngste Seite, `gap`.
 */
export async function fetchSolanaWalletSwaps(
  owner: string,
  opts: { limit?: number; until?: string | null } = {},
  fetchFn: Fetch = fetch,
): Promise<WalletSwapsPage> {
  const limit = opts.limit ?? 15;
  const newestFirst = (await rpc('getSignaturesForAddress', [owner, { limit: SOLANA_SIG_PAGE, ...(opts.until ? { until: opts.until } : {}) }], fetchFn)) as {
    signature: string;
    err: unknown;
  }[];
  const chrono = [...newestFirst].reverse();
  const gap = Boolean(opts.until) && newestFirst.length === SOLANA_SIG_PAGE;
  // Verlauf bzw. Überlauf: die jüngsten; sonst die ältesten (lückenlos nachholen)
  const take = !opts.until || gap ? chrono.slice(-limit) : chrono.slice(0, limit);
  const cursor = !opts.until ? (newestFirst[0]?.signature ?? '') : (take.at(-1)?.signature ?? opts.until);
  const swaps: ObservedSwap[] = [];
  for (const s of [...take].reverse()) {
    if (s.err) continue;
    // Version 1 = neueste Solana-Transaktionsform (auch v0/legacy werden damit geliefert)
    const tx = (await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }], fetchFn)) as ParsedTx | null;
    if (!tx) continue;
    const swap = deriveSwapFromTx(s.signature, tx, owner);
    if (swap) swaps.push(swap);
  }
  return { swaps, newestSignature: cursor, gap };
}
