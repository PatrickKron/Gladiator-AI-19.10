/**
 * Strategie-Marker (Pine/DSL) auf dem Voll-Chart: welche Strategien je Symbol
 * als Entry-Marker gezeigt werden. Nur eine Browser-Vorliebe → localStorage
 * (die Indikatoren selbst liegen in der DB).
 */

type ReadStore = Pick<Storage, 'getItem'>;
type WriteStore = Pick<Storage, 'setItem'>;

/** Höchstens so viele Strategie-Marker je Symbol (wie v2). */
export const MAX_STRATEGY_MARKERS = 20;

export const strategyMarkersKey = (symbol: string) => `gladiator.chartStrategyMarkers.${symbol.toUpperCase()}`;

/** `storage`: nur für Tests/Übernahme — sonst localStorage. */
export function loadStrategySlugs(symbol: string, storage?: ReadStore): string[] {
  try {
    const raw = (storage ?? localStorage).getItem(strategyMarkersKey(symbol));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string').slice(0, MAX_STRATEGY_MARKERS) : [];
  } catch {
    return [];
  }
}

export function saveStrategySlugs(symbol: string, slugs: string[], storage?: WriteStore): void {
  try {
    (storage ?? localStorage).setItem(strategyMarkersKey(symbol), JSON.stringify(slugs));
  } catch {
    /* ohne localStorage gilt die Wahl nur für diese Sitzung */
  }
}

/** Vereinigung ohne Doppelte, vorhandene zuerst, gedeckelt. */
export function mergeStrategySlugs(current: readonly string[], extra: readonly string[]): string[] {
  return [...new Set([...current, ...extra])].slice(0, MAX_STRATEGY_MARKERS);
}
