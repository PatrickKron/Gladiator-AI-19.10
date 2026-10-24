import { loadStrategySlugs, mergeStrategySlugs, saveStrategySlugs } from './chart-strategy-markers.js';
import { MAX_INDICATORS_PER_SYMBOL, type InstanceStyle } from './indicator-menu.js';
import { isMaIndicator, maStyle, pickMaColor, usedPlotColors } from './ma-colors.js';

/**
 * Übernahme der eigenen Chart-Indikatoren aus Version 2 (Patrick 2026-10-24).
 *
 * v2 speicherte je Symbol im Browser unter `gladiator.chartIndicators.<SYMBOL>`
 * (v2 lib/indicators.ts, `saveIndicatorConfig`): EMA/SMA-Linien mit Periode,
 * RSI-Periode, MACD schnell/langsam/Signal, Bollinger Periode/Faktor — jeweils
 * mit an/aus — und die Slugs der Strategie-Marker. Die heutige App liest das
 * nicht mehr; ihre Indikatoren liegen in der DB (`indicators.*`).
 *
 * Diese Datei bildet die v2-Konfiguration auf Einträge der Indikator-Bibliothek
 * ab (Katalog-Ids `ema`/`sma`/`rsi`/`macd`/`bb` aus @gladiator/indicators) und
 * übernimmt sie EINMAL je Symbol: danach steht ein Merker unter
 * `gladiator.chartIndicators.imported.<SYMBOL>`; der v2-Schlüssel bleibt
 * unangetastet. Regel 1: nichts erfinden — ungültige Einträge (außerhalb der
 * v2-Grenzen, falscher Typ) werden ignoriert, nie durch Ersatzwerte ersetzt.
 */

export type V2IndicatorId = 'ema' | 'sma' | 'rsi' | 'macd' | 'bb';
export type LibraryItem = { indicatorId: V2IndicatorId; inputs: Record<string, number | string> };
export type V2Import = { items: LibraryItem[]; strategySlugs: string[] };

export const v2IndicatorKey = (symbol: string) => `gladiator.chartIndicators.${symbol.toUpperCase()}`;
export const v2ImportedKey = (symbol: string) => `gladiator.chartIndicators.imported.${symbol.toUpperCase()}`;

/** Grenzen exakt wie v2 (PERIOD_MIN/MAX, MAX_MAS, BB_MULT_MIN/MAX, MACD-Klemmen, 20 Slugs). */
const V2 = { periodMin: 2, periodMax: 400, oscMax: 100, slowMin: 3, slowMax: 200, multMin: 0.5, multMax: 5, maxMas: 6, maxSlugs: 20 } as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isNum = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** v2-Konfiguration (unbekanntes JSON) → Bibliotheks-Einträge + Strategie-Marker. */
export function mapV2Config(raw: unknown): V2Import {
  const out: V2Import = { items: [], strategySlugs: [] };
  if (!isObj(raw)) return out;

  if (Array.isArray(raw.mas)) {
    let mas = 0;
    for (const m of raw.mas) {
      if (mas >= V2.maxMas) break;
      if (!isObj(m) || !isInt(m.period, V2.periodMin, V2.periodMax)) continue;
      // Eingabe-Ids der Bibliothek: EMA `length`, SMA `len`
      if (m.kind === 'ema') out.items.push({ indicatorId: 'ema', inputs: { length: m.period } });
      else if (m.kind === 'sma') out.items.push({ indicatorId: 'sma', inputs: { len: m.period } });
      else continue;
      mas += 1;
    }
  }

  // Overlay vor den Unterfenstern; Reihenfolge der Fenster wie v2 (RSI, dann MACD)
  const bb = raw.bollinger;
  if (isObj(bb) && bb.on === true && isInt(bb.period, V2.periodMin, V2.periodMax) && isNum(bb.mult, V2.multMin, V2.multMax)) {
    out.items.push({ indicatorId: 'bb', inputs: { length: bb.period, mult: bb.mult } });
  }
  const rsi = raw.rsi;
  if (isObj(rsi) && rsi.on === true && isInt(rsi.period, V2.periodMin, V2.oscMax)) {
    // v2 zeichnete nur die RSI-Linie; die Bibliothek legt sonst eine SMA-Glättungslinie darüber.
    out.items.push({ indicatorId: 'rsi', inputs: { length: rsi.period, maType: 'None' } });
  }
  const macd = raw.macd;
  if (
    isObj(macd) &&
    macd.on === true &&
    isInt(macd.slow, V2.slowMin, V2.slowMax) &&
    isInt(macd.fast, V2.periodMin, V2.oscMax) &&
    macd.fast < macd.slow &&
    isInt(macd.signal, V2.periodMin, V2.oscMax)
  ) {
    out.items.push({ indicatorId: 'macd', inputs: { fastLength: macd.fast, slowLength: macd.slow, signalLength: macd.signal } });
  }

  if (Array.isArray(raw.strategySlugs)) {
    out.strategySlugs = [...new Set(raw.strategySlugs.filter((s): s is string => typeof s === 'string' && s.length > 0))].slice(0, V2.maxSlugs);
  }
  return out;
}

/** Roher localStorage-Wert → Übernahme; kein Schlüssel → null, kaputtes JSON → leer. */
export function parseV2Raw(raw: string | null): V2Import | null {
  if (raw === null) return null;
  try {
    return mapV2Config(JSON.parse(raw) as unknown);
  } catch {
    return mapV2Config(null);
  }
}

