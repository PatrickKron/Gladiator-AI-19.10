/**
 * Chart-Deep-Linking (P0.1): baut/parst `#/charts?symbol=ETH/USDT&tf=4h`.
 * Rein, ohne Seiteneffekte — damit jede Seite mit einem Klick in den Chart
 * eines konkreten Assets (mit Timeframe) springen kann.
 */

export const CHART_TFS = ['15m', '1h', '4h', '1d'] as const;
export type ChartTf = (typeof CHART_TFS)[number];

export function isChartTf(v: string | null | undefined): v is ChartTf {
  return v != null && (CHART_TFS as readonly string[]).includes(v);
}

/** Baut das Chart-Hash-Ziel; Symbol wird URL-enkodiert (Slash → %2F). */
export function buildChartUrl(symbol: string, tf?: string | null): string {
  const params = new URLSearchParams();
  params.set('symbol', symbol);
  if (tf) params.set('tf', tf);
  return `#/charts?${params.toString()}`;
}

/** Liest symbol/tf aus einem Location-Hash; unbekannter/ fehlender tf → null. */
export function parseChartHash(hash: string): { symbol: string | null; tf: ChartTf | null } {
  const q = hash.indexOf('?');
  if (q < 0) return { symbol: null, tf: null };
  const params = new URLSearchParams(hash.slice(q + 1));
  const symbol = params.get('symbol'); // URLSearchParams dekodiert bereits
  const tfRaw = params.get('tf');
  return { symbol: symbol && symbol.trim() ? symbol.toUpperCase() : null, tf: isChartTf(tfRaw) ? tfRaw : null };
}
