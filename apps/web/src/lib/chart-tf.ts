import { isChartTf, type ChartTf } from './chart-url.js';

/**
 * Timeframe-Gedächtnis pro Asset (P0.2): merkt den zuletzt gewählten Timeframe
 * je Symbol in localStorage. Ein Query-Param (`?tf=`) überschreibt das Gedächtnis
 * (für Direkt-Links). Die Auswahl-Logik `pickTf` ist rein und unit-getestet;
 * die localStorage-Wrapper sind dünn und fehlertolerant.
 */

const key = (symbol: string) => `gladiator.tf.${symbol.toUpperCase()}`;

export function loadTf(symbol: string): ChartTf | null {
  try {
    const v = localStorage.getItem(key(symbol));
    return isChartTf(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveTf(symbol: string, tf: ChartTf): void {
  try {
    localStorage.setItem(key(symbol), tf);
  } catch {
    /* localStorage nicht verfügbar — ignorieren */
  }
}

/** Auswahl-Priorität: Query-Override > gemerkt > Fallback. Rein/testbar. */
export function pickTf(override: ChartTf | null, stored: ChartTf | null, fallback: ChartTf = '1h'): ChartTf {
  return override ?? stored ?? fallback;
}
