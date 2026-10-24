import type { InstanceStyle } from './indicator-menu.js';

/**
 * Eigene Farbe je gleitendem Durchschnitt (EMA/SMA der Indikator-Bibliothek).
 * Ohne Übersteuerung zeichnet die Bibliothek jede EMA/SMA in derselben
 * Standardfarbe — drei Durchschnitte wären nicht zu unterscheiden. Jede neue
 * Instanz bekommt deshalb die erste auf dem Symbol noch freie Palettenfarbe
 * (gespeichert als `style.plots.plot0.color`, in Einstellungen änderbar).
 *
 * Palette: zuerst die sechs Linienfarben aus v2 (lib/indicators.ts MA_COLORS —
 * dieselbe Reihenfolge, damit aus v2 übernommene Linien ihre alte Farbe
 * behalten), dann zwei weitere aus den v2-Lichtwelten.
 */
export const MA_PALETTE = ['#e14ecf', '#2e7cf6', '#3ddc97', '#e8b84b', '#ff5c6c', '#edf1ff', '#22d3ee', '#a78bfa'] as const;

const MA_IDS = new Set(['ema', 'sma']);

/** Katalog-Ids, die beim Anlegen eine eigene Palettenfarbe bekommen. */
export function isMaIndicator(indicatorId: string): boolean {
  return MA_IDS.has(indicatorId);
}

/** Alle ausdrücklich gesetzten Plot-Farben der Instanzen eines Symbols. */
export function usedPlotColors(instances: readonly { style: InstanceStyle }[]): string[] {
  const out: string[] = [];
  for (const inst of instances) {
    for (const plot of Object.values(inst.style?.plots ?? {})) {
      if (typeof plot.color === 'string' && plot.color) out.push(plot.color);
    }
  }
  return out;
}

/**
 * Erste Palettenfarbe, die auf dem Symbol noch nicht benutzt ist. Sind alle
 * vergeben, die am seltensten benutzte (bei Gleichstand die erste) — so bleiben
 * auch viele Durchschnitte möglichst unterscheidbar.
 */
export function pickMaColor(used: readonly string[], palette: readonly string[] = MA_PALETTE): string {
  const counts = new Map<string, number>();
  for (const c of used) counts.set(c.toLowerCase(), (counts.get(c.toLowerCase()) ?? 0) + 1);
  let best = palette[0]!;
  let bestCount = Infinity;
  for (const c of palette) {
    const n = counts.get(c.toLowerCase()) ?? 0;
    if (n < bestCount) {
      best = c;
      bestCount = n;
    }
    if (n === 0) break;
  }
  return best;
}

/** Stil einer neuen MA-Instanz: Farbe auf den Haupt-Plot (EMA/SMA: `plot0`). */
export function maStyle(color: string): { plots: { plot0: { color: string } } } {
  return { plots: { plot0: { color } } };
}
