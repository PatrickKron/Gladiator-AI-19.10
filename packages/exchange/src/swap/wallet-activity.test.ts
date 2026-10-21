/**
 * Swaps fremder Wallets erkennen (Copy-Trading): Kauf, Verkauf, Token↔Token,
 * wrapped SOL; Überweisungen, Airdrops und fehlgeschlagene Tx werden nicht als
 * Swap gedeutet. „Echte Daten“ liest echte Transaktionen von der Kette (CI).
 */
import { describe, expect, it } from 'vitest';
import { SOL_MINT } from './chains.js';
import { deriveSwapFromTx, fetchSolanaWalletSwaps, SOLANA_SIG_PAGE, type ParsedTx } from './wallet-activity.js';

const ME = 'Wa11et1111111111111111111111111111111111111';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function tx(p: {
  sol: [number, number];
  tokens?: { mint: string; pre: string | null; post: string | null; decimals?: number; owner?: string }[];
  fee?: number;
  err?: unknown;
}): ParsedTx {
  const pre = (p.tokens ?? []).filter((t) => t.pre !== null).map((t, i) => ({ accountIndex: i + 1, mint: t.mint, owner: t.owner ?? ME, uiTokenAmount: { amount: t.pre!, decimals: t.decimals ?? 5 } }));
  const post = (p.tokens ?? []).filter((t) => t.post !== null).map((t, i) => ({ accountIndex: i + 1, mint: t.mint, owner: t.owner ?? ME, uiTokenAmount: { amount: t.post!, decimals: t.decimals ?? 5 } }));
  return {
    blockTime: 1_700_000_000,
    meta: { err: p.err ?? null, fee: p.fee ?? 5_000, preBalances: [p.sol[0], 1], postBalances: [p.sol[1], 1], preTokenBalances: pre, postTokenBalances: post },
    transaction: { message: { accountKeys: [{ pubkey: ME, signer: true }, { pubkey: 'Other1111111111111111111111111111111111111' }] } },
  };
}

describe('deriveSwapFromTx', () => {
  it('Kauf: SOL raus, ein Token rein (neues Token-Konto, Gebühr herausgerechnet)', () => {
    const s = deriveSwapFromTx('sig1', tx({ sol: [2_000_000_000, 1_000_000_000 - 5_000], tokens: [{ mint: BONK, pre: null, post: '500000000' }] }), ME);
    expect(s).toMatchObject({ side: 'buy', token: BONK, tokenAtomic: 500_000_000n, nativeAtomic: 1_000_000_000n, counterToken: null, time: 1_700_000_000 });
  });

  it('Verkauf: Token raus, SOL rein', () => {
    const s = deriveSwapFromTx('sig2', tx({ sol: [1_000_000_000, 1_400_000_000 - 5_000], tokens: [{ mint: BONK, pre: '500000000', post: '0' }] }), ME);
    expect(s).toMatchObject({ side: 'sell', token: BONK, tokenAtomic: 500_000_000n, nativeAtomic: 400_000_000n });
  });

  it('wrapped SOL zählt als SOL', () => {
    const s = deriveSwapFromTx(
      'sig3',
      tx({ sol: [1_000_000_000, 1_000_000_000 - 5_000], tokens: [{ mint: SOL_MINT, pre: '300000000', post: '0', decimals: 9 }, { mint: BONK, pre: '0', post: '100' }] }),
      ME,
    );
    expect(s).toMatchObject({ side: 'buy', token: BONK, nativeAtomic: 300_000_000n });
  });

  it('Token ↔ Token (USDC → BONK) = Kauf von BONK mit Gegen-Token', () => {
    const s = deriveSwapFromTx('sig4', tx({ sol: [1_000_000_000, 1_000_000_000 - 5_000], tokens: [{ mint: USDC, pre: '5000000', post: '0', decimals: 6 }, { mint: BONK, pre: null, post: '250' }] }), ME);
    expect(s).toMatchObject({ side: 'buy', token: BONK, counterToken: USDC, nativeAtomic: null });
  });

  it('BONK → USDC = Verkauf (nicht „Kauf von USDC“); Meme ↔ Meme = kein Swap', () => {
    const sell = deriveSwapFromTx('sig5', tx({ sol: [1_000_000_000, 1_000_000_000 - 5_000], tokens: [{ mint: BONK, pre: '250', post: '0' }, { mint: USDC, pre: '0', post: '5000000', decimals: 6 }] }), ME);
    expect(sell).toMatchObject({ side: 'sell', token: BONK, tokenAtomic: 250n, counterToken: USDC });
    const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
    expect(deriveSwapFromTx('sig6', tx({ sol: [1_000_000_000, 1_000_000_000 - 5_000], tokens: [{ mint: BONK, pre: '250', post: '0' }, { mint: WIF, pre: null, post: '7' }] }), ME)).toBeNull();
  });

  it('kein Swap: Überweisung, Airdrop, Kontomiete, fehlgeschlagene Tx, fremde Token-Konten', () => {
    // nur SOL raus (Überweisung)
    expect(deriveSwapFromTx('a', tx({ sol: [2_000_000_000, 1_000_000_000] }), ME)).toBeNull();
    // Token rein ohne Gegenleistung (Airdrop)
    expect(deriveSwapFromTx('b', tx({ sol: [1_000_000_000, 1_000_000_000 - 5_000], tokens: [{ mint: BONK, pre: null, post: '100' }] }), ME)).toBeNull();
    // nur Kontomiete (0,002 SOL) für ein neues Token-Konto
    expect(deriveSwapFromTx('c', tx({ sol: [1_000_000_000, 1_000_000_000 - 2_044_280], tokens: [{ mint: BONK, pre: null, post: '0' }] }), ME)).toBeNull();
    // fehlgeschlagen
    expect(deriveSwapFromTx('d', tx({ sol: [2_000_000_000, 1_000_000_000], tokens: [{ mint: BONK, pre: null, post: '500' }], err: { InstructionError: [0, 'x'] } }), ME)).toBeNull();
    // Token-Konten gehören jemand anderem
    expect(deriveSwapFromTx('e', tx({ sol: [2_000_000_000, 1_000_000_000], tokens: [{ mint: BONK, pre: null, post: '500', owner: 'Fremd' }] }), ME)).toBeNull();
  });
});

