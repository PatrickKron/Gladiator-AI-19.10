/**
 * Swap-Gate (Vision-Punkt 5, Freigabe Patrick 2026-10-20): Spot-Swaps über
 * Aggregatoren (Jupiter, KyberSwap) sind erlaubt. Hart verboten bleibt jede
 * Überweisung: Der Empfänger eines Swaps MUSS die eigene Wallet sein.
 * Alle anderen Grenzen sind je Wallet frei einstellbar (Profi bis Meme-Coin).
 */

export type SwapLimits = {
  /** Höchster Wert eines einzelnen Swaps in USD. */
  maxTradeUsd: number;
  /** Höchste erlaubte Slippage-Toleranz (Basispunkte, 100 = 1 %). */
  maxSlippageBps: number;
  /** Höchster Preis-Einfluss laut Aggregator-Route in %. */
  maxPriceImpactPct: number;
  /** Mindest-Liquidität des Tokens (größter Pool) in USD; 0 = egal. */
  minLiquidityUsd: number;
};

export const SWAP_LIMIT_BOUNDS: Record<keyof SwapLimits, { min: number; max: number }> = {
  maxTradeUsd: { min: 1, max: 1_000_000 },
  maxSlippageBps: { min: 1, max: 5_000 },
  maxPriceImpactPct: { min: 0.1, max: 50 },
  minLiquidityUsd: { min: 0, max: 100_000_000 },
};

export type SwapProfileId = 'vorsichtig' | 'standard' | 'meme';

export const SWAP_PROFILES: { id: SwapProfileId; limits: SwapLimits }[] = [
  { id: 'vorsichtig', limits: { maxTradeUsd: 250, maxSlippageBps: 50, maxPriceImpactPct: 1, minLiquidityUsd: 1_000_000 } },
  { id: 'standard', limits: { maxTradeUsd: 1_000, maxSlippageBps: 100, maxPriceImpactPct: 3, minLiquidityUsd: 100_000 } },
  { id: 'meme', limits: { maxTradeUsd: 500, maxSlippageBps: 1_500, maxPriceImpactPct: 15, minLiquidityUsd: 5_000 } },
];

export const DEFAULT_SWAP_LIMITS: SwapLimits = SWAP_PROFILES.find((p) => p.id === 'standard')!.limits;

export type SwapIntent = {
  owner: string;
  recipient: string;
  valueUsd: number;
  slippageBps: number;
  priceImpactPct: number;
  /** Größter Pool des Tokens in USD; null = unbekannt. */
  liquidityUsd: number | null;
};

export type SwapRejectReason =
  | 'recipient_not_owner'
  | 'invalid_amount'
  | 'trade_above_limit'
  | 'slippage_above_limit'
  | 'price_impact_above_limit'
  | 'liquidity_below_limit'
  | 'liquidity_unknown';

export type SwapVerdict = { allowed: boolean; reasons: SwapRejectReason[] };

function sameAddress(a: string, b: string): boolean {
  // EVM-Adressen sind case-insensitiv, Solana-Adressen (base58) nicht
  return a.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function judgeSwap(intent: SwapIntent, limits: SwapLimits): SwapVerdict {
  const reasons: SwapRejectReason[] = [];
  if (!sameAddress(intent.owner, intent.recipient)) reasons.push('recipient_not_owner');
  if (!(intent.valueUsd > 0)) reasons.push('invalid_amount');
  else if (intent.valueUsd > limits.maxTradeUsd) reasons.push('trade_above_limit');
  if (!(intent.slippageBps > 0) || intent.slippageBps > limits.maxSlippageBps) reasons.push('slippage_above_limit');
  if (!(intent.priceImpactPct >= 0) || intent.priceImpactPct > limits.maxPriceImpactPct) reasons.push('price_impact_above_limit');
  if (limits.minLiquidityUsd > 0) {
    if (intent.liquidityUsd === null) reasons.push('liquidity_unknown');
    else if (intent.liquidityUsd < limits.minLiquidityUsd) reasons.push('liquidity_below_limit');
  }
  return { allowed: reasons.length === 0, reasons };
}
