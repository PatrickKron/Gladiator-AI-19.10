/**
 * Strategie-Marker (Pine/DSL) auf dem Voll-Chart: welche Strategien je Symbol
 * als Entry-Marker gezeigt werden. Nur eine Browser-Vorliebe → localStorage
 * (die Indikatoren selbst liegen in der DB).
 */

const key = (symbol: string) => `gladiator.chartStrategyMarkers.${symbol.toUpperCase()}`;

export function loadStrategySlugs(symbol: string): string[] {
  try {
    const raw = localStorage.getItem(key(symbol));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string').slice(0, 20) : [];
  } catch {
    return [];
  }
}

export function saveStrategySlugs(symbol: string, slugs: string[]): void {
  try {
    localStorage.setItem(key(symbol), JSON.stringify(slugs));
  } catch {
    /* ohne localStorage gilt die Wahl nur für diese Sitzung */
  }
}
