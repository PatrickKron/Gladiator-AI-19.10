import { inputActive } from '@gladiator/core/indicator-inputs';
import type { CatalogEntry, InputDecl } from './catalog.js';

/**
 * Nutzer-Eingaben eines Indikators gegen seine Deklaration bereinigen: Typ,
 * Grenzen, Optionen. Unbekannte Schlüssel fallen weg, ungültige Werte werden
 * durch den Default ersetzt (nie raten, nie ungeprüft an `calculate`).
 */

export const SOURCE_TYPES = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'volume'] as const;

const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/i;

const clamp = (n: number, min?: number, max?: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));

function toNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(',', '.')) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/** Einen Wert gegen eine Eingabe-Deklaration bereinigen; null = ungültig (Default nehmen). */
export function sanitizeInput(decl: InputDecl, raw: unknown): unknown | null {
  switch (decl.type) {
    case 'int': {
      const n = toNumber(raw);
      return n === null ? null : clamp(Math.round(n), decl.min, decl.max);
    }
    case 'float': {
      const n = toNumber(raw);
      return n === null ? null : clamp(n, decl.min, decl.max);
    }
    case 'bool':
      return typeof raw === 'boolean' ? raw : raw === 'true' ? true : raw === 'false' ? false : null;
    case 'string':
    case 'timeframe':
    case 'session':
      if (typeof raw !== 'string') return null;
      if (decl.options && decl.options.length > 0) return decl.options.includes(raw) ? raw : null;
      // ohne Optionsliste: Zeitrahmen/Session nicht frei editierbar (Pine-Syntax) → Default
      return decl.type === 'string' && raw.length <= 64 ? raw : null;
    case 'text_area':
      return typeof raw === 'string' && raw.length <= 2000 ? raw : null;
    case 'source':
      return typeof raw === 'string' && (SOURCE_TYPES as readonly string[]).includes(raw) ? raw : null;
    case 'color':
      return typeof raw === 'string' && COLOR_RE.test(raw.trim()) ? raw.trim() : null;
    case 'time': {
      const n = toNumber(raw);
      return n === null || n < 0 ? null : Math.round(n);
    }
    case 'symbol':
      // fremde Symbole lädt der Server nicht nach → Default
      return null;
    default:
      return null;
  }
}

/** Defaults + bereinigte Nutzerwerte; unbekannte Schlüssel verworfen. */
export function sanitizeInputs(entry: CatalogEntry, raw: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry.defaultInputs };
  if (!raw || typeof raw !== 'object') return out;
  for (const decl of entry.inputs) {
    if (!(decl.id in raw)) continue;
    const v = sanitizeInput(decl, raw[decl.id]);
    if (v !== null) out[decl.id] = v;
  }
  return out;
}

export { inputActive };
