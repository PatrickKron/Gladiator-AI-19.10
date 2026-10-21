/**
 * Transaktions-Wächter für Jupiter-Swaps: nur die Bausteine eines Swaps für
 * die eigene Wallet werden signiert; jede Überweisung/Freigabe an andere,
 * fremde Programme oder überhöhte Gebühren → verweigert.
 */
import { describe, expect, it } from 'vitest';
import { generateWalletKey } from './keys.js';
import { assertJupiterSwapTx, associatedTokenAddress, COMPUTE_BUDGET, parseSolanaMessage, SYSTEM_PROGRAM, TOKEN_PROGRAM, type JupiterSwapExpect } from './solana-guard.js';
import { buildV0Tx, jupiterLikeIxs, systemTransfer, type TestIx } from './testing/solana-tx-builder.js';

const me = generateWalletKey('solana').address;
const thief = generateWalletKey('solana').address;
const bytes = (b64: string) => Uint8Array.from(Buffer.from(b64, 'base64'));

describe('associatedTokenAddress', () => {
  it('gleich wie die offizielle Bibliothek (@solana/web3.js 1.98.4 findProgramAddressSync, gegengerechnet 2026-10-21)', () => {
    expect(associatedTokenAddress('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe('FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B');
    expect(associatedTokenAddress('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'So11111111111111111111111111111111111111112')).toBe('Fr37Gkri7undsm6MiQADnMounZ48VngX8jmH49aTd1bg');
  });
});

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const buy: JupiterSwapExpect = { inMint: SOL, outMint: USDC, inAmount: 10_000_000n, quotedOutAmount: 1_500_000n, slippageBps: 50 };
const sell: JupiterSwapExpect = { inMint: USDC, outMint: SOL, inAmount: 1_500_000n, quotedOutAmount: 10_000_000n, slippageBps: 50 };
const check = (ixs: TestIx[], exp: JupiterSwapExpect = buy) => () => assertJupiterSwapTx(bytes(buildV0Tx(me, ixs)), me, exp);

describe('assertJupiterSwapTx', () => {
  it('echter Swap-Aufbau (einpacken → Route → auspacken) ist erlaubt — Kauf, Verkauf, beide Route-Arten', () => {
    const tx = bytes(buildV0Tx(me, jupiterLikeIxs(me, buy)));
    expect(parseSolanaMessage(tx).instructions.map((i) => i.program)).toContain('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
    expect(() => assertJupiterSwapTx(tx, me, buy)).not.toThrow();
    expect(check(jupiterLikeIxs(me, sell), sell)).not.toThrow();
    expect(check(jupiterLikeIxs(me, buy, { kind: 'shared' }))).not.toThrow();
    expect(check(jupiterLikeIxs(me, sell, { kind: 'shared' }), sell)).not.toThrow();
    // besseres Ergebnis als bestätigt ist kein Grund zur Ablehnung
    expect(check(jupiterLikeIxs(me, buy, { quotedOut: 2_000_000n }))).not.toThrow();
  });

  it('SOL-Überweisung an Fremde → verweigert', () => {
    expect(check([...jupiterLikeIxs(me, buy), systemTransfer(me, thief, 5_000_000_000n)])).toThrow(/fremdes Konto/);
  });

  it('mehr SOL eingepackt als bestätigt; beim Verkauf überhaupt eingepackt → verweigert', () => {
    expect(check(jupiterLikeIxs(me, { ...buy, inAmount: 50_000_000n }, { inAmount: buy.inAmount }))).toThrow(/mehr SOL/);
    expect(check([...jupiterLikeIxs(me, sell), systemTransfer(me, associatedTokenAddress(me, SOL), 1n)], sell)).toThrow(/mehr SOL/);
  });

  it('Jupiter-Route manipuliert: Ziel/Befugnis fremd, Menge, Mindestmenge, Slippage, Plattform-Gebühr → verweigert', () => {
    const theirs = associatedTokenAddress(thief, USDC);
    expect(check(jupiterLikeIxs(me, buy, { destination: theirs }))).toThrow(/Ziel/);
    expect(check(jupiterLikeIxs(me, buy, { destination: theirs, kind: 'shared' }))).toThrow(/Ziel/);
    expect(check(jupiterLikeIxs(me, buy, { authority: thief }))).toThrow(/eigenen Wallet/);
    expect(check(jupiterLikeIxs(me, buy, { inAmount: 20_000_000n }))).toThrow(/Menge/);
    expect(check(jupiterLikeIxs(me, buy, { quotedOut: 1n }))).toThrow(/Mindestmenge/);
    expect(check(jupiterLikeIxs(me, buy, { slippageBps: 10_000 }))).toThrow(/Mindestmenge/);
    expect(check(jupiterLikeIxs(me, buy, { platformFeeBps: 100 }))).toThrow(/Plattform-Gebühr/);
    // anderer Ziel-Mint als bestätigt
    expect(check(jupiterLikeIxs(me, { ...buy, outMint: generateWalletKey('solana').address }))).toThrow(/Ziel|Tokens/);
  });

  it('andere Jupiter-Anweisungen (ExactOut, TokenLedger …) und zwei Swaps → verweigert', () => {
    expect(check(jupiterLikeIxs(me, buy, { discriminator: [1, 2, 3, 4, 5, 6, 7, 8] }))).toThrow(/unbekannte Jupiter-Anweisung/);
    const two = jupiterLikeIxs(me, buy);
    const route = two.find((i) => i.program.startsWith('JUP'))!;
    expect(check([...two, route])).toThrow(/mehr als ein/);
  });

  it('Token-Transfer, Approve, SetAuthority → verweigert', () => {
    const acc = associatedTokenAddress(me, USDC);
    for (const op of [3, 4, 6, 12]) {
      expect(check([...jupiterLikeIxs(me, buy), { program: TOKEN_PROGRAM, accounts: [acc, thief, me], data: [op, 1, 0, 0, 0, 0, 0, 0, 0] }])).toThrow(/Token-Anweisung/);
    }
  });

  it('Konto schließen zugunsten Fremder, Token-Konto für fremde Wallet → verweigert', () => {
    const ixs = jupiterLikeIxs(me, buy);
    const close = ixs.at(-1)!;
    expect(check([...ixs.slice(0, -1), { ...close, accounts: [close.accounts[0]!, thief, me] }])).toThrow(/fremden Kontos/);
    const ata = ixs[2]!;
    expect(check([...ixs.slice(0, 2), { ...ata, accounts: [me, ata.accounts[1]!, thief, ...ata.accounts.slice(3)] }, ...ixs.slice(3)])).toThrow(/fremde Wallet/);
  });

  it('fremdes Programm, fehlender Jupiter-Swap, überhöhte Prioritätsgebühr → verweigert; harmlose ComputeBudget-Anweisungen erlaubt', () => {
    expect(check([...jupiterLikeIxs(me, buy), { program: generateWalletKey('solana').address, accounts: [me], data: [1] }])).toThrow(/unbekanntes Programm/);
    expect(check(jupiterLikeIxs(me, buy).filter((i) => !i.program.startsWith('JUP')))).toThrow(/kein Jupiter-Swap/);
    expect(check(jupiterLikeIxs(me, buy, { cuPrice: 10n ** 12n }))).toThrow(/Prioritätsgebühr/);
    expect(check([{ program: COMPUTE_BUDGET, accounts: [], data: [4, 0, 0, 4, 0] }, ...jupiterLikeIxs(me, buy)])).not.toThrow();
  });

  it('andere System-Anweisungen (z. B. Konto zuweisen) → verweigert', () => {
    expect(check([...jupiterLikeIxs(me, buy), { program: SYSTEM_PROGRAM, accounts: [me], data: [1, 0, 0, 0, ...new Array(32).fill(1)] }])).toThrow(/System-Anweisung/);
  });
});
