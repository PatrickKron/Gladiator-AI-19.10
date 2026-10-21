import { inputActive } from '@gladiator/core/indicator-inputs';
import type { FillConfig, HLineConfig, InputConfig, PlotConfig } from 'oakscriptjs';

/**
 * Reine Helfer für Indikator-Menü, Legende und Einstellungs-Dialog
 * (Repo-Masterliste, Phase 1). Die Katalog-Metadaten kommen vom Server
 * (`indicators.catalog`); gerechnet wird dort — hier nur Suche, Beschriftung
 * und Formular-Logik, per Vitest getestet.
 */

/** Eingabe-Deklaration wie vom Server (Pine-Input ohne Laufzeitfelder). */
export type MenuInput = Pick<
  InputConfig,
  'id' | 'type' | 'defval' | 'title' | 'min' | 'max' | 'step' | 'options' | 'group' | 'inline' | 'tooltip' | 'display' | 'active'
>;

/** Plot-Deklaration wie vom Server (volle Pine-Plot-Konfiguration, reine Daten). */
export type MenuPlot = PlotConfig;

export type MenuEntry = {
  id: string;
  group: 'standard' | 'candlestick';
  name: string;
  shortName: string;
  description: string | null;
  category: string;
  overlay: boolean;
  inputs: MenuInput[];
  defaultInputs: Record<string, unknown>;
  plots: MenuPlot[];
  hlines: HLineConfig[];
  fills: FillConfig[];
  extraTimeframes: string[];
};

export type PlotStyle = { visible?: boolean; color?: string; lineWidth?: number };
export type InstanceStyle = { visible?: boolean; plots?: Record<string, PlotStyle> } | null;

/** Katalog-Kategorie → i18n-Schlüssel (`chart.ind.cat_<key>`). */
export const CATEGORY_KEYS: Record<string, string> = {
  'Moving Averages': 'ma',
  Trend: 'trend',
  Momentum: 'momentum',
  Oscillators: 'osc',
  Volatility: 'volatility',
  'Channels & Bands': 'bands',
  Volume: 'volume',
  'Candlestick Patterns': 'patterns',
};

/** Höchstens so viele Indikatoren je Symbol (wie der Server). */
export const MAX_INDICATORS_PER_SYMBOL = 12;

const norm = (s: string) => s.toLowerCase().normalize('NFKD');

/** Suche: alle Wörter der Anfrage müssen in Name, Kürzel, Id oder Kategorie vorkommen; optional eine Kategorie. */
export function filterCatalog<T extends Pick<MenuEntry, 'id' | 'name' | 'shortName' | 'category'>>(entries: T[], query: string, category: string | null): T[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  return entries.filter((e) => {
    if (category !== null && e.category !== category) return false;
    if (words.length === 0) return true;
    const hay = norm(`${e.name} ${e.shortName} ${e.id} ${e.category}`);
    return words.every((w) => hay.includes(w));
  });
}

function fmtNum(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
}

/**
 * Kurzbeschriftung einer Instanz: Kürzel + die zahlenwertigen, aktiven und
 * sichtbaren Eingaben ("RSI 14", "MACD 12 26 9", "BB 20 2"). Muster: nur Kürzel.
 */
export function instanceLabel(entry: Pick<MenuEntry, 'shortName' | 'group' | 'inputs'>, inputs: Record<string, unknown>): string {
  if (entry.group === 'candlestick') return entry.shortName;
  const nums = entry.inputs
    .filter((i) => (i.type === 'int' || i.type === 'float') && i.display !== 'none' && inputActive(i.active, inputs))
    .map((i) => inputs[i.id])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .map(fmtNum);
  return nums.length > 0 ? `${entry.shortName} ${nums.join(' ')}` : entry.shortName;
}

/** Eingaben für den Dialog: `symbol` kann der Server nicht nachladen; inaktive bleiben sichtbar, aber gesperrt. */
export function editableInputs(entry: Pick<MenuEntry, 'inputs'>, values: Record<string, unknown>): { decl: MenuInput; active: boolean }[] {
  return entry.inputs.filter((i) => i.type !== 'symbol').map((decl) => ({ decl, active: inputActive(decl.active, values) }));
}

/** Zeilen des Dialogs: aufeinanderfolgende Eingaben mit gleichem `inline` teilen sich eine Zeile; Gruppenwechsel = Überschrift. */
export function inputRows(items: { decl: MenuInput; active: boolean }[]): { group: string | null; inputs: { decl: MenuInput; active: boolean }[] }[] {
  const rows: { group: string | null; inputs: { decl: MenuInput; active: boolean }[] }[] = [];
  for (const it of items) {
    const last = rows[rows.length - 1];
    const group = it.decl.group ?? null;
    if (last && last.group === group && it.decl.inline !== undefined && last.inputs[0]?.decl.inline === it.decl.inline) {
      last.inputs.push(it);
      continue;
    }
    rows.push({ group, inputs: [it] });
  }
  return rows;
}

/** Wirksamer Stil eines Plots: Übersteuerung vor Katalog-Default. */
export function effectivePlotStyle(plot: MenuPlot, style: InstanceStyle): Required<PlotStyle> {
  const o = style?.plots?.[plot.id] ?? {};
  return { visible: o.visible ?? plot.display !== 'none', color: o.color ?? plot.color, lineWidth: o.lineWidth ?? plot.lineWidth ?? 1 };
}

/** Farbe für den Punkt in der Legende: erste sichtbare Plot-Farbe, sonst Grau. */
export function legendColor(entry: Pick<MenuEntry, 'plots'>, style: InstanceStyle): string {
  const first = entry.plots.find((p) => effectivePlotStyle(p, style).visible && p.color !== 'transparent');
  return first ? effectivePlotStyle(first, style).color : '#8b94b8';
}

/**
 * Zeit der ersten definierten Plot-Kerze (Warmup); null = keine Werte.
 * `preferIds`: sichtbare Plots in Deklarationsreihenfolge — der erste mit Werten
 * zählt (sonst würde ein versteckter Hilfs-Plot „ab Kerze 1" vortäuschen).
 */
export function firstPlotTime(result: { plots: Record<string, { time: number }[]> } | null | undefined, preferIds: string[] = []): number | null {
  if (!result) return null;
  for (const id of preferIds) {
    const t = result.plots[id]?.[0]?.time;
    if (t !== undefined) return t;
  }
  let first: number | null = null;
  for (const pts of Object.values(result.plots)) {
    const t = pts[0]?.time;
    if (t !== undefined && (first === null || t < first)) first = t;
  }
  return first;
}

/** Ids der sichtbaren Plots eines Eintrags in Deklarationsreihenfolge (für `firstPlotTime`). */
export function visiblePlotIds(entry: Pick<MenuEntry, 'plots'>): string[] {
  return entry.plots.filter((p) => p.display !== 'none' && p.color !== 'transparent').map((p) => p.id);
}

/** Zahl aus einem Eingabefeld innerhalb der Grenzen; ungültig → Vorgabe. */
export function clampNumber(raw: string, decl: Pick<MenuInput, 'type' | 'min' | 'max'>, fallback: number): number {
  const n = Number(raw.replace(',', '.'));
  if (!Number.isFinite(n)) return fallback;
  const v = decl.type === 'int' ? Math.round(n) : n;
  return Math.min(decl.max ?? Infinity, Math.max(decl.min ?? -Infinity, v));
}
