import { buildChartUrl } from './chart-url.js';
import { ASSET_CLASSES, type AssetClass } from './discover.js';

/**
 * Heatmap (Markt › Heatmap) — reine Helfer, ohne React/DOM, vollständig getestet:
 * Farbskalen, Kachelgewichte, Treemap-Aufteilung (squarify), Gruppierung nach Klasse
 * oder Paket, Live-Tick-Übersteuerung, Chart-Sprung und Korrelations-Auswertung.
 *
 * Ehrlichkeit: Kachelgröße NUR aus echtem Gewicht (24h-Quote-Volumen von Binance);
 * ohne Gewicht sind Kacheln gleich groß — nie eine geschätzte Marktkapitalisierung.
 * Assets ohne Kurs werden nicht eingefärbt, sondern gezählt und benannt.
 */

// ── Farben ────────────────────────────────────────────────────────────────

/** Neutraler Mittelpunkt (Nachtblau-Grau der v2-Palette). */
export const HEAT_NEUTRAL = '#283056';
/** Pole der Performance-Skala: blaustichiges Grün / Rot — unter Deuteranopie per Validator ΔE ≈ 9,5 getrennt; Vorzeichen steht zusätzlich als Text. */
export const HEAT_POS = '#0a7d6a';
export const HEAT_NEG = '#c23a3a';
/** Korrelation: Blau = gleichläufig, Rot = gegenläufig (kein Geld-Grün — es geht um Gleichlauf, nicht um Gewinn). */
export const CORR_POS = '#2f63d8';
export const CORR_NEG = '#b8434e';
/** Kurs ohne Änderung bzw. Paar ohne genug Daten. */
export const NO_DATA_COLOR = '#3b4157';
/** Schrift auf Kacheln/Zellen (AA auf jeder Stufe, getestet). */
export const TILE_TEXT = '#ffffff';
/** Skalenende der Performance-Farbe in %: ab ±5 % volle Farbe. */
export const HEAT_MAX_ABS = 5;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return `#${ca
    .map((v, i) => Math.round(v + (cb[i]! - v) * t))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Divergierende Farbe einer Änderung in %; null/NaN → „keine Daten“. */
export function changeColor(pct: number | null, maxAbs = HEAT_MAX_ABS): string {
  if (pct === null || !Number.isFinite(pct)) return NO_DATA_COLOR;
  if (pct === 0) return HEAT_NEUTRAL;
  const t = Math.min(Math.abs(pct) / maxAbs, 1);
  return mix(HEAT_NEUTRAL, pct > 0 ? HEAT_POS : HEAT_NEG, t);
}

/** Farbe eines Korrelationskoeffizienten (−1 … +1); null → „zu wenig Daten“. */
export function corrColor(r: number | null): string {
  if (r === null || !Number.isFinite(r)) return NO_DATA_COLOR;
  if (r === 0) return HEAT_NEUTRAL;
  return mix(HEAT_NEUTRAL, r > 0 ? CORR_POS : CORR_NEG, Math.min(Math.abs(r), 1));
}

/** CSS-Verlauf für die Legende (links negativ, Mitte neutral, rechts positiv). */
export function legendGradient(neg: string, pos: string): string {
  return `linear-gradient(90deg, ${neg} 0%, ${HEAT_NEUTRAL} 50%, ${pos} 100%)`;
}

// ── Kachelgewichte & Treemap ──────────────────────────────────────────────

/**
 * Anzeigegewichte aus echtem Volumen: Fläche ∝ √Volumen (sonst wäre alles außer BTC
 * unsichtbar klein), Mindestgröße 50 % des mittleren √Volumens — auch für Kacheln ohne
 * Volumen. Gibt es kein einziges Volumen, sind alle Kacheln gleich groß.
 */
/** Mindestgröße einer gewichteten Kachel relativ zum mittleren √Volumen (Anzeige-Regel, kein Datenwert). */
export const TILE_FLOOR = 0.5;

export function tileWeights(volumes: readonly (number | null)[]): { weights: number[]; weighted: boolean } {
  const roots = volumes.map((v) => (v !== null && Number.isFinite(v) && v > 0 ? Math.sqrt(v) : null));
  const valid = roots.filter((r): r is number => r !== null);
  if (valid.length === 0) return { weights: volumes.map(() => 1), weighted: false };
  const floor = TILE_FLOOR * (valid.reduce((a, b) => a + b, 0) / valid.length);
  return { weights: roots.map((r) => Math.max(r ?? 0, floor)), weighted: true };
}

/**
 * Welche Volumina dürfen eine Gruppe gewichten? Nur eine reine Krypto-Gruppe — in einer
 * gemischten Gruppe (Paket mit Aktien + Krypto) sähen die Aktien sonst „klein“ aus, obwohl
 * für sie schlicht kein Gewicht existiert. Dann: alle gleich groß.
 */
export function sizingVolumes(tiles: readonly { assetType: string; volume: number | null }[]): (number | null)[] {
  const allCrypto = tiles.length > 0 && tiles.every((t) => t.assetType.toUpperCase() === 'CRYPTO');
  return tiles.map((t) => (allCrypto ? t.volume : null));
}

export type Rect = { x: number; y: number; w: number; h: number };

/** Schlechtestes Seitenverhältnis einer Reihe (Bruls/Huizing/van Wijk). */
function worst(row: readonly number[], side: number): number {
  const s = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
}

/**
 * Squarified Treemap: Flächen proportional zu `weights` in einem Rechteck width×height.
 * Ergebnis in Eingabe-Reihenfolge. Gewichte ≤ 0 überall → gleich verteilt.
 */
export function squarify(weights: readonly number[], width: number, height: number): Rect[] {
  const n = weights.length;
  if (n === 0) return [];
  if (!(width > 0) || !(height > 0)) return weights.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  const clean = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const total0 = clean.reduce((a, b) => a + b, 0);
  const ws = total0 > 0 ? clean : clean.map(() => 1);
  const total = ws.reduce((a, b) => a + b, 0);
  const scale = (width * height) / total;
  const order = ws.map((w, i) => ({ i, a: w * scale })).filter((x) => x.a > 0).sort((p, q) => q.a - p.a || p.i - q.i);
  const out: Rect[] = weights.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));

  let x = 0;
  let y = 0;
  let w = width;
  let h = height;
  let row: { i: number; a: number }[] = [];

  const layoutRow = () => {
    const s = row.reduce((acc, r) => acc + r.a, 0);
    if (w >= h) {
      // Spalte am linken Rand
      const colW = h > 0 ? s / h : 0;
      let yy = y;
      for (const r of row) {
        const rh = colW > 0 ? r.a / colW : 0;
        out[r.i] = { x, y: yy, w: colW, h: rh };
        yy += rh;
      }
      x += colW;
      w -= colW;
    } else {
      // Zeile am oberen Rand
      const rowH = w > 0 ? s / w : 0;
      let xx = x;
      for (const r of row) {
        const rw = rowH > 0 ? r.a / rowH : 0;
        out[r.i] = { x: xx, y, w: rw, h: rowH };
        xx += rw;
      }
      y += rowH;
      h -= rowH;
    }
    row = [];
  };

  for (const item of order) {
    const side = Math.min(w, h);
    if (row.length === 0 || worst([...row.map((r) => r.a), item.a], side) <= worst(row.map((r) => r.a), side)) {
      row.push(item);
    } else {
      layoutRow();
      row.push(item);
    }
  }
  if (row.length > 0) layoutRow();
  return out;
}

/** Höhe einer Treemap: mittlere Kachel ≈ 4.200 px² (z. B. 70×60), mindestens 120 px. */
export function treemapHeight(width: number, tiles: number, avgTileArea = 4200, min = 120): number {
  if (!(width > 0) || tiles <= 0) return min;
  return Math.max(min, Math.round((tiles * avgTileArea) / width));
}

/** Was passt in eine Kachel? Zu klein → nur Farbe, Inhalt über Tooltip/aria-label. */
export function tileLabelMode(w: number, h: number): 'full' | 'ticker' | 'none' {
  if (w >= 46 && h >= 34) return 'full';
  if (w >= 26 && h >= 16) return 'ticker';
  return 'none';
}

/** Schriftgröße der Kachel (px) — wächst mit der Kachel, 10…26 px. */
export function tileFontPx(w: number, h: number): number {
  return Math.round(Math.max(10, Math.min(26, w / 4.6, h / 2.8)));
}

/** Matrix-/Chip-Beschriftung: Binance-USDT-Paar ohne „/USDT“, sonst unverändert. */
export function shortSymbol(symbol: string, venue: string): string {
  return venue === 'binance' && symbol.endsWith('/USDT') ? symbol.slice(0, -5) : symbol;
}

/** Matrix-Beschriftungen: kurz, aber eindeutig — dasselbe Kürzel auf zwei Venues bekommt die Venue angehängt. */
export function matrixLabels(symbols: readonly { symbol: string; venue: string }[]): string[] {
  const short = symbols.map((s) => shortSymbol(s.symbol, s.venue));
  const count = new Map<string, number>();
  for (const s of short) count.set(s, (count.get(s) ?? 0) + 1);
  return short.map((s, i) => ((count.get(s) ?? 0) > 1 ? `${s}·${symbols[i]!.venue}` : s));
}

// ── Gruppierung ───────────────────────────────────────────────────────────

export type HeatAsset = { id: number; ticker: string; name: string; assetType: string; symbol: string | null; isFavorite: boolean };
export type HeatQuote = {
  ticker: string;
  price: number;
  changePct: number | null;
  currency: string | null;
  quoteVolume24h?: number | null;
  source: 'binance' | 'tradingview' | 'cboe' | 'candles';
  ts: string;
};
export type HeatLive = { price: number; changePct: number | null; ts: string };
export type HeatSource = HeatQuote['source'] | 'live';

export type HeatTile = HeatAsset & {
  price: number;
  changePct: number | null;
  currency: string | null;
  /** 24h-Quote-Volumen (USDT) — nur Krypto über Binance; sonst null. */
  volume: number | null;
  source: HeatSource;
  ts: string;
};

export type HeatGroup = { key: string; label?: string; tiles: HeatTile[] };
export type HeatFilter = 'all' | 'favorites' | AssetClass;
export type HeatGroupOptions = {
  filter: HeatFilter;
  groupBy: 'class' | 'package';
  packages?: readonly { id: number; name: string }[];
  /** assetId → packageId */
  packageOf?: ReadonlyMap<number, number>;
};

/** Gruppenschlüssel der Assets ohne Paket-Zuordnung. */
export const NO_PACKAGE = '__none__';

/** Kachel aus REST-Quote + optionalem Live-Tick; ohne beides → null („kein Kurs“). */
function toTile(a: HeatAsset, quote: HeatQuote | null | undefined, live: HeatLive | undefined): HeatTile | null {
  if (live) {
    return {
      ...a,
      price: live.price,
      changePct: live.changePct ?? quote?.changePct ?? null,
      currency: 'USDT',
      volume: quote?.quoteVolume24h ?? null,
      source: 'live',
      ts: live.ts,
    };
  }
  if (!quote) return null;
  return { ...a, price: quote.price, changePct: quote.changePct, currency: quote.currency, volume: quote.quoteVolume24h ?? null, source: quote.source, ts: quote.ts };
}

/**
 * Filter → Kacheln → Gruppen. Klassen in fester Reihenfolge (ASSET_CLASSES, unbekannte Typen
 * dahinter), Pakete in der Server-Reihenfolge, Assets ohne Paket am Ende. Innerhalb einer
 * Gruppe nach Volumen, dann Ticker. `missing` = Assets ohne jeden Kurs (ehrlich benannt).
 */
export function buildHeatmapGroups(
  assets: readonly HeatAsset[],
  quotes: Readonly<Record<string, HeatQuote | null>> | null,
  live: ReadonlyMap<string, HeatLive>,
  opts: HeatGroupOptions,
): { groups: HeatGroup[]; missing: HeatAsset[] } {
  const filtered = assets.filter((a) => {
    if (opts.filter === 'all') return true;
    if (opts.filter === 'favorites') return a.isFavorite;
    return a.assetType.toUpperCase() === opts.filter;
  });
  const tiles: HeatTile[] = [];
  const missing: HeatAsset[] = [];
  for (const a of filtered) {
    const tile = toTile(a, quotes?.[a.ticker], a.symbol !== null ? live.get(a.symbol) : undefined);
    if (tile) tiles.push(tile);
    else missing.push(a);
  }
  const byKey = new Map<string, HeatTile[]>();
  const keyOf = (t: HeatTile): string => {
    if (opts.groupBy === 'class') return t.assetType.toUpperCase();
    const pkg = opts.packageOf?.get(t.id);
    return pkg === undefined ? NO_PACKAGE : `pkg:${pkg}`;
  };
  for (const t of tiles) {
    const k = keyOf(t);
    const arr = byKey.get(k) ?? [];
    arr.push(t);
    byKey.set(k, arr);
  }
  const ordered: HeatGroup[] = [];
  const take = (key: string, label?: string) => {
    const list = byKey.get(key);
    if (!list || list.length === 0) return;
    list.sort((p, q) => (q.volume ?? -1) - (p.volume ?? -1) || p.ticker.localeCompare(q.ticker));
    ordered.push(label === undefined ? { key, tiles: list } : { key, label, tiles: list });
    byKey.delete(key);
  };
  if (opts.groupBy === 'class') {
    for (const c of ASSET_CLASSES) take(c);
    for (const k of [...byKey.keys()].sort()) take(k);
  } else {
    for (const p of opts.packages ?? []) take(`pkg:${p.id}`, p.name);
    for (const k of [...byKey.keys()].filter((k) => k !== NO_PACKAGE).sort()) take(k);
    take(NO_PACKAGE);
  }
  return { groups: ordered, missing };
}

/** Ungewichtetes Mittel der echten Änderungen; null, wenn keine Kachel eine hat. */
export function meanChange(tiles: readonly { changePct: number | null }[]): number | null {
  const v = tiles.map((t) => t.changePct).filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
}

/**
 * Chart-Sprung einer Kachel: Krypto → Binance-Chart (Kerzen lädt der Chart auf Abruf),
 * Aktie/ETF/Index nur, wenn echte Tageskerzen in der DB liegen (`stockVenues`: Ticker → Venue).
 * Sonst null — kein Link auf einen leeren Chart.
 */
export function chartTargetFor(a: { assetType: string; symbol: string | null; ticker: string }, stockVenues: ReadonlyMap<string, string>): string | null {
  if (a.assetType.toUpperCase() === 'CRYPTO') return a.symbol ? buildChartUrl(a.symbol, '1d') : null;
  const venue = stockVenues.get(a.ticker.toUpperCase());
  return venue ? buildChartUrl(a.ticker.toUpperCase(), '1d', venue) : null;
}

// ── Korrelation ───────────────────────────────────────────────────────────

export type CorrPair = { a: string; b: string; r: number };

/** Stärkste gleichläufige (r > 0) und gegenläufige (r < 0) Paare ohne Diagonale. */
export function strongestPairs(labels: readonly string[], matrix: readonly (readonly (number | null)[])[], k: number): { top: CorrPair[]; bottom: CorrPair[] } {
  const pairs: CorrPair[] = [];
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++) {
      const r = matrix[i]?.[j];
      if (typeof r === 'number' && Number.isFinite(r)) pairs.push({ a: labels[i]!, b: labels[j]!, r });
    }
  return {
    top: pairs.filter((p) => p.r > 0).sort((p, q) => q.r - p.r).slice(0, k),
    bottom: pairs.filter((p) => p.r < 0).sort((p, q) => p.r - q.r).slice(0, k),
  };
}

export type SymbolRef = { symbol: string; venue: string };

/** Gespeicherte Auswahl (localStorage) prüfen: nur Symbole mit Kerzen, ohne Doppelte, gedeckelt. Unlesbar → null. */
export function sanitizeSelection(raw: string | null, universe: readonly { symbol: string; venue: string }[], max: number): SymbolRef[] | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const known = new Set(universe.map((u) => `${u.venue}:${u.symbol}`));
  const seen = new Set<string>();
  const out: SymbolRef[] = [];
  for (const item of parsed as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const { symbol, venue } = item as { symbol?: unknown; venue?: unknown };
    if (typeof symbol !== 'string' || typeof venue !== 'string') continue;
    const key = `${venue}:${symbol}`;
    if (!known.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ symbol, venue });
    if (out.length >= max) break;
  }
  return out;
}
