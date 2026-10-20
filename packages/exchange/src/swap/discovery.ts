import { SWAP_CHAINS, type SwapChainId } from './chains.js';
import { GECKOTERMINAL_API } from './token-candles.js';

/**
 * Token entdecken (Vision-Punkt 5, „wie Trojan“): Trend-Pools und neue Pools
 * je Kette aus der öffentlichen GeckoTerminal-API (ohne Schlüssel). Nur
 * gemessene Werte; was fehlt, bleibt null. Pools, deren Basis der native
 * Token selbst ist (z. B. SOL/USDC), werden ausgelassen — gesucht sind Tokens
 * zum Kaufen. Kein Kaufsignal: Sicherheitscheck + Gate laufen im Ticket.
 */

export const DISCOVERY_KINDS = ['trending', 'new'] as const;
export type DiscoveryKind = (typeof DISCOVERY_KINDS)[number];

const GT_NETWORK: Record<SwapChainId, string> = { solana: 'solana', ethereum: 'eth', base: 'base', arbitrum: 'arbitrum', bsc: 'bsc' };

export type DiscoveredToken = {
  /** Token-Adresse (Basis-Token des Pools) */
  address: string;
  symbol: string;
  name: string | null;
  imageUrl: string | null;
  pool: string;
  dex: string | null;
  priceUsd: number | null;
  change1hPct: number | null;
  change24hPct: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  buys24h: number | null;
  sells24h: number | null;
  poolCreatedAt: string | null;
};

type GtPool = {
  attributes?: {
    address?: string;
    base_token_price_usd?: string | null;
    reserve_in_usd?: string | null;
    fdv_usd?: string | null;
    market_cap_usd?: string | null;
    pool_created_at?: string | null;
    price_change_percentage?: { h1?: string | null; h24?: string | null };
    volume_usd?: { h24?: string | null };
    transactions?: { h24?: { buys?: number; sells?: number } };
  };
  relationships?: { base_token?: { data?: { id?: string } }; dex?: { data?: { id?: string } } };
};
type GtIncluded = { id?: string; type?: string; attributes?: { address?: string; name?: string; symbol?: string; image_url?: string | null } };

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** GeckoTerminal-Antwort → Tokens (rein, getestet). Jeder Token nur einmal (liquidester Pool zuerst in der Liste gewinnt). */
export function parseDiscovery(chain: SwapChainId, body: unknown): DiscoveredToken[] {
  const b = body as { data?: GtPool[]; included?: GtIncluded[] } | null;
  const tokens = new Map<string, GtIncluded['attributes']>();
  for (const inc of b?.included ?? []) if (inc.type === 'token' && inc.id) tokens.set(inc.id, inc.attributes);
  const native = SWAP_CHAINS[chain].wrappedNative.toLowerCase();
  const evm = SWAP_CHAINS[chain].kind === 'evm';
  const out: DiscoveredToken[] = [];
  const seen = new Set<string>();
  for (const p of b?.data ?? []) {
    const a = p.attributes;
    const baseId = p.relationships?.base_token?.data?.id;
    const t = baseId ? tokens.get(baseId) : undefined;
    // Adresse aus dem Token-Eintrag, sonst aus der Kennung „<netz>_<adresse>“
    const address = t?.address ?? (baseId ? baseId.slice(baseId.indexOf('_') + 1) : undefined);
    if (!a?.address || !address) continue;
    const key = evm ? address.toLowerCase() : address;
    if (key.toLowerCase() === native || seen.has(key)) continue;
    seen.add(key);
    out.push({
      address,
      symbol: t?.symbol ?? '?',
      name: t?.name ?? null,
      imageUrl: t?.image_url && t.image_url !== 'missing.png' ? t.image_url : null,
      pool: a.address,
      dex: p.relationships?.dex?.data?.id ?? null,
      priceUsd: num(a.base_token_price_usd),
      change1hPct: num(a.price_change_percentage?.h1),
      change24hPct: num(a.price_change_percentage?.h24),
      volume24hUsd: num(a.volume_usd?.h24),
      liquidityUsd: num(a.reserve_in_usd),
      marketCapUsd: num(a.market_cap_usd) ?? num(a.fdv_usd),
      buys24h: num(a.transactions?.h24?.buys),
      sells24h: num(a.transactions?.h24?.sells),
      poolCreatedAt: a.pool_created_at ?? null,
    });
  }
  return out;
}

export async function fetchTokenDiscovery(chain: SwapChainId, kind: DiscoveryKind, fetchFn: typeof fetch = fetch): Promise<DiscoveredToken[]> {
  const path = kind === 'trending' ? 'trending_pools' : 'new_pools';
  const res = await fetchFn(`${GECKOTERMINAL_API}/networks/${GT_NETWORK[chain]}/${path}?include=base_token,dex&page=1`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GeckoTerminal: HTTP ${res.status}`);
  return parseDiscovery(chain, await res.json());
}
