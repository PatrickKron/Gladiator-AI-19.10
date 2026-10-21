import { isNativeToken, rpcUrl, SWAP_CHAINS, type SwapChainId, type SwapToken } from './chains.js';

/**
 * Token-Infos für das Swap-Ticket (Vision-Punkt 5, „wie Trojan"): Preis,
 * Liquidität, Marktkapitalisierung, 24-h-Änderung aus DexScreener (öffentlich,
 * ohne Schlüssel); Nachkommastellen direkt von der Kette (RPC), damit Beträge
 * exakt umgerechnet werden. Fehlt etwas, steht es als null da — nie geschätzt.
 */

export const DEXSCREENER_API = 'https://api.dexscreener.com';

export type TokenInfo = SwapToken & {
  chain: SwapChainId;
  name: string | null;
  priceUsd: number | null;
  /** größter Pool (USD) */
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  change24hPct: number | null;
  pairUrl: string | null;
  /** Adresse des liquidesten Pools (für Kerzen über GeckoTerminal) */
  pairAddress: string | null;
  dex: string | null;
  pairCreatedAt: string | null;
  imageUrl: string | null;
};

type Fetch = typeof fetch;

type DexPair = {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  url?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  /** usd = Gegenwert; base/quote = Token-Mengen im Pool */
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  pairCreatedAt?: number;
  info?: { imageUrl?: string };
};

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/** Wählt aus den DexScreener-Paaren den liquidesten Pool, in dem der Token Basis-Token ist. */
export function pickBestPair(pairs: DexPair[], chain: SwapChainId, address: string): DexPair | null {
  const evm = SWAP_CHAINS[chain].kind === 'evm';
  const same = (a?: string) => (a ? (evm ? a.toLowerCase() === address.toLowerCase() : a === address) : false);
  const own = pairs.filter((p) => p.chainId === SWAP_CHAINS[chain].dexscreenerId && same(p.baseToken?.address));
  return own.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null;
}

