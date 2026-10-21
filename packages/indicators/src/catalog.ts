import { indicatorRegistry, type IndicatorCategory, type IndicatorRegistryEntry } from 'lightweight-charts-indicators';
import type { FillConfig, HLineConfig, InputConfig, PlotConfig } from 'oakscriptjs';

/**
 * Katalog der angebotenen Indikatoren: Standard (117) + Kerzenmuster (45).
 * Community-Ports werden ausgeschlossen (Lizenz je Datei unklar bzw. CC BY-NC-SA).
 * Der Katalog ist reine Metadaten (serialisierbar) — der Browser baut daraus
 * Menü und Einstellungs-Dialog; gerechnet wird nur auf dem Server (compute.ts).
 */

export type CatalogGroup = 'standard' | 'candlestick';

/** Eingabe-Deklaration (Teilmenge von oakscriptjs InputConfig, JSON-tauglich). */
export type InputDecl = Pick<
  InputConfig,
  'id' | 'type' | 'defval' | 'title' | 'min' | 'max' | 'step' | 'options' | 'group' | 'inline' | 'tooltip' | 'display' | 'active'
>;

/** Volle Plot-Konfiguration (reine Daten): der Browser-Renderer braucht auch histbase, offset, visible, palette. */
export type PlotDecl = PlotConfig;

export type CatalogEntry = {
  id: string;
  group: CatalogGroup;
  name: string;
  shortName: string;
  description: string | null;
  category: IndicatorCategory;
  /** true = im Kerzen-Fenster, false = eigenes Unterfenster */
  overlay: boolean;
  inputs: InputDecl[];
  defaultInputs: Record<string, unknown>;
  plots: PlotDecl[];
  hlines: HLineConfig[];
  fills: FillConfig[];
  /** Zeichnet der Indikator Labels/Linien/Boxen (Pine-Drawings)? */
  drawingKinds: string[];
  /** Zusätzlich nötige Zeitrahmen DESSELBEN Symbols (Gladiator-Schreibweise, z. B. Pivots: '1w') bei Default-Eingaben */
  extraTimeframes: string[];
};

/** Pine-Zeitrahmen → Gladiator-Zeitrahmen; nur gespeicherte Auflösungen (keine Minutenkerzen). */
export const PINE_TF_TO_GLADIATOR: Record<string, string> = {
  '5': '5m',
  '15': '15m',
  '30': '30m',
  '60': '1h',
  '120': '2h',
  '240': '4h',
  '720': '12h',
  D: '1d',
  '1D': '1d',
  W: '1w',
  '1W': '1w',
  M: '1M',
  '1M': '1M',
};

export type ExtraNeeds = { timeframes: string[]; foreign: string[]; unsupported: string[] };

/**
 * Welche weiteren Kerzen braucht ein Indikator (Pine `request.security`)?
 * Dasselbe Symbol in anderen Zeitrahmen kann der Server aus der DB liefern;
 * fremde Symbole oder Minutenkerzen nicht (ehrlich: nicht angeboten).
 */
export function extraNeedsOf(e: IndicatorRegistryEntry, inputs: Record<string, unknown>, tickerid: string): ExtraNeeds {
  const out: ExtraNeeds = { timeframes: [], foreign: [], unsupported: [] };
  if (!e.requiredSymbols) return out;
  let reqs: { symbol: string; timeframe: string }[] = [];
  try {
    reqs = e.requiredSymbols(inputs, { timeframe: '60', tickerid });
  } catch {
    return out;
  }
  for (const r of reqs) {
    if (r.symbol !== '' && r.symbol !== tickerid) {
      out.foreign.push(r.symbol);
      continue;
    }
    const tf = PINE_TF_TO_GLADIATOR[r.timeframe];
    if (!tf) out.unsupported.push(r.timeframe);
    else if (!out.timeframes.includes(tf)) out.timeframes.push(tf);
  }
  return out;
}

/** Reihenfolge der Kategorien im Menü. */
export const CATALOG_CATEGORIES: IndicatorCategory[] = [
  'Moving Averages',
  'Trend',
  'Momentum',
  'Oscillators',
  'Volatility',
  'Channels & Bands',
  'Volume',
  'Candlestick Patterns',
];

const pickInput = (i: InputConfig): InputDecl => ({
  id: i.id,
  type: i.type,
  defval: i.defval,
  ...(i.title !== undefined ? { title: i.title } : {}),
  ...(i.min !== undefined ? { min: i.min } : {}),
  ...(i.max !== undefined ? { max: i.max } : {}),
  ...(i.step !== undefined ? { step: i.step } : {}),
  ...(i.options !== undefined ? { options: i.options } : {}),
  ...(i.group !== undefined ? { group: i.group } : {}),
  ...(i.inline !== undefined ? { inline: i.inline } : {}),
  ...(i.tooltip !== undefined ? { tooltip: i.tooltip } : {}),
  ...(i.display !== undefined ? { display: i.display } : {}),
  ...(i.active !== undefined ? { active: i.active } : {}),
});

/** Plot-Konfiguration unverändert (reine Daten); der Browser-Renderer braucht alle Felder. */
const pickPlot = (p: PlotConfig): PlotDecl => ({ ...p });

const PROBE_TICKER = 'BINANCE:BTCUSDT';

function toCatalogEntry(e: IndicatorRegistryEntry): CatalogEntry {
  const needs = extraNeedsOf(e, e.defaultInputs, PROBE_TICKER);
  return {
    id: e.id,
    group: e.group as CatalogGroup,
    name: e.name,
    shortName: e.shortName,
    description: e.description ?? null,
    category: e.category,
    overlay: e.overlay,
    inputs: e.inputConfig.map(pickInput),
    defaultInputs: { ...e.defaultInputs },
    plots: e.plotConfig.map(pickPlot),
    hlines: e.hlineConfig ?? [],
    fills: e.fillConfig ?? [],
    drawingKinds: (e.drawingKinds ?? []) as string[],
    extraTimeframes: needs.timeframes,
  };
}

const REGISTRY = new Map<string, IndicatorRegistryEntry>();
for (const e of indicatorRegistry) {
  if (e.group === 'community') continue;
  // fremde Symbole (Korrelation, Performance-Vergleich) oder Minutenkerzen kann der Server nicht liefern
  const needs = extraNeedsOf(e, e.defaultInputs, PROBE_TICKER);
  if (needs.foreign.length > 0 || needs.unsupported.length > 0) continue;
  REGISTRY.set(e.id, e);
}

export const CATALOG: CatalogEntry[] = [...REGISTRY.values()].map(toCatalogEntry);
const BY_ID = new Map(CATALOG.map((e) => [e.id, e]));

export function catalogEntry(id: string): CatalogEntry | undefined {
  return BY_ID.get(id);
}

/** Interner Zugriff auf die rechnende Bibliotheks-Definition (nur Server). */
export function registryEntry(id: string): IndicatorRegistryEntry | undefined {
  return REGISTRY.get(id);
}
