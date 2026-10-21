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
  /** liquidester Pool mit konstantem Produkt (nur dort taugt die Tiefe für den Rug-Schutz) */
  rugPairAddress: string | null;
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
  /** Pool-Bauart laut DexScreener, z. B. v2, v3, CLMM, DLMM */
  labels?: string[];
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

/** Pool-Bauarten mit konzentrierter Liquidität bzw. eigener Kurve (Kennzeichnung laut DexScreener). */
const NON_CP_LABELS = new Set(['v3', 'v4', 'clmm', 'dlmm', 'wp', 'whirlpool', 'dyn2', 'stable', 'slipstream']);
/** Börsen ohne Pools mit konstantem Produkt (Orca = Whirlpools; pump.fun = Bonding-Curve). */
const NON_CP_DEXES = new Set(['orca', 'pumpfun']);

/**
 * Pool mit konstantem Produkt (x·y = k)? Nur dort bleibt √(Basis × Quote) bei
 * normalem Handel gleich. In Pools mit konzentrierter Liquidität (v3/v4, CLMM,
 * DLMM) schrumpft eine Seite schon bei einem Kursrutsch — der Rug-Schutz würde
 * dort ohne Liquiditätsabzug verkaufen.
 */
export function isConstantProductPair(p: { dexId?: string; labels?: string[] }): boolean {
  if (p.dexId && NON_CP_DEXES.has(p.dexId.toLowerCase())) return false;
  return !(p.labels ?? []).some((l) => NON_CP_LABELS.has(l.toLowerCase()));
}

/** Liquidester Pool mit konstantem Produkt (Rug-Schutz); keiner → null. */
export function pickRugPair(pairs: DexPair[], chain: SwapChainId, address: string): DexPair | null {
  return pickBestPair(pairs.filter(isConstantProductPair), chain, address);
}

function depthOf(p: DexPair | null): number | null {
  const base = num(p?.liquidity?.base);
  const quote = num(p?.liquidity?.quote);
  return base !== null && quote !== null && base >= 0 && quote >= 0 ? Math.sqrt(base * quote) : null;
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
    rugPairAddress: pickRugPair(pairs, chain, lookup)?.pairAddress ?? null,
    dex: best?.dexId ?? null,
    pairCreatedAt: best?.pairCreatedAt ? new Date(best.pairCreatedAt).toISOString() : null,
    imageUrl: best?.info?.imageUrl ?? null,
  };
}

export type PoolDepth = { depth: number; liquidityUsd: number | null };

/**
 * Pool-Tiefe √(Basis-Menge × Quote-Menge) und USD-Liquidität je Pool-Adresse
 * (DexScreener `latest/dex/pairs`, bis 30 je Abruf). Anders als die USD-Liquidität
 * bleibt die Tiefe in Pools mit konstantem Produkt bei normalem Handel gleich und
 * fällt nur, wenn Liquidität ABGEZOGEN wird — genau das Signal eines Rugs. Fehlt
 * ein Pool in der Antwort, fehlt er im Ergebnis (nie 0 geraten).
 */
export async function fetchPairDepths(chain: SwapChainId, pairAddresses: string[], fetchFn: Fetch = fetch): Promise<Map<string, PoolDepth>> {
  const out = new Map<string, PoolDepth>();
  const unique = [...new Set(pairAddresses)];
  for (let i = 0; i < unique.length; i += 30) {
    const batch = unique.slice(i, i + 30);
    const res = await fetchFn(`${DEXSCREENER_API}/latest/dex/pairs/${SWAP_CHAINS[chain].dexscreenerId}/${batch.join(',')}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`DexScreener: HTTP ${res.status}`);
    const body = (await res.json()) as { pairs?: DexPair[] | null };
    for (const p of body.pairs ?? []) {
      const depth = depthOf(p);
      const addr = batch.find((a) => (SWAP_CHAINS[chain].kind === 'evm' ? a.toLowerCase() === p.pairAddress?.toLowerCase() : a === p.pairAddress));
      if (addr && depth !== null) out.set(addr, { depth, liquidityUsd: num(p.liquidity?.usd) });
    }
  }
  return out;
}

export type TokenMarket = {
  priceUsd: number;
  /** liquidester Pool mit konstantem Produkt, dessen USD-Liquidität und Tiefe √(Basis × Quote) (Rug-Schutz: Umzug erkennen) */
  liquidityUsd: number | null;
  pairAddress: string | null;
  depth: number | null;
};

/** Preis, Liquidität und liquidester Pool je Token (ein DexScreener-Abruf je 30 Tokens). */
export async function fetchTokenMarket(chain: SwapChainId, addresses: string[], fetchFn: Fetch = fetch): Promise<Map<string, TokenMarket>> {
  const out = new Map<string, TokenMarket>();
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
      const rug = pickRugPair(pairs, chain, lookup);
      const m: TokenMarket = {
        priceUsd: p,
        liquidityUsd: num(rug?.liquidity?.usd),
        pairAddress: rug?.pairAddress ?? null,
        depth: depthOf(rug),
      };
      addresses.forEach((a, idx) => {
        if (lookups[idx] === lookup) out.set(a, m);
      });
    }
  }
  return out;
}

export async function fetchTokenPrices(chain: SwapChainId, addresses: string[], fetchFn: Fetch = fetch): Promise<Map<string, number>> {
  const market = await fetchTokenMarket(chain, addresses, fetchFn);
  return new Map([...market].map(([a, m]) => [a, m.priceUsd]));
}
