/**
 * Ansicht des Asset-Charts: welche eingebauten Serien er zeigt (EMA, Bollinger,
 * Volumen, Smart-Money-Marker, Signale, RSI/MACD/ATR-Fenster). Reine
 * Browser-Vorliebe in localStorage — keine Daten.
 *
 * Standard wie in v2 (Patrick 2026-10-24: „v2 war näher an dem, was ich will"):
 * BOS/CHoCH, OB/FVG und das RSI-Fenster sind wieder von Anfang an an. Eine
 * gespeicherte Wahl gewinnt immer — der Standard gilt nur ohne eigene Wahl
 * bzw. für Schlüssel, die in der gespeicherten Wahl fehlen.
 */

export const TOGGLE_KEYS = ['ema', 'bollinger', 'volume', 'structure', 'zones', 'liquidity', 'pd', 'signals', 'rsi', 'macd', 'atr'] as const;
export type ToggleKey = (typeof TOGGLE_KEYS)[number];
export type Toggles = Record<ToggleKey, boolean>;

export const DEFAULT_TOGGLES: Readonly<Toggles> = Object.freeze({
  ema: true,
  bollinger: false,
  volume: true,
  structure: true,
  zones: true,
  liquidity: false,
  pd: false,
  signals: true,
  rsi: true,
  macd: false,
  atr: false,
});

/** Die neun Ein-Klick-Chips der Werkzeugzeile — Reihenfolge wie in v2. */
export const CHIP_KEYS: readonly ToggleKey[] = ['ema', 'bollinger', 'volume', 'structure', 'zones', 'signals', 'rsi', 'macd', 'atr'];
/** „Smart Money"-Knopf schaltet diese gemeinsam. */
export const SMC_KEYS: readonly ToggleKey[] = ['structure', 'zones', 'liquidity'];
/** Gruppen im Popover „Ansicht ▾". */
export const BUILTIN_KEYS: readonly ToggleKey[] = ['ema', 'bollinger', 'volume', 'rsi', 'macd', 'atr'];
export const SMC_ALL_KEYS: readonly ToggleKey[] = ['structure', 'zones', 'liquidity', 'pd', 'signals'];

export const TOGGLES_KEY = 'gladiator.chartToggles';

/** Gespeicherter Wert → vollständige Ansicht; Unbekanntes/Kaputtes → Standard (nie ein Absturz). */
export function parseToggles(raw: string | null): Toggles {
  const out: Toggles = { ...DEFAULT_TOGGLES };
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out;
  const rec = parsed as Record<string, unknown>;
  for (const k of TOGGLE_KEYS) {
    const v = rec[k];
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

export function loadToggles(): Toggles {
  try {
    return parseToggles(localStorage.getItem(TOGGLES_KEY));
  } catch {
    return parseToggles(null);
  }
}

export function saveToggles(t: Toggles): void {
  try {
    localStorage.setItem(TOGGLES_KEY, JSON.stringify(t));
  } catch {
    // nur Komfort — ohne localStorage gilt die Wahl für diese Sitzung
  }
}