describe('fetchSolanaWalletSwaps: Cursor', () => {
  // 30 Signaturen s1 (alt) … s30 (neu); jede ist ein Kauf
  const all = Array.from({ length: 30 }, (_, i) => `s${i + 1}`);
  const net = (sigs: string[]) =>
    (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      const rpc = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      if (body.method === 'getSignaturesForAddress') {
        const o = body.params[1] as { limit: number; until?: string };
        const newestFirst = [...sigs].reverse();
        const stop = o.until ? newestFirst.indexOf(o.until) : -1;
        return rpc((stop === -1 ? newestFirst : newestFirst.slice(0, stop)).slice(0, o.limit).map((signature) => ({ signature, err: null })));
      }
      return rpc(tx({ sol: [2_000_000_000, 1_000_000_000 - 5_000], tokens: [{ mint: BONK, pre: null, post: '5' }] }));
    }) as unknown as typeof fetch;

  it('ältere neue Tx zuerst, Cursor auf die zuletzt gelesene — nichts wird übersprungen', async () => {
    const r1 = await fetchSolanaWalletSwaps(ME, { limit: 10, until: 's5' }, net(all));
    expect(r1.swaps.map((s) => s.signature)).toEqual(['s15', 's14', 's13', 's12', 's11', 's10', 's9', 's8', 's7', 's6']);
    expect(r1).toMatchObject({ newestSignature: 's15', gap: false });
    const r2 = await fetchSolanaWalletSwaps(ME, { limit: 10, until: r1.newestSignature }, net(all));
    expect(r2.swaps.at(-1)!.signature).toBe('s16');
  });

  it('leere Wallet → Cursor "" (kein ewiger erster Lauf); erster Lauf = jüngste als Verlauf', async () => {
    expect(await fetchSolanaWalletSwaps(ME, { limit: 10 }, net([]))).toEqual({ swaps: [], newestSignature: '', gap: false });
    const first = await fetchSolanaWalletSwaps(ME, { limit: 3 }, net(all));
    expect(first.swaps.map((s) => s.signature)).toEqual(['s30', 's29', 's28']);
    expect(first.newestSignature).toBe('s30');
  });

  it('mehr neue Signaturen als eine Seite → jüngste Seite + Lücke gemeldet', async () => {
    const many = Array.from({ length: SOLANA_SIG_PAGE + 20 }, (_, i) => `m${i + 1}`);
    const r = await fetchSolanaWalletSwaps(ME, { limit: 5, until: 'm1' }, net(many));
    expect(r.gap).toBe(true);
    expect(r.newestSignature).toBe(`m${SOLANA_SIG_PAGE + 20}`);
  });
});

describe('echte Daten (Solana-RPC)', () => {
  it('liest echte Transaktionen einer aktiven Adresse ohne Fehler; erkannte Swaps sind vollständig', async () => {
    // Jupiter-Aggregator-Programm: garantiert laufend Transaktionen
    const r = await fetchSolanaWalletSwaps('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', { limit: 3 });
    expect(r.newestSignature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{60,90}$/);
    for (const s of r.swaps) {
      expect(['buy', 'sell']).toContain(s.side);
      expect(s.tokenAtomic > 0n).toBe(true);
    }
  }, 60_000);
});
