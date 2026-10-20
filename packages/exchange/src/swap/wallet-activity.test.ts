/**
 * Swaps fremder Wallets erkennen (Copy-Trading): Kauf, Verkauf, Token↔Token,
 * wrapped SOL; Überweisungen, Airdrops und fehlgeschlagene Tx werden nicht als
 * Swap gedeutet. „Echte Daten“ liest echte Transaktionen von der Kette (CI).
 */
import { describe, expect, it } from 'vitest';
import { SOL_MINT } from './chains.js';
import { deriveSwapFromTx, fetchSolanaWalletSwaps, type ParsedTx } from './wallet-activity.js';

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
    expect(s).toMatchObject({ side: 'buy', token: BONK, tokenAtomic: 500_000_000n, solLamports: 1_000_000_000n, counterToken: null, time: 1_700_000_000 });
  });

  it('Verkauf: Token raus, SOL rein', () => {
    const s = deriveSwapFromTx('sig2', tx({ sol: [1_000_000_000, 1_400_000_000 - 5_000], tokens: [{ mint: BONK, pre: '500000000', post: '0' }] }), ME);
    expect(s).toMatchObject({ side: 'sell', token: BONK, tokenAtomic: 500_000_000n, solLamports: 400_000_000n });
  });

  it('wrapped SOL zählt als SOL', () => {
    const s = deriveSwapFromTx(
      'sig3',
      tx({ sol: [1_000_000_000, 1_000_000_000 - 5_000], tokens: [{ mint: SOL_MINT, pre: '300000000', post: '0', decimals: 9 }, { mint: BONK, pre: '0', post: '100' }] }),
      ME,
    );
    expect(s).toMatchObject({ side: 'buy', token: BONK, solLamports: 300_000_000n });
  });

  it('Token ↔ Token (USDC → BONK) = Kauf von BONK mit Gegen-Token', () => {
    const s = deriveSwapFromTx('sig4', tx({ sol: [1_000_000_000, 1_000_000_000 - 5_000], tokens: [{ mint: USDC, pre: '5000000', post: '0', decimals: 6 }, { mint: BONK, pre: null, post: '250' }] }), ME);
    expect(s).toMatchObject({ side: 'buy', token: BONK, counterToken: USDC, solLamports: null });
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
