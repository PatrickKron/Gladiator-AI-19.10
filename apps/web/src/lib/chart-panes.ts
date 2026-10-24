/**
 * Unterfenster im Asset-Chart (lightweight-charts 5 Panes): RSI, MACD, ATR und
 * eigene Oszillatoren liegen im SELBEN Chart unter den Kerzen — eine Zeitachse,
 * ein Fadenkreuz über alle Fenster. Diese reinen Funktionen vergeben die
 * Pane-Indizes und berechnen Gesamthöhe, Stretch-Faktoren und Oberkanten für
 * die Beschriftungen.
 *
 * WARUM Stretch-Faktoren = Soll-Pixelhöhen und Zeitachse extra: die Bibliothek
 * zieht von der Chart-Höhe erst Zeitachse und Trenner ab und verteilt den Rest
 * proportional zu den Faktoren. Nur wenn das Kursfenster den echten
 * `mainHeight` als Faktor bekommt (früher fest 340, obwohl die Chart-Seite 460
 * übergibt) und die Zeitachse oben drauf kommt, liegen Fenster und
 * Beschriftungen pixelgenau übereinander.
 */

export type PaneSpec = { key: string; label: string };
export type PlacedPane = PaneSpec & { index: number; top: number; height: number };
export type PaneLayout = { main: number; total: number; panes: PlacedPane[] };

/**
 * Feste Höhe der Zeitachse in px (als `timeScale.minimumHeight` gesetzt). Die
 * Bibliothek braucht bei Schriftgröße 10 selbst 26 px; 28 liegt sicher darüber
 * und ist gerade (sie rundet auf gerade Werte) — damit ist die Höhe bekannt.
 */
export const TIME_AXIS_HEIGHT = 28;

/** `separator`: Höhe des Trenners zwischen Panes (lightweight-charts: 1 px). */
export function paneLayout(specs: PaneSpec[], mainHeight: number, paneHeight: number, separator = 1): PaneLayout {
  let top = mainHeight;
  const panes = specs.map((s, i) => {
    top += separator;
    const placed = { ...s, index: i + 1, top, height: paneHeight };
    top += paneHeight;
    return placed;
  });
  return { main: mainHeight, total: top, panes };
}

/** Stretch-Faktor je Pane-Index (0 = Kursfenster): die Soll-Pixelhöhe des Fensters. */
export function paneStretchFactors(layout: PaneLayout): number[] {
  const out = [layout.main];
  for (const p of layout.panes) out[p.index] = p.height;
  return out;
}

/** Höhe für `createChart`: alle Fenster + Trenner + Zeitachse. */
export function chartHeight(layout: PaneLayout, axisHeight = TIME_AXIS_HEIGHT): number {
  return layout.total + axisHeight;
}

/** Liegt ein Punkt (y relativ zur Chart-Oberkante) im Kursfenster? */
export function inMainPane(y: number, layout: PaneLayout): boolean {
  return y >= 0 && y <= layout.main;
}
