/**
 * Labor-Schnellstart (P1.6): merkt die zuletzt genutzte Backtest-Konfiguration
 * in localStorage. `parseLabConfig` ist rein/testbar; load/save sind dünne,
 * fehlertolerante Wrapper.
 */

export type LabConfig = { symbol: string; timeframe: string; setupType: string; riskPct: number };

const KEY = 'gladiator.lab.lastConfig';

/** Validiert JSON zu einer LabConfig; ungültig/leer → null (kein Teil-Objekt). */
export function parseLabConfig(json: string | null): LabConfig | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    if (
      o &&
      typeof o.symbol === 'string' &&
      typeof o.timeframe === 'string' &&
      typeof o.setupType === 'string' &&
      typeof o.riskPct === 'number' &&
      Number.isFinite(o.riskPct)
    ) {
      return { symbol: o.symbol, timeframe: o.timeframe, setupType: o.setupType, riskPct: o.riskPct };
    }
    return null;
  } catch {
    return null;
  }
}

export function loadLabConfig(): LabConfig | null {
  try {
    return parseLabConfig(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function saveLabConfig(c: LabConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* localStorage nicht verfügbar — ignorieren */
  }
}
