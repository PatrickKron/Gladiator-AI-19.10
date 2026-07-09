/**
 * Eigene Chart-Indikatoren (Patrick: „meine eigenen Indikatoren anwenden").
 *
 * Die Mathematik spiegelt EXAKT packages/strategy-engine/src/indicators.ts
 * (EMA mit SMA-Seed und k = 2/(n+1), RSI nach Wilder, Bollinger mit
 * Populations-σ) — damit clientseitig gerechnete Perioden dieselben Werte
 * liefern wie die Server-Serien der Signal-Engine. WARUM Kopie statt Import:
 * @gladiator/strategy-engine ist Server-Code und darf nicht in den Client
 * gebundelt werden (apps/web/CLAUDE.md); diese Funktionen sind pur, ohne
 * Abhängigkeiten und per Vitest gegen Handwerte getestet.
 *
 * Positionen ohne ausreichende Historie sind null — kein Raten (Regel 1).
 */

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA mit SMA-Seed und k = 2/(n+1) — identisch zur Server-Implementierung. */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI nach Wilder (geglättete Gains/Losses) — identisch zur Server-Implementierung. */
export function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * MACD: Linie = EMA(fast) − EMA(slow), Signal = EMA(Linie, signalPeriod),
 * Histogramm = Linie − Signal. Der Signal-EMA läuft nur über den definierten
 * Teil der Linie (kein Raten) — identisch zur Server-Implementierung.
 */
export function macd(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): { macd: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[] } {
  const n = closes.length;
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  const line: (number | null)[] = new Array<number | null>(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (fast[i] != null && slow[i] != null) line[i] = fast[i]! - slow[i]!;
  }

  const firstDefined = line.findIndex((v) => v != null);
  const signal: (number | null)[] = new Array<number | null>(n).fill(null);
  const histogram: (number | null)[] = new Array<number | null>(n).fill(null);
  if (firstDefined !== -1) {
    const defined = line.slice(firstDefined).map((v) => v ?? 0);
    const sig = ema(defined, signalPeriod);
    for (let i = 0; i < sig.length; i++) {
      const idx = firstDefined + i;
      const sv = sig[i] ?? null;
      signal[idx] = sv;
      if (line[idx] != null && sv != null) histogram[idx] = line[idx]! - sv;
    }
  }
  return { macd: line, signal, histogram };
}

/**
 * Bollinger-Bänder: Mittelband = SMA(period), Bänder = ± mult × Standardabweichung
 * (Populations-σ über dasselbe Fenster) — identisch zur Server-Implementierung.
 */
export function bollinger(
  closes: number[],
  period = 20,
  mult = 2,
): { middle: (number | null)[]; upper: (number | null)[]; lower: (number | null)[] } {
  const n = closes.length;
  const middle = sma(closes, period);
  const upper: (number | null)[] = new Array<number | null>(n).fill(null);
  const lower: (number | null)[] = new Array<number | null>(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    const mean = middle[i];
    if (mean == null) continue;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j]! - mean) ** 2;
    const sd = Math.sqrt(variance / period);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { middle, upper, lower };
}

/**
 * Index-basierte Serie → zeitgestempelte, null-freie Chart-Punkte
 * (Spiegel von toTimed in packages/api/src/routers/market.ts).
 */
