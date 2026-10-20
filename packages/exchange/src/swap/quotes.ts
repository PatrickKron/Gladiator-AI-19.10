import { fromAtomic, SWAP_CHAINS, type SwapChainId, type SwapToken } from './chains.js';

/**
 * Swap-Angebote von öffentlichen Aggregatoren (keine Schlüssel nötig):
 * Solana → Jupiter (`lite-api.jup.ag`), EVM → KyberSwap. Die Angebote sind echte
 * Routen über echte Pools; `outAmount` enthält bereits Pool-Gebühren und
 * Preis-Einfluss. Gas schätzt KyberSwap in USD, bei Solana ist es vernachlässigbar
 * (Basisgebühr 5.000 Lamports) und wird als solche ausgewiesen.
 */

export const JUPITER_API = 'https://lite-api.jup.ag/swap/v1';
export const KYBER_API = 'https://aggregator-api.kyberswap.com';
const SOLANA_BASE_FEE_LAMPORTS = 5_000n;

export type SwapQuote = {
  chain: SwapChainId;
  aggregator: 'jupiter' | 'kyberswap';
  inToken: SwapToken;
  outToken: SwapToken;
  /** kleinste Einheit als String */
  inAtomic: string;
  outAtomic: string;
  /** Mindestmenge nach Slippage (kleinste Einheit) */
  minOutAtomic: string;
  inAmount: string;
  outAmount: string;
  slippageBps: number;
  priceImpactPct: number;
  /** geschätzte Netzwerkgebühr in nativer Währung (Dezimal-String) bzw. USD, falls bekannt */
  networkFeeNative: string | null;
  networkFeeUsd: number | null;
  route: string[];
  /** Roh-Antwort — für die spätere Live-Ausführung (Jupiter /swap, KyberSwap /route/build). */
  raw: unknown;
};

type Fetch = typeof fetch;

async function getJson(url: string, fetchFn: Fetch, init?: RequestInit): Promise<unknown> {
  const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as unknown;
}

function minOut(out: bigint, slippageBps: number): bigint {
  return (out * BigInt(10_000 - slippageBps)) / 10_000n;
}

export async function jupiterQuote(
  p: { inToken: SwapToken; outToken: SwapToken; inAtomic: bigint; slippageBps: number },
  fetchFn: Fetch = fetch,
): Promise<SwapQuote> {
  const qs = new URLSearchParams({
    inputMint: p.inToken.address,
    outputMint: p.outToken.address,
    amount: p.inAtomic.toString(),
    slippageBps: String(p.slippageBps),
  });
  const q = (await getJson(`${JUPITER_API}/quote?${qs}`, fetchFn)) as {
    inAmount?: string;
    outAmount?: string;
    otherAmountThreshold?: string;
    priceImpactPct?: string;
    routePlan?: { swapInfo?: { label?: string } }[];
    error?: string;
  };
  if (!q.outAmount || !q.inAmount) throw new Error(`Jupiter: keine Route (${q.error ?? 'leere Antwort'}).`);
  return {
    chain: 'solana',
    aggregator: 'jupiter',
    inToken: p.inToken,
    outToken: p.outToken,
    inAtomic: q.inAmount,
    outAtomic: q.outAmount,
    minOutAtomic: q.otherAmountThreshold ?? minOut(BigInt(q.outAmount), p.slippageBps).toString(),
    inAmount: fromAtomic(q.inAmount, p.inToken.decimals),
    outAmount: fromAtomic(q.outAmount, p.outToken.decimals),
    slippageBps: p.slippageBps,
    // Jupiter liefert einen Anteil (0.0012 = 0,12 %)
    priceImpactPct: Math.abs(Number(q.priceImpactPct ?? 0)) * 100,
    networkFeeNative: fromAtomic(SOLANA_BASE_FEE_LAMPORTS, 9),
    networkFeeUsd: null,
    route: [...new Set((q.routePlan ?? []).map((r) => r.swapInfo?.label ?? '?'))],
    raw: q,
  };
}

export async function kyberQuote(
  p: { chain: SwapChainId; inToken: SwapToken; outToken: SwapToken; inAtomic: bigint; slippageBps: number },
  fetchFn: Fetch = fetch,
): Promise<SwapQuote> {
  const slug = SWAP_CHAINS[p.chain].kyberSlug;
  if (!slug) throw new Error(`KyberSwap unterstützt ${p.chain} nicht.`);
  const qs = new URLSearchParams({ tokenIn: p.inToken.address, tokenOut: p.outToken.address, amountIn: p.inAtomic.toString() });
  const r = (await getJson(`${KYBER_API}/${slug}/api/v1/routes?${qs}`, fetchFn, {
    headers: { 'x-client-id': 'gladiator' },
  })) as {
    code?: number;
    message?: string;
    data?: {
      routeSummary?: {
        amountIn: string;
        amountOut: string;
        amountInUsd?: string;
        amountOutUsd?: string;
        gasUsd?: string;
        route?: { exchange?: string }[][];
      };
      routerAddress?: string;
    };
  };
  const s = r.data?.routeSummary;
  if (r.code !== 0 || !s) throw new Error(`KyberSwap: keine Route (${r.message ?? 'leere Antwort'}).`);
  const inUsd = Number(s.amountInUsd);
  const outUsd = Number(s.amountOutUsd);
  // Preis-Einfluss aus den USD-Werten der Route (Pool-Gebühren eingeschlossen)
  const impact = inUsd > 0 && Number.isFinite(outUsd) ? Math.max(0, ((inUsd - outUsd) / inUsd) * 100) : Number.NaN;
  return {
    chain: p.chain,
    aggregator: 'kyberswap',
    inToken: p.inToken,
    outToken: p.outToken,
    inAtomic: s.amountIn,
    outAtomic: s.amountOut,
    minOutAtomic: minOut(BigInt(s.amountOut), p.slippageBps).toString(),
    inAmount: fromAtomic(s.amountIn, p.inToken.decimals),
    outAmount: fromAtomic(s.amountOut, p.outToken.decimals),
    slippageBps: p.slippageBps,
    priceImpactPct: impact,
    networkFeeNative: null,
    networkFeeUsd: s.gasUsd !== undefined && Number.isFinite(Number(s.gasUsd)) ? Number(s.gasUsd) : null,
    route: [...new Set((s.route ?? []).flat().map((h) => h.exchange ?? '?'))],
    raw: r.data,
  };
}

export async function fetchSwapQuote(
  p: { chain: SwapChainId; inToken: SwapToken; outToken: SwapToken; inAtomic: bigint; slippageBps: number },
  fetchFn: Fetch = fetch,
): Promise<SwapQuote> {
  if (p.inAtomic <= 0n) throw new Error('Betrag muss größer als 0 sein.');
  return SWAP_CHAINS[p.chain].aggregator === 'jupiter' ? jupiterQuote(p, fetchFn) : kyberQuote(p, fetchFn);
}
