/**
 * Transaktions-Wächter für Jupiter-Swaps: nur die Bausteine eines Swaps für
 * die eigene Wallet werden signiert; jede Überweisung/Freigabe an andere,
 * fremde Programme oder überhöhte Gebühren → verweigert.
 */
import { describe, expect, it } from 'vitest';
import { generateWalletKey } from './keys.js';
import { assertJupiterSwapTx, associatedTokenAddress, parseSolanaMessage, SYSTEM_PROGRAM, TOKEN_PROGRAM } from './solana-guard.js';
import { buildV0Tx, jupiterLikeIxs, systemTransfer, type TestIx } from './testing/solana-tx-builder.js';

const me = generateWalletKey('solana').address;
const thief = generateWalletKey('solana').address;
const bytes = (b64: string) => Uint8Array.from(Buffer.from(b64, 'base64'));
const check = (ixs: TestIx[], maxSolIn = 10_000_000n) => () => assertJupiterSwapTx(bytes(buildV0Tx(me, ixs)), me, { maxSolIn });

describe('associatedTokenAddress', () => {
  it('gleich wie die offizielle Bibliothek (@solana/web3.js 1.98.4 findProgramAddressSync, gegengerechnet 2026-10-21)', () => {
    expect(associatedTokenAddress('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe('FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B');
    expect(associatedTokenAddress('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'So11111111111111111111111111111111111111112')).toBe('Fr37Gkri7undsm6MiQADnMounZ48VngX8jmH49aTd1bg');
  });
});

describe('assertJupiterSwapTx', () => {
  it('echter Swap-Aufbau (einpacken → Route → auspacken) ist erlaubt; Parser liest alles', () => {
    const tx = bytes(buildV0Tx(me, jupiterLikeIxs(me, 10_000_000n)));
    expect(parseSolanaMessage(tx).instructions.map((i) => i.program)).toContain('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
    expect(() => assertJupiterSwapTx(tx, me, { maxSolIn: 10_000_000n })).not.toThrow();
    // Verkauf: kein Einpacken
    expect(check(jupiterLikeIxs(me, 0n), 0n)).not.toThrow();
  });

  it('SOL-Überweisung an Fremde → verweigert', () => {
    expect(check([...jupiterLikeIxs(me, 10_000_000n), systemTransfer(me, thief, 5_000_000_000n)])).toThrow(/fremdes Konto/);
  });

  it('mehr SOL eingepackt als bestätigt → verweigert', () => {
    expect(check(jupiterLikeIxs(me, 50_000_000n), 10_000_000n)).toThrow(/mehr SOL/);
  });

  it('Token-Transfer, Approve, SetAuthority → verweigert', () => {
    const acc = associatedTokenAddress(me, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    for (const op of [3, 4, 6, 12]) {
      expect(check([...jupiterLikeIxs(me, 1n), { program: TOKEN_PROGRAM, accounts: [acc, thief, me], data: [op, 1, 0, 0, 0, 0, 0, 0, 0] }])).toThrow(/Token-Anweisung/);
    }
  });

  it('Konto schließen zugunsten Fremder, Token-Konto für fremde Wallet → verweigert', () => {
    const ixs = jupiterLikeIxs(me, 1n);
    const close = ixs.at(-1)!;
    expect(check([...ixs.slice(0, -1), { ...close, accounts: [close.accounts[0]!, thief, me] }])).toThrow(/fremden Kontos/);
    const ata = ixs[2]!;
    expect(check([ata.accounts.length ? { ...ata, accounts: [me, ata.accounts[1]!, thief, ...ata.accounts.slice(3)] } : ata, ...ixs.slice(3)])).toThrow(/fremde Wallet/);
  });

  it('fremdes Programm, fehlender Jupiter-Swap, überhöhte Prioritätsgebühr → verweigert', () => {
    expect(check([...jupiterLikeIxs(me, 1n), { program: generateWalletKey('solana').address, accounts: [me], data: [1] }])).toThrow(/unbekanntes Programm/);
    expect(check(jupiterLikeIxs(me, 1n).filter((i) => !i.program.startsWith('JUP')))).toThrow(/kein Jupiter-Swap/);
    expect(check(jupiterLikeIxs(me, 1n, { cuPrice: 10n ** 12n }))).toThrow(/Prioritätsgebühr/);
  });

  it('andere System-Anweisungen (z. B. Konto zuweisen) → verweigert', () => {
    expect(check([...jupiterLikeIxs(me, 1n), { program: SYSTEM_PROGRAM, accounts: [me], data: [1, 0, 0, 0, ...new Array(32).fill(1)] }])).toThrow(/System-Anweisung/);
  });
});
