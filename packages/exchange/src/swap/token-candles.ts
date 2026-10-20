import type { SwapChainId } from './chains.js';

/**
 * Kerzen eines Token-Pools für den Chart im Swap-Ticket (Vision-Punkt 5):
 * öffentliche GeckoTerminal-API (ohne Schlüssel), Pool aus DexScreener.
 * Nur echte Kerzen; leer, wenn der Pool (noch) keine hat — nie aufgefüllt.
 */

export const GECKOTERMINAL_API = 'https://api.geckoterminal.com/api/v2';

/** Netzwerk-Kennungen bei GeckoTerminal. */
const GT_NETWORK: Record<SwapChainId, string> = { solana: 'solana', ethereum: 'eth', base: 'base', arbitrum: 'arbitrum', bsc: 'bsc' };

export const TOKEN_CHART_TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'] as const;
export type TokenChartTf = (typeof TOKEN_CHART_TIMEFRAMES)[number];

const TF: Record<TokenChartTf, { unit: 'minute' | 'hour' | 'day'; aggregate: number }> = {
  '5m': { unit: 'minute', aggregate: 5 },
  '15m': { unit: 'minute', aggregate: 15 },
  '1h': { unit: 'hour', aggregate: 1 },
  '4h': { unit: 'hour', aggregate: 4 },
  '1d': { unit: 'day', aggregate: 1 },
};

export type TokenCandle = { time: number; open: number; high: number; low: number; close: number; volume: number };

/** GeckoTerminal-Liste [ts, o, h, l, c, v] (neueste zuerst) → aufsteigend, ungültige Zeilen raus, ohne doppelte Zeiten. */
export function parseOhlcvList(list: unknown): TokenCandle[] {
  if (!Array.isArray(list)) return [];
  const out = new Map<number, TokenCandle>();
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [t, o, h, l, c, v] = row.map(Number);
    if (![t, o, h, l, c].every((x) => Number.isFinite(x!)) || o! <= 0 || h! < l!) continue;
    out.set(t!, { time: t!, open: o!, high: h!, low: l!, close: c!, volume: Number.isFinite(v!) ? v! : 0 });
  }
  return [...out.values()].sort((a, b) => a.time - b.time);
}

export async function fetchTokenCandles(
  chain: SwapChainId,
  pool: string,
  tf: TokenChartTf,
  fetchFn: typeof fetch = fetch,
): Promise<TokenCandle[]> {
  const { unit, aggregate } = TF[tf];
  const url = `${GECKOTERMINAL_API}/networks/${GT_NETWORK[chain]}/pools/${pool}/ohlcv/${unit}?aggregate=${aggregate}&limit=300&currency=usd&token=base`;
  const res = await fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GeckoTerminal: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { attributes?: { ohlcv_list?: unknown } } };
  return parseOhlcvList(body.data?.attributes?.ohlcv_list);
}

