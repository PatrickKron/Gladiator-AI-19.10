import { describe, expect, it } from 'vitest';
import { judgeSwap, SWAP_LIMIT_BOUNDS, SWAP_PROFILES, type SwapIntent, type SwapLimits } from './swap-gate.js';

const LIMITS: SwapLimits = { maxTradeUsd: 500, maxSlippageBps: 300, maxPriceImpactPct: 5, minLiquidityUsd: 20_000, maxTokenTaxPct: 5 };
const OK: SwapIntent = {
  owner: 'Wallet1',
  recipient: 'Wallet1',
  valueUsd: 100,
  slippageBps: 100,
  priceImpactPct: 0.4,
  liquidityUsd: 1_000_000,
};

describe('judgeSwap (Vision-Punkt 5: Spot-Swaps, Patrick 2026-10-20)', () => {
  it('normaler Swap innerhalb aller Grenzen → erlaubt', () => {
    expect(judgeSwap(OK, LIMITS)).toEqual({ allowed: true, reasons: [] });
  });

  it('Empfänger ≠ eigene Wallet → IMMER verweigert (Swap darf nie zur Überweisung werden)', () => {
    const v = judgeSwap({ ...OK, recipient: 'Fremd' }, LIMITS);
    expect(v.allowed).toBe(false);
    expect(v.reasons).toContain('recipient_not_owner');
  });

  it('Empfänger-Vergleich bei EVM ohne Groß-/Kleinschreibung', () => {
    expect(judgeSwap({ ...OK, owner: '0xAbC', recipient: '0xabc' }, LIMITS).allowed).toBe(true);
  });

  it('jede Grenze greift einzeln', () => {
    expect(judgeSwap({ ...OK, valueUsd: 501 }, LIMITS).reasons).toEqual(['trade_above_limit']);
    expect(judgeSwap({ ...OK, slippageBps: 301 }, LIMITS).reasons).toEqual(['slippage_above_limit']);
    expect(judgeSwap({ ...OK, priceImpactPct: 5.1 }, LIMITS).reasons).toEqual(['price_impact_above_limit']);
    expect(judgeSwap({ ...OK, liquidityUsd: 19_999 }, LIMITS).reasons).toEqual(['liquidity_below_limit']);
  });

  it('unbekannte Liquidität → verweigert, sobald eine Mindest-Liquidität verlangt ist', () => {
    expect(judgeSwap({ ...OK, liquidityUsd: null }, LIMITS).reasons).toEqual(['liquidity_unknown']);
    expect(judgeSwap({ ...OK, liquidityUsd: null }, { ...LIMITS, minLiquidityUsd: 0 }).allowed).toBe(true);
  });

  it('kaputte Werte (NaN, negativ, 0) werden nie durchgewunken', () => {
    expect(judgeSwap({ ...OK, valueUsd: Number.NaN }, LIMITS).reasons).toContain('invalid_amount');
    expect(judgeSwap({ ...OK, valueUsd: 0 }, LIMITS).reasons).toContain('invalid_amount');
    expect(judgeSwap({ ...OK, priceImpactPct: Number.NaN }, LIMITS).reasons).toContain('price_impact_above_limit');
  });

  it('Token-Sicherheit: schwere Befunde blockieren Käufe immer, Steuer nach eigener Grenze', () => {
    expect(judgeSwap({ ...OK, safety: { severe: ['honeypot'], taxPct: 0 } }, LIMITS).reasons).toEqual(['token_unsafe']);
    expect(judgeSwap({ ...OK, safety: { severe: [], taxPct: 6 } }, LIMITS).reasons).toEqual(['token_tax_above_limit']);
    expect(judgeSwap({ ...OK, safety: { severe: [], taxPct: 6 } }, { ...LIMITS, maxTokenTaxPct: 10 }).allowed).toBe(true);
    // Check nicht verfügbar → kein Block (Hinweis zeigt die Oberfläche)
    expect(judgeSwap({ ...OK, safety: null }, LIMITS).allowed).toBe(true);
  });

  it('Verkauf: raus muss immer gehen — keine Prüfung auf Liquidität, Sicherheit, Steuer', () => {
    const sell = { ...OK, side: 'sell' as const, liquidityUsd: 10, safety: { severe: ['honeypot'], taxPct: 50 } };
    expect(judgeSwap(sell, LIMITS)).toEqual({ allowed: true, reasons: [] });
    // Betrag, Slippage und Empfänger gelten auch beim Verkauf
    expect(judgeSwap({ ...sell, recipient: 'Fremd' }, LIMITS).reasons).toContain('recipient_not_owner');
    expect(judgeSwap({ ...sell, slippageBps: 301 }, LIMITS).reasons).toContain('slippage_above_limit');
  });

  it('Profile liegen innerhalb der Grenzen, Meme ist lockerer als Vorsichtig', () => {
    for (const p of SWAP_PROFILES) {
      for (const [k, b] of Object.entries(SWAP_LIMIT_BOUNDS)) {
        const v = p.limits[k as keyof SwapLimits];
        expect(v).toBeGreaterThanOrEqual(b.min);
        expect(v).toBeLessThanOrEqual(b.max);
      }
    }
    const careful = SWAP_PROFILES.find((p) => p.id === 'vorsichtig')!.limits;
    const meme = SWAP_PROFILES.find((p) => p.id === 'meme')!.limits;
    expect(meme.maxSlippageBps).toBeGreaterThan(careful.maxSlippageBps);
    expect(meme.minLiquidityUsd).toBeLessThan(careful.minLiquidityUsd);
  });
});
