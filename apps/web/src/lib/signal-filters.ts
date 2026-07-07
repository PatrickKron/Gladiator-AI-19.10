/**
 * Signal-Filter ⇄ URL-Hash (P1.7): serialisiert den Filterzustand in den Hash,
 * damit ein Reload die Filter behält. Rein & testbar; nur Nicht-Default-Werte
 * landen im Query (kurze, saubere URLs).
 */

export type SignalFilters = {
  status: string;
  source: string;
  symbol: string;
  timeframe: string;
  setupType: string;
  direction: string;
  favoritesOnly: boolean;
};

export const DEFAULT_FILTERS: SignalFilters = {
  status: 'new',
  source: 'all',
  symbol: 'all',
  timeframe: 'all',
  setupType: 'all',
  direction: 'all',
  favoritesOnly: false,
};

const STRING_KEYS = ['status', 'source', 'symbol', 'timeframe', 'setupType', 'direction'] as const;

/** Query-String (ohne führendes „?") — nur Werte, die vom Default abweichen. */
export function encodeFilters(f: SignalFilters): string {
  const p = new URLSearchParams();
  for (const k of STRING_KEYS) {
    if (f[k] !== DEFAULT_FILTERS[k]) p.set(k, f[k]);
  }
  if (f.favoritesOnly) p.set('fav', '1');
  return p.toString();
}

/** Liest Filter aus einem Location-Hash; fehlende Werte → Default. */
export function decodeFilters(hash: string): SignalFilters {
  const q = hash.indexOf('?');
  const p = new URLSearchParams(q >= 0 ? hash.slice(q + 1) : '');
  const out = { ...DEFAULT_FILTERS };
  for (const k of STRING_KEYS) {
    const v = p.get(k);
    if (v) out[k] = v;
  }
  out.favoritesOnly = p.get('fav') === '1';
  return out;
}

/** Anzahl aktiver „erweiterter" Filter (ohne die Schnell-Toggles Status/Favoriten). */
export function advancedFilterCount(f: SignalFilters): number {
  return (['source', 'symbol', 'timeframe', 'setupType', 'direction'] as const).filter((k) => f[k] !== 'all').length;
}