/** Eingaben, die einen Indikator ausmachen (Perioden) — Darstellung wie die Glättungslinie zählt nicht. */
const IDENTITY: Record<V2IndicatorId, string[]> = {
  ema: ['length'],
  sma: ['len'],
  rsi: ['length'],
  macd: ['fastLength', 'slowLength', 'signalLength'],
  bb: ['length', 'mult'],
};

type ExistingLike = { indicatorId: string; inputs: Record<string, unknown> };

/** Gleiche Art + gleiche Perioden? (DB-Zeilen tragen immer die vollständig bereinigten Eingaben.) */
export function sameIndicator(item: LibraryItem, existing: ExistingLike): boolean {
  return existing.indicatorId === item.indicatorId && IDENTITY[item.indicatorId].every((k) => existing.inputs[k] === item.inputs[k]);
}

/** Was wirklich angelegt wird: ohne Doppelte (gegen den Server und untereinander), bis zur Obergrenze je Symbol. */
export function planV2Import(items: readonly LibraryItem[], existing: readonly ExistingLike[], max = MAX_INDICATORS_PER_SYMBOL): { add: LibraryItem[]; duplicates: number; overLimit: number } {
  const free = Math.max(0, max - existing.length);
  const seen: ExistingLike[] = [...existing];
  const add: LibraryItem[] = [];
  let duplicates = 0;
  let overLimit = 0;
  for (const item of items) {
    if (seen.some((e) => sameIndicator(item, e))) {
      duplicates += 1;
      continue;
    }
    if (add.length >= free) {
      overLimit += 1;
      continue;
    }
    add.push(item);
    seen.push(item);
  }
  return { add, duplicates, overLimit };
}

export type ImportDeps = {
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  /** Indikatoren, die der Server für dieses Symbol schon hat. */
  existing: readonly (ExistingLike & { style: InstanceStyle })[];
  /** Legt EINEN Indikator an (indicators.add) — wirft bei Fehler. */
  add: (item: { indicatorId: string; inputs: Record<string, unknown>; style?: InstanceStyle }) => Promise<unknown>;
  max?: number;
};

export type ImportResult = {
  added: number;
  duplicates: number;
  overLimit: number;
  /** Neue Strategie-Marker-Liste des Symbols, falls v2 etwas hinzugefügt hat; sonst null. */
  strategySlugs: string[] | null;
  /** Wie viele Strategie-Marker aus v2 neu dazugekommen sind. */
  markersAdded: number;
  /** Fehlertext, wenn unterwegs abgebrochen (dann KEIN Merker — der nächste Aufruf setzt fort). */
  failed: string | null;
};

/**
 * Einmalige Übernahme für ein Symbol. null = nichts zu tun (kein v2-Schlüssel
 * oder schon übernommen). Durchschnitte bekommen je eine freie Palettenfarbe.
 */
export async function importV2Indicators(symbol: string, deps: ImportDeps): Promise<ImportResult | null> {
  const { storage } = deps;
  if (storage.getItem(v2ImportedKey(symbol)) !== null) return null;
  const cfg = parseV2Raw(storage.getItem(v2IndicatorKey(symbol)));
  if (!cfg) return null;

  // Strategie-Marker: lokal, vereinigt mit der heutigen Auswahl
  let strategySlugs: string[] | null = null;
  let markersAdded = 0;
  if (cfg.strategySlugs.length > 0) {
    const current = loadStrategySlugs(symbol, storage);
    const merged = mergeStrategySlugs(current, cfg.strategySlugs);
    if (merged.length !== current.length) {
      saveStrategySlugs(symbol, merged, storage);
      strategySlugs = merged;
      markersAdded = merged.length - current.length;
    }
  }

  const plan = planV2Import(cfg.items, deps.existing, deps.max ?? MAX_INDICATORS_PER_SYMBOL);
  const used = usedPlotColors(deps.existing);
  let added = 0;
  let failed: string | null = null;
  for (const item of plan.add) {
    let style: InstanceStyle | undefined;
    if (isMaIndicator(item.indicatorId)) {
      const color = pickMaColor(used);
      used.push(color);
      style = maStyle(color);
    }
    try {
      await deps.add({ indicatorId: item.indicatorId, inputs: item.inputs, ...(style ? { style } : {}) });
      added += 1;
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
      break;
    }
  }
  if (failed === null) {
    try {
      storage.setItem(v2ImportedKey(symbol), new Date().toISOString());
    } catch {
      /* ohne Merker läuft die Übernahme beim nächsten Mal erneut — Doppelte werden übersprungen */
    }
  }
  return { added, duplicates: plan.duplicates, overLimit: plan.overLimit, strategySlugs, markersAdded, failed };
}

const inFlight = new Map<string, Promise<ImportResult | null>>();

/** Wie importV2Indicators, aber je Symbol nur EIN Lauf gleichzeitig (Haupt-Chart + Zelle mit demselben Symbol). */
export function importV2IndicatorsOnce(symbol: string, deps: ImportDeps): Promise<ImportResult | null> {
  const key = symbol.toUpperCase();
  const running = inFlight.get(key);
  if (running) return running;
  const p = importV2Indicators(symbol, deps).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}
