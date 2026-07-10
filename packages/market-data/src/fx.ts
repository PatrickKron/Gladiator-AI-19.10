/**
 * EUR/USD-Kurs für die Vermögens-/Trade-Anzeige in Euro.
 * Quelle: Binance EURUSDT (echter, keyless Spot-Kurs — EUR-Stablecoin-Paar
 * mit hoher Liquidität). Kein Kurs verfügbar ⇒ ehrlich null, NIE erfunden.
 * fetch ist injizierbar (Repo-Muster: Kern ohne Netz testbar).
 */

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const BINANCE_EURUSDT = 'https://api.binance.com/api/v3/ticker/price?symbol=EURUSDT';
const CACHE_MS = 60_000;

let cache: { rate: number; at: number } | null = null;

/** Nur für Tests: Cache zurücksetzen. */
export function resetFxCache(): void {
  cache = null;
}

/**
 * Aktueller EUR→USD-Kurs (1 EUR = x USD) oder null, wenn die Quelle nicht
 * erreichbar/plausibel ist. 60s-Cache gegen Rate-Limits.
 */
export async function getEurUsdRate(fetchImpl: FetchLike = fetch, now = Date.now()): Promise<number | null> {
  if (cache && now - cache.at < CACHE_MS) return cache.rate;
  try {
    const res = await fetchImpl(BINANCE_EURUSDT);
    if (!res.ok) return null;
    const body = (await res.json()) as { price?: string };
    const rate = Number(body.price);
    // Plausibilität: EUR/USD hat sich historisch zwischen ~0.8 und ~1.6 bewegt.
    // Alles außerhalb ist ein Datenfehler — ehrlich null statt Müll-Umrechnung.
    if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) return null;
    cache = { rate, at: now };
    return rate;
  } catch {
    return null;
  }
}

/** USD → EUR mit echtem Kurs; null wenn kein Kurs (Aufrufer zeigt ehrlich „nicht verfügbar"). */
export function usdToEur(usd: number, eurUsdRate: number | null): number | null {
  if (eurUsdRate === null || eurUsdRate <= 0) return null;
  return usd / eurUsdRate;
}

/** EUR → USD mit echtem Kurs; null wenn kein Kurs. */
export function eurToUsd(eur: number, eurUsdRate: number | null): number | null {
  if (eurUsdRate === null || eurUsdRate <= 0) return null;
  return eur * eurUsdRate;
}
