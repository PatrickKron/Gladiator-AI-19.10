/**
 * Client-seitige Asset-Suche für die Command-Palette (P1.5). Rein & testbar:
 * filtert/rankt eine einmal geladene Asset-Liste nach Ticker/Name.
 */

export type SearchableAsset = { ticker: string; name: string };

/** Rang: exakter Ticker < Ticker-Präfix < Ticker enthält < Name enthält < (kein Treffer). */
function score(a: SearchableAsset, q: string): number {
  const ticker = a.ticker.toLowerCase();
  const name = a.name.toLowerCase();
  if (ticker === q) return 0;
  if (ticker.startsWith(q)) return 1;
  if (ticker.includes(q)) return 2;
  if (name.includes(q)) return 3;
  return Number.POSITIVE_INFINITY;
}

/**
 * Rankt Assets für die Eingabe `query`. Leere Eingabe → die ersten `limit`
 * (Reihenfolge der Liste). Sonst nur Treffer, beste zuerst; bei Gleichstand
 * alphabetisch nach Ticker.
 */
export function rankAssets<T extends SearchableAsset>(assets: T[], query: string, limit = 50): T[] {
  const q = query.trim().toLowerCase();
  if (q === '') return assets.slice(0, limit);
  return assets
    .map((a) => ({ a, s: score(a, q) }))
    .filter((x) => Number.isFinite(x.s))
    .sort((x, y) => x.s - y.s || x.a.ticker.localeCompare(y.a.ticker))
    .slice(0, limit)
    .map((x) => x.a);
}
