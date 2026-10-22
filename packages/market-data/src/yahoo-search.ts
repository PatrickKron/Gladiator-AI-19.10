/**
 * Yahoo-Suche (query2.finance.yahoo.com/v1/finance/search) — Aktien, ETF, Forex, Indizes
 * und Rohstoffe per Name oder Ticker OHNE API-Key (derselbe öffentliche JSON-Weg wie der
 * v8-Chart-Endpoint, Patricks bevorzugter Weg; Mängelliste 2026-10-22, Punkt 3). Nur echte
 * Treffer; Krypto bleibt draußen (dafür gibt es Binance), Optionen ebenso.
 */

export type StockHitType = 'EQUITY' | 'ETF' | 'CURRENCY' | 'INDEX' | 'FUTURE' | 'MUTUALFUND';

export type StockHit = { symbol: string; name: string; type: StockHitType; exchange: string };

const TYPES = new Set<string>(['EQUITY', 'ETF', 'CURRENCY', 'INDEX', 'FUTURE', 'MUTUALFUND']);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

type YahooQuoteHit = { symbol?: string; shortname?: string; longname?: string; quoteType?: string; exchange?: string; exchDisp?: string };

/** Pur: Yahoo-Antwort → Treffer (Reihenfolge wie Yahoo, Doppelte raus, nur bekannte Typen). */
export function parseYahooSearch(json: unknown, limit = 10): StockHit[] {
  const quotes = (json as { quotes?: YahooQuoteHit[] } | null)?.quotes;
  if (!Array.isArray(quotes)) return [];
  const seen = new Set<string>();
  const out: StockHit[] = [];
  for (const q of quotes) {
    const symbol = typeof q?.symbol === 'string' ? q.symbol.trim().toUpperCase() : '';
    const type = typeof q?.quoteType === 'string' ? q.quoteType.toUpperCase() : '';
    if (!symbol || !TYPES.has(type) || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ symbol, name: String(q.shortname ?? q.longname ?? symbol), type: type as StockHitType, exchange: String(q.exchDisp ?? q.exchange ?? '') });
    if (out.length >= limit) break;
  }
  return out;
}

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; hits: StockHit[] }>();

/** Live-Suche bei Yahoo (10 min je Suchwort gemerkt). Fehler werden geworfen, nie geraten. */
export async function searchYahoo(query: string, limit = 10, fetchFn: typeof fetch = fetch): Promise<StockHit[]> {
  const q = query.trim();
  if (!q) return [];
  const key = `${q.toLowerCase()}|${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.hits;
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=${Math.min(25, limit * 2)}&newsCount=0&listsCount=0&enableFuzzyQuery=false`;
  const res = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Yahoo-Suche HTTP ${res.status}`);
  const hits = parseYahooSearch(await res.json(), limit);
  cache.set(key, { at: Date.now(), hits });
  return hits;
}

/** Nur für Tests. */
export function resetYahooSearchCache(): void {
  cache.clear();
}
