/**
 * Unterfenster im Asset-Chart (lightweight-charts 5 Panes): RSI, MACD, ATR und
 * eigene Oszillatoren liegen im SELBEN Chart unter den Kerzen — eine Zeitachse,
 * ein Fadenkreuz über alle Fenster. Diese reine Funktion vergibt die
 * Pane-Indizes und berechnet Gesamthöhe und Oberkanten für die Beschriftungen.
 */

export type PaneSpec = { key: string; label: string };
export type PlacedPane = PaneSpec & { index: number; top: number; height: number };

/** `separator`: Höhe des Trenners zwischen Panes (lightweight-charts: 1 px). */
export function paneLayout(specs: PaneSpec[], mainHeight: number, paneHeight: number, separator = 1): { total: number; panes: PlacedPane[] } {
  let top = mainHeight;
  const panes = specs.map((s, i) => {
    top += separator;
    const placed = { ...s, index: i + 1, top, height: paneHeight };
    top += paneHeight;
    return placed;
  });
  return { total: top, panes };
}