export function toTimedSeries(times: number[], values: (number | null)[]): { time: number; value: number }[] {
  const out: { time: number; value: number }[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) out.push({ time: times[i]!, value: v });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Konfigurationsmodell des Indikator-Panels (pro Symbol in localStorage)
// ─────────────────────────────────────────────────────────────────────────────

export type MaConfig = { kind: 'ema' | 'sma'; period: number };

export type IndicatorConfig = {
  /** Frei wählbare gleitende Durchschnitte — mehrere gleichzeitig möglich. */
  mas: MaConfig[];
  rsi: { on: boolean; period: number };
  macd: { on: boolean; fast: number; slow: number; signal: number };
  bollinger: { on: boolean; period: number; mult: number };
  /** Slugs der Pine-/DSL-Strategien, deren Signale als Marker erscheinen. */
  strategySlugs: string[];
};

/** Obergrenzen: der Chart lädt max. 400 Kerzen — längere Perioden hätten nie Werte. */
export const PERIOD_MIN = 2;
export const PERIOD_MAX = 400;
export const MAX_MAS = 6;
export const BB_MULT_MIN = 0.5;
export const BB_MULT_MAX = 5;

/**
 * Farbpalette für eigene Durchschnitte — bewusst OHNE die Farben der
 * Standard-EMAs (Amber/Cyan/Violett), damit eigene Linien sofort
 * unterscheidbar sind. Werte aus dem Design-System (var(--color-*)).
 */
export const MA_COLORS = ['#e14ecf', '#2e7cf6', '#3ddc97', '#e8b84b', '#ff5c6c', '#edf1ff'] as const;

/** Default: alles aus — die Standard-Schalter (EMA 20/50/200 …) decken den Normalfall. */
export function defaultIndicatorConfig(): IndicatorConfig {
  return {
    mas: [],
    rsi: { on: false, period: 14 },
    macd: { on: false, fast: 12, slow: 26, signal: 9 },
    bollinger: { on: false, period: 20, mult: 2 },
    strategySlugs: [],
  };
}

/** Ganzzahl aus unbekanntem Input, geklemmt auf [min,max]; sonst Fallback. Pur/testbar. */
export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Wie clampInt, aber ohne Rundung (für den Bollinger-Faktor). */
export function clampFloat(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Unbekanntes JSON (z. B. aus localStorage oder von Hand editiert) → gültige
 * Konfiguration. WARUM streng: kaputte gespeicherte Werte dürfen den Chart
 * nie crashen — ungültige Teile fallen still auf sichere Defaults zurück.
 */
export function sanitizeIndicatorConfig(raw: unknown): IndicatorConfig {
  const def = defaultIndicatorConfig();
  if (typeof raw !== 'object' || raw === null) return def;
  const r = raw as Record<string, unknown>;

  const mas: MaConfig[] = [];
  if (Array.isArray(r.mas)) {
    for (const item of r.mas) {
      if (mas.length >= MAX_MAS) break;
      if (typeof item !== 'object' || item === null) continue;
      const it = item as Record<string, unknown>;
      if (it.kind !== 'ema' && it.kind !== 'sma') continue;
      mas.push({ kind: it.kind, period: clampInt(it.period, PERIOD_MIN, PERIOD_MAX, 20) });
    }
  }

  const rsiRaw = (typeof r.rsi === 'object' && r.rsi !== null ? r.rsi : {}) as Record<string, unknown>;
  const macdRaw = (typeof r.macd === 'object' && r.macd !== null ? r.macd : {}) as Record<string, unknown>;
  const bbRaw = (typeof r.bollinger === 'object' && r.bollinger !== null ? r.bollinger : {}) as Record<string, unknown>;

  // MACD: fast MUSS kleiner als slow sein, sonst wäre die Linie sinnfrei.
  const slow = clampInt(macdRaw.slow, 3, 200, def.macd.slow);
  const fast = Math.min(clampInt(macdRaw.fast, PERIOD_MIN, 100, def.macd.fast), slow - 1);

  const strategySlugs = Array.isArray(r.strategySlugs)
    ? [...new Set(r.strategySlugs.filter((s): s is string => typeof s === 'string' && s.length > 0))].slice(0, 20)
    : [];

  return {
    mas,
    rsi: { on: rsiRaw.on === true, period: clampInt(rsiRaw.period, PERIOD_MIN, 100, def.rsi.period) },
    macd: { on: macdRaw.on === true, fast, slow, signal: clampInt(macdRaw.signal, PERIOD_MIN, 100, def.macd.signal) },
    bollinger: {
      on: bbRaw.on === true,
      period: clampInt(bbRaw.period, PERIOD_MIN, PERIOD_MAX, def.bollinger.period),
      mult: clampFloat(bbRaw.mult, BB_MULT_MIN, BB_MULT_MAX, def.bollinger.mult),
    },
    strategySlugs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dünne, fehlertolerante localStorage-Wrapper (Muster wie lib/chart-tf.ts)
// ─────────────────────────────────────────────────────────────────────────────

const storageKey = (symbol: string) => `gladiator.chartIndicators.${symbol.toUpperCase()}`;

export function loadIndicatorConfig(symbol: string): IndicatorConfig {
  try {
    const raw = localStorage.getItem(storageKey(symbol));
    if (!raw) return defaultIndicatorConfig();
    return sanitizeIndicatorConfig(JSON.parse(raw) as unknown);
  } catch {
    return defaultIndicatorConfig();
  }
}

export function saveIndicatorConfig(symbol: string, cfg: IndicatorConfig): void {
  try {
    localStorage.setItem(storageKey(symbol), JSON.stringify(cfg));
  } catch {
    /* localStorage nicht verfügbar — Auswahl gilt nur für die Laufzeit */
  }
}
