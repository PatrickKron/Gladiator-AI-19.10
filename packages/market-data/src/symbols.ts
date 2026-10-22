import { withBinancePublic } from './binance-public.js';

/**
 * Alle handelbaren Binance-Spot-Paare gegen USDT (Patricks Mängelliste 2026-10-22, Punkt 3):
 * das Asset-Feld soll nicht nur eine Handvoll Symbole kennen, sondern jedes Paar, für das
 * Binance öffentliche Kerzen liefert. Die Liste kommt live von der Börse (eine Stunde
 * gemerkt); gehebelte Token (UP/DOWN/BULL/BEAR) und Stablecoin-gegen-Stablecoin-Paare
 * bleiben draußen. Kerzen holt `ensureCandles` erst, wenn jemand das Symbol wählt.
 */

export type SpotPair = { symbol: string; base: string };

export type MarketLike = { symbol?: string; base?: string; quote?: string; spot?: boolean; active?: boolean };

const LEVERAGED = /(UP|DOWN|BULL|BEAR)$/;
const STABLE_OR_FIAT = new Set(['USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USD1', 'USDE', 'USDS', 'EUR', 'EURI', 'GBP', 'TRY', 'BRL', 'ARS', 'JPY', 'AUD', 'ZAR', 'UAH', 'PLN', 'RON', 'CZK', 'MXN', 'COP', 'NGN', 'RUB', 'XUSD', 'AEUR', 'PAXG']);

/** Pur: ccxt-Märkte → sortierte USDT-Spot-Paare (ohne Hebel-Token, ohne Stable/Fiat-Basis). */
export function filterSpotPairs(markets: Iterable<MarketLike | undefined>): SpotPair[] {
  const seen = new Set<string>();
  const out: SpotPair[] = [];
  for (const m of markets) {
    if (!m || m.spot === false || m.active === false) continue;
    if (m.quote !== 'USDT' || !m.base) continue;
    const base = m.base.toUpperCase();
    if (LEVERAGED.test(base) || STABLE_OR_FIAT.has(base) || seen.has(base)) continue;
    seen.add(base);
    out.push({ symbol: `${base}/USDT`, base });
  }
  out.sort((a, b) => a.base.localeCompare(b.base));
  return out;
}

/** Pur: Suche nach Basis-Ticker — „beginnt mit“ zuerst, dann „enthält“; leer = Anfang der Liste. */
export function searchSpotPairs(pairs: SpotPair[], query: string, limit = 30): SpotPair[] {
  const q = query.trim().toUpperCase().replace(/[^A-Z0-9/]/g, '');
  if (!q) return pairs.slice(0, limit);
  const base = q.split('/')[0] ?? q;
  if (!base) return pairs.slice(0, limit);
  const starts = pairs.filter((p) => p.base.startsWith(base));
  const contains = pairs.filter((p) => !p.base.startsWith(base) && p.base.includes(base));
  return [...starts, ...contains].slice(0, limit);
}

const TTL_MS = 60 * 60 * 1000;
let cache: { at: number; pairs: SpotPair[] } | null = null;

/** Live von Binance (öffentlich, auch über den Spiegel bei Standortsperre), eine Stunde gemerkt. Fehler werden geworfen, nie geraten. */
export async function listBinanceSpotPairs(fetchMarkets?: () => Promise<Iterable<MarketLike | undefined>>): Promise<SpotPair[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.pairs;
  const markets = fetchMarkets ? await fetchMarkets() : await withBinancePublic(async (ex) => Object.values(await ex.loadMarkets()) as MarketLike[]);
  const pairs = filterSpotPairs(markets);
  if (pairs.length === 0) throw new Error('Binance lieferte keine Spot-Paare');
  cache = { at: Date.now(), pairs };
  return pairs;
}

/** Nur für Tests. */
export function resetSpotPairCache(): void {
  cache = null;
}
