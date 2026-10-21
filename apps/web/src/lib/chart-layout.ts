import { isChartTf, isChartVenue, type ChartTf, type ChartVenue } from './chart-url.js';

/**
 * Mehrfach-Charts (Repo-Masterliste, Phase 3b): Layout 1 / 2 / 4 auf der
 * Chart-Seite. Zelle 0 ist das Haupt-Asset der Seite (wie bisher, Zeitrahmen-
 * Gedächtnis je Symbol); die weiteren Zellen haben eigenes Symbol + Zeitrahmen
 * und liegen als Browser-Vorliebe in localStorage. Rein, getestet.
 */

export type ChartLayout = 1 | 2 | 4;
export type ChartCell = { symbol: string; tf: ChartTf; venue: ChartVenue };

export const CHART_LAYOUTS: ChartLayout[] = [1, 2, 4];
const KEY = 'gladiator.chartLayout';

/** Zeitrahmen-Vorschläge für neue Zusatz-Zellen (anders als der übliche 1h-Hauptchart). */
const EXTRA_TFS: ChartTf[] = ['4h', '1d', '15m'];

export function isChartLayout(v: unknown): v is ChartLayout {
  return v === 1 || v === 2 || v === 4;
}

/**
 * Genau `layout − 1` Zusatz-Zellen: vorhandene behalten, fehlende mit dem
 * Haupt-Symbol und einem anderen Zeitrahmen auffüllen, überzählige abschneiden.
 */
export function normalizeCells(cells: ChartCell[], layout: ChartLayout, primarySymbol: string): ChartCell[] {
  const out: ChartCell[] = cells
    .filter((c) => typeof c.symbol === 'string' && c.symbol.trim() !== '' && isChartTf(c.tf))
    .slice(0, layout - 1)
    .map((c) => ({ symbol: c.symbol, tf: c.tf, venue: isChartVenue(c.venue) ? c.venue : 'binance' }));
  while (out.length < layout - 1) out.push({ symbol: primarySymbol, tf: EXTRA_TFS[out.length % EXTRA_TFS.length]!, venue: 'binance' });
  return out;
}

export function loadChartLayout(): { layout: ChartLayout; cells: ChartCell[] } {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      const p = parsed as { layout?: unknown; cells?: unknown };
      const layout = isChartLayout(p.layout) ? p.layout : 1;
      const cells = Array.isArray(p.cells) ? (p.cells as ChartCell[]) : [];
      return { layout, cells };
    }
  } catch {
    /* ohne localStorage: Standard */
  }
  return { layout: 1, cells: [] };
}

export function saveChartLayout(layout: ChartLayout, cells: ChartCell[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ layout, cells }));
  } catch {
    /* nur Komfort */
  }
}

/** CSS-Grid-Klassen je Layout (1 Spalte, 2 Spalten, 2×2). */
export function layoutGridClass(layout: ChartLayout): string {
  return layout === 1 ? 'grid-cols-1' : 'grid-cols-1 2xl:grid-cols-2';
}
