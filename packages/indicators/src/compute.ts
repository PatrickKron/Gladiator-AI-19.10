import type { ChartContext } from 'lightweight-charts-indicators';
import type { Bar, IndicatorResult } from 'oakscriptjs';
import { catalogEntry, extraNeedsOf, PINE_TF_TO_GLADIATOR, registryEntry, type CatalogEntry, type ExtraNeeds } from './catalog.js';
import { sanitizeInputs } from './inputs.js';

/**
 * Serverseitige Rechnung eines Katalog-Indikators auf echten Kerzen. Ergebnis
 * ist JSON (Plots, Linien, Füllungen, Marker, Boxen, Labels …) in genau der
 * Form, die `lightweight-charts-indicators/render` im Browser zeichnet.
 */

export type ComputeBar = Bar;

/** Punkt einer Plot-Serie (Zeit in Sekunden). */
export type PlotPoint = { time: number; value: number; color?: string };

export type IndicatorOutput = Omit<IndicatorResult, 'metadata' | 'plots'> & {
  plots: Record<string, PlotPoint[]>;
};

export class IndicatorComputeError extends Error {
  constructor(
    readonly indicatorId: string,
    message: string,
  ) {
    super(message);
    this.name = 'IndicatorComputeError';
  }
}

/** Kerzen der Engine/DB (ts als Date) → Bibliotheks-Bars (Sekunden). */
export function candlesToBars(candles: { ts: Date; open: number; high: number; low: number; close: number; volume: number }[]): ComputeBar[] {
  return candles.map((c) => ({ time: Math.floor(c.ts.getTime() / 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
}

/** Kleinster Preisschritt aus den Nachkommastellen der Kurse (für Pine `syminfo.mintick`). */
export function minTickOf(bars: ComputeBar[]): number {
  let decimals = 0;
  for (const b of bars.slice(-50)) {
    const s = String(b.close);
    const i = s.indexOf('.');
    if (i >= 0) decimals = Math.max(decimals, Math.min(8, s.length - i - 1));
  }
  return 10 ** -decimals;
}

export type ComputeContext = {
  /** Chart-Zeitrahmen in Pine-Schreibweise ("60", "1D") */
  timeframe?: string;
  tickerid?: string;
  currency?: string;
  /** Ist die letzte Kerze geschlossen? (false = Live-Kerze) */
  lastBarConfirmed?: boolean;
  /** Kerzen desselben Symbols in anderen Zeitrahmen (Gladiator-Schreibweise), für Pivots u. Ä. */
  extraBars?: Record<string, ComputeBar[]>;
};

const TF_PINE: Record<string, string> = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '12h': '720', '1d': '1D', '1w': '1W', '1M': '1M' };

/** Gladiator-Zeitrahmen → Pine-Schreibweise. */
export function pineTimeframe(tf: string): string {
  return TF_PINE[tf] ?? tf;
}

/** Nicht-serialisierbare / unnötige Teile entfernen (Funktionen, Alarmwerte). */
function serialize(result: IndicatorResult): IndicatorOutput {
  const { metadata, plots, ...rest } = result as IndicatorResult & { outputValues?: unknown; alerts?: unknown; alertCalls?: unknown };
  void metadata; // steht im Katalog, nicht im Ergebnis
  delete (rest as { outputValues?: unknown }).outputValues;
  delete (rest as { alerts?: unknown }).alerts;
  delete (rest as { alertCalls?: unknown }).alertCalls;
  const cleanPlots: Record<string, PlotPoint[]> = {};
  for (const [id, pts] of Object.entries(plots ?? {})) {
    cleanPlots[id] = (pts as PlotPoint[]).filter((p) => p && Number.isFinite(p.value)).map((p) => (p.color ? { time: p.time, value: p.value, color: p.color } : { time: p.time, value: p.value }));
  }
  return { ...(JSON.parse(JSON.stringify(rest)) as Omit<IndicatorOutput, 'plots'>), plots: cleanPlots };
}

export type ComputeResult = {
  entry: CatalogEntry;
  /** bereinigte, vollständige Eingaben */
  inputs: Record<string, unknown>;
  result: IndicatorOutput;
  ms: number;
};

/** Welche weiteren Zeitrahmen braucht der Indikator mit DIESEN Eingaben (vor dem Laden aus der DB)? */
export function extraNeeds(id: string, rawInputs: Record<string, unknown> | null | undefined, tickerid: string): ExtraNeeds {
  const entry = catalogEntry(id);
  const reg = registryEntry(id);
  if (!entry || !reg) return { timeframes: [], foreign: [], unsupported: [] };
  return extraNeedsOf(reg, sanitizeInputs(entry, rawInputs), tickerid);
}

export function computeIndicator(id: string, bars: ComputeBar[], rawInputs: Record<string, unknown> | null | undefined, ctx: ComputeContext = {}): ComputeResult {
  const entry = catalogEntry(id);
  const reg = registryEntry(id);
  if (!entry || !reg) throw new IndicatorComputeError(id, `Unbekannter Indikator: ${id}`);
  const inputs = sanitizeInputs(entry, rawInputs);
  const tickerid = ctx.tickerid ?? '';
  const extra = ctx.extraBars ?? {};
  const chart: ChartContext = {
    timeframe: ctx.timeframe ?? '60',
    timezone: 'UTC',
    tickerid,
    mintick: minTickOf(bars),
    symbolType: 'crypto',
    currency: ctx.currency ?? 'USD',
    lastBarConfirmed: ctx.lastBarConfirmed ?? true,
    // Kerzen desselben Symbols in anderen Zeitrahmen (Pine request.security)
    bars: (symbol: string, tf: string): ComputeBar[] | undefined => {
      if (symbol !== '' && symbol !== tickerid) return undefined;
      const g = PINE_TF_TO_GLADIATOR[tf];
      return g ? extra[g] : undefined;
    },
  };
  const t0 = performance.now();
  let result: IndicatorResult;
  try {
    result = reg.calculate(bars, inputs, chart) as IndicatorResult;
  } catch (err) {
    // MissingSymbolDataError (Pine request.security): die fehlenden Kerzen ehrlich benennen
    const reqs = (err as { requests?: { symbol: string; timeframe: string }[] } | null)?.requests;
    if (Array.isArray(reqs)) {
      const list = reqs.map((r) => `${r.symbol || 'dieses Symbol'} ${r.timeframe}`).join(', ');
      throw new IndicatorComputeError(id, `Braucht weitere Kerzen (${list}), die nicht vorliegen.`);
    }
    throw new IndicatorComputeError(id, err instanceof Error ? err.message : String(err));
  }
  return { entry, inputs, result: serialize(result), ms: Math.round((performance.now() - t0) * 10) / 10 };
}

/** Zeit der ersten definierten Plot-Kerze (Warmup-Anzeige); null = keine Werte. */
export function firstDefinedTime(result: IndicatorOutput): number | null {
  let first: number | null = null;
  for (const pts of Object.values(result.plots)) {
    const t = pts[0]?.time;
    if (t !== undefined && (first === null || t < first)) first = t;
  }
  return first;
}