export async function fetchDexPairs(chain: SwapChainId, address: string, fetchFn: Fetch = fetch): Promise<DexPair[]> {
  const res = await fetchFn(`${DEXSCREENER_API}/tokens/v1/${SWAP_CHAINS[chain].dexscreenerId}/${address}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`DexScreener: HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? (body as DexPair[]) : [];
}

async function rpc(chain: SwapChainId, method: string, params: unknown[], fetchFn: Fetch): Promise<unknown> {
  const res = await fetchFn(rpcUrl(chain), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`RPC ${chain}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`RPC ${chain}: ${body.error.message ?? 'Fehler'}`);
  return body.result;
}

/** Nachkommastellen eines Tokens direkt von der Kette. */
export async function fetchTokenDecimals(chain: SwapChainId, address: string, fetchFn: Fetch = fetch): Promise<number> {
  if (isNativeToken(chain, address)) return SWAP_CHAINS[chain].native.decimals;
  if (SWAP_CHAINS[chain].kind === 'solana') {
    const r = (await rpc(chain, 'getTokenSupply', [address], fetchFn)) as { value?: { decimals?: number } };
    const d = r?.value?.decimals;
    if (typeof d !== 'number') throw new Error('Solana: kein SPL-Token unter dieser Adresse.');
    return d;
  }
  // ERC-20 decimals() = 0x313ce567
  const hex = (await rpc(chain, 'eth_call', [{ to: address, data: '0x313ce567' }, 'latest'], fetchFn)) as string;
  if (typeof hex !== 'string' || hex === '0x') throw new Error('Kein ERC-20-Token unter dieser Adresse.');
  const d = Number(BigInt(hex));
  if (!Number.isInteger(d) || d > 36) throw new Error('Ungültige Nachkommastellen.');
  return d;
}

export async function fetchTokenInfo(chain: SwapChainId, address: string, fetchFn: Fetch = fetch): Promise<TokenInfo> {
  const native = isNativeToken(chain, address);
  const lookup = native ? SWAP_CHAINS[chain].wrappedNative : address;
  const [decimals, pairs] = await Promise.all([fetchTokenDecimals(chain, address, fetchFn), fetchDexPairs(chain, lookup, fetchFn)]);
  const best = pickBestPair(pairs, chain, lookup);
  return {
    chain,
    address,
    decimals,
    symbol: native ? SWAP_CHAINS[chain].native.symbol : (best?.baseToken?.symbol ?? '?'),
    name: native ? SWAP_CHAINS[chain].native.symbol : (best?.baseToken?.name ?? null),
    priceUsd: num(best?.priceUsd),
    liquidityUsd: num(best?.liquidity?.usd),
    marketCapUsd: num(best?.marketCap ?? best?.fdv),
    volume24hUsd: num(best?.volume?.h24),
    change24hPct: num(best?.priceChange?.h24),
    pairUrl: best?.url ?? null,
    pairAddress: best?.pairAddress ?? null,
    dex: best?.dexId ?? null,
    pairCreatedAt: best?.pairCreatedAt ? new Date(best.pairCreatedAt).toISOString() : null,
    imageUrl: best?.info?.imageUrl ?? null,
  };
}

/**
 * Pool-Tiefe √(Basis-Menge × Quote-Menge) je Pool-Adresse (DexScreener
 * `latest/dex/pairs`, bis 30 je Abruf). Anders als die USD-Liquidität bleibt sie
 * bei normalem Handel gleich (konstantes Produkt) und fällt nur, wenn Liquidität
 * ABGEZOGEN wird — genau das Signal eines Rugs. Fehlt ein Pool in der Antwort,
 * fehlt er im Ergebnis (nie 0 geraten).
 */
export async function fetchPairDepths(chain: SwapChainId, pairAddresses: string[], fetchFn: Fetch = fetch): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(pairAddresses)];
  for (let i = 0; i < unique.length; i += 30) {
    const batch = unique.slice(i, i + 30);
    const res = await fetchFn(`${DEXSCREENER_API}/latest/dex/pairs/${SWAP_CHAINS[chain].dexscreenerId}/${batch.join(',')}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`DexScreener: HTTP ${res.status}`);
    const body = (await res.json()) as { pairs?: DexPair[] | null };
    for (const p of body.pairs ?? []) {
      const base = num(p.liquidity?.base);
      const quote = num(p.liquidity?.quote);
      const addr = batch.find((a) => (SWAP_CHAINS[chain].kind === 'evm' ? a.toLowerCase() === p.pairAddress?.toLowerCase() : a === p.pairAddress));
      if (addr && base !== null && quote !== null && base >= 0 && quote >= 0) out.set(addr, Math.sqrt(base * quote));
    }
  }
  return out;
}

/** Preis + Liquidität des liquidesten Pools je Token (ein DexScreener-Abruf je 30 Tokens). */
export async function fetchTokenMarket(
  chain: SwapChainId,
  addresses: string[],
  fetchFn: Fetch = fetch,
): Promise<Map<string, { priceUsd: number; liquidityUsd: number | null }>> {
  const out = new Map<string, { priceUsd: number; liquidityUsd: number | null }>();
  const lookups = addresses.map((a) => (isNativeToken(chain, a) ? SWAP_CHAINS[chain].wrappedNative : a));
  for (let i = 0; i < lookups.length; i += 30) {
    const batch = [...new Set(lookups.slice(i, i + 30))];
    const res = await fetchFn(`${DEXSCREENER_API}/tokens/v1/${SWAP_CHAINS[chain].dexscreenerId}/${batch.join(',')}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`DexScreener: HTTP ${res.status}`);
    const pairs = ((await res.json()) as DexPair[]) ?? [];
    for (const lookup of batch) {
      const best = pickBestPair(pairs, chain, lookup);
      const p = num(best?.priceUsd);
      if (p === null) continue;
      const liquidityUsd = num(best?.liquidity?.usd);
      addresses.forEach((a, idx) => {
        if (lookups[idx] === lookup) out.set(a, { priceUsd: p, liquidityUsd });
      });
    }
  }
  return out;
}

export async function fetchTokenPrices(chain: SwapChainId, addresses: string[], fetchFn: Fetch = fetch): Promise<Map<string, number>> {
  const market = await fetchTokenMarket(chain, addresses, fetchFn);
  return new Map([...market].map(([a, m]) => [a, m.priceUsd]));
}
