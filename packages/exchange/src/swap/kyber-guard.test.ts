/**
 * KyberSwap-Wächter: dekodierte Calldata muss genau zum bestätigten Angebot
 * passen — Empfänger, Tokens, Mengen, keine Fremdgebühren, passender value.
 */
import { describe, expect, it } from 'vitest';
import { EVM_NATIVE } from './chains.js';
import { assertKyberSwap, decodeKyberDesc } from './kyber-guard.js';
import { kyberSwapCalldata } from './testing/kyber-calldata.js';

const ME = '0x00000000000000000000000000000000000000aa';
const THIEF = '0x00000000000000000000000000000000000000bb';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const IN = 10n ** 16n;
const expectBuy = { owner: ME, srcToken: EVM_NATIVE, dstToken: USDC, amountIn: IN, minOut: 29_700_000n, nativeIn: true };
const good = { srcToken: EVM_NATIVE, dstToken: USDC, dstReceiver: ME, amount: IN, minReturnAmount: 29_700_000n };

describe('assertKyberSwap', () => {
  it('passende Calldata (Kauf mit ETH) → erlaubt; Groß/Klein egal', () => {
    expect(() => assertKyberSwap(kyberSwapCalldata(good), IN, expectBuy)).not.toThrow();
    expect(() => assertKyberSwap(kyberSwapCalldata({ ...good, dstToken: USDC.toLowerCase() }), IN, { ...expectBuy, owner: ME.toUpperCase().replace('0X', '0x') })).not.toThrow();
    expect(decodeKyberDesc(kyberSwapCalldata(good)).amount).toBe(IN);
  });

  it('fremder Empfänger, falsche Tokens, andere Menge → verweigert', () => {
    expect(() => assertKyberSwap(kyberSwapCalldata({ ...good, dstReceiver: THIEF }), IN, expectBuy)).toThrow(/Empfänger/);
    expect(() => assertKyberSwap(kyberSwapCalldata({ ...good, dstToken: THIEF }), IN, expectBuy)).toThrow(/Tokens/);
    expect(() => assertKyberSwap(kyberSwapCalldata({ ...good, amount: IN * 2n }), IN, expectBuy)).toThrow(/Menge/);
  });

  it('Mindestmenge gesenkt, Fremdgebühren, zu viel ETH mitgeschickt → verweigert', () => {
    expect(() => assertKyberSwap(kyberSwapCalldata({ ...good, minReturnAmount: 0n }), IN, expectBuy)).toThrow(/Mindestmenge/);
    expect(() => assertKyberSwap(kyberSwapCalldata({ ...good, feeReceivers: [THIEF], feeAmounts: [IN] }), IN, expectBuy)).toThrow(/Fremdgebühren/);
    expect(() => assertKyberSwap(kyberSwapCalldata(good), IN * 10n, expectBuy)).toThrow(/mitgeschickter Betrag/);
    // Token-Verkauf darf kein ETH mitschicken
    const sell = { ...expectBuy, srcToken: USDC, dstToken: EVM_NATIVE, amountIn: 30_000_000n, minOut: 1n, nativeIn: false };
    expect(() => assertKyberSwap(kyberSwapCalldata({ srcToken: USDC, dstToken: EVM_NATIVE, dstReceiver: ME, amount: 30_000_000n, minReturnAmount: 1n }), 1n, sell)).toThrow(/mitgeschickter Betrag/);
  });

  it('Teilausführung erlaubt; swapSimpleMode mit nativem Eingang → verweigert; swapSimpleMode beim Token-Verkauf erlaubt', () => {
    expect(() => assertKyberSwap(kyberSwapCalldata({ ...good, flags: 0x01n }), IN, expectBuy)).toThrow(/Teilausführung/);
    expect(() => assertKyberSwap(kyberSwapCalldata({ ...good, simple: true }), IN, expectBuy)).toThrow(/natives Guthaben/);
    const sell = { ...expectBuy, srcToken: USDC, dstToken: EVM_NATIVE, amountIn: 30_000_000n, minOut: 1n, nativeIn: false };
    expect(() => assertKyberSwap(kyberSwapCalldata({ srcToken: USDC, dstToken: EVM_NATIVE, dstReceiver: ME, amount: 30_000_000n, minReturnAmount: 1n, simple: true }), 0n, sell)).not.toThrow();
  });

  it('unbekannte Funktion (z. B. approve/transfer) → verweigert', () => {
    expect(() => assertKyberSwap('0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead0000000000000000000000000000000000000000000000000000000000000001', 0n, expectBuy)).toThrow(/nicht lesbar/);
  });
});
