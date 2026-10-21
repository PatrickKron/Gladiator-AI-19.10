/**
 * Eingabe-Bedingungen von Indikatoren (Pine `input(... active=...)`), rein und
 * ohne Bibliothek auswertbar — dieselbe Wahrheit für Server (Bereinigung) und
 * Browser (Einstellungs-Dialog: inaktive Felder ausgegraut).
 */

export type InputCondition =
  | string
  | { input: string; eq?: unknown; ne?: unknown }
  | { not: InputCondition }
  | { any: InputCondition[] }
  | { all: InputCondition[] };

/** Ist eine Eingabe laut `active`-Bedingung gerade editierbar? Ein String nennt einen bool-Input. */
export function inputActive(cond: InputCondition | boolean | undefined, values: Record<string, unknown>): boolean {
  if (cond === undefined) return true;
  if (typeof cond === 'boolean') return cond;
  if (typeof cond === 'string') return Boolean(values[cond]);
  if ('not' in cond) return !inputActive(cond.not, values);
  if ('any' in cond) return cond.any.some((c) => inputActive(c, values));
  if ('all' in cond) return cond.all.every((c) => inputActive(c, values));
  const v = values[cond.input];
  if ('eq' in cond) return v === cond.eq;
  if ('ne' in cond) return v !== cond.ne;
  return Boolean(v);
}
