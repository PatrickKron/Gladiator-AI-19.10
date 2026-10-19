import type { Candle } from '@gladiator/strategy-engine';

/**
 * Datenqualität vor dem Backtest (08_ §3b): Lücken, 0-Volumen, Spikes.
 * Reine Funktionen — es wird NICHTS interpoliert oder repariert, nur gezählt
 * und ehrlich gemeldet. Das Labor bricht bei zu vielen Lücken ab.
 */

/** Ab diesem Anteil fehlender Kerzen ist ein Backtest nicht belastbar (Lab-Gate). */
export const MAX_GAP_RATIO = 0.05;
/** |z-Score| des Log-Returns, ab dem eine Kerze als Spike/Fehltick gilt. */
export const SPIKE_Z = 8;

export type DataQualityReport = {
  /** Fehlende Kerzen zwischen erster und letzter Kerze (Raster = Timeframe). */
  gaps: number;
  /** Erwartete Kerzen im Raster zwischen firstTs und lastTs (inklusive). */
  expectedBars: number;
  zeroVolumeBars: number;
  /** Log-Returns mit |z| > SPIKE_Z. */
  spikes: number;
  firstTs: Date | null;
  lastTs: Date | null;
  /** true nur ohne jede Auffälligkeit. */
  ok: boolean;
  /** Deutsche Klartext-Warnungen fürs Labor-UI. */
  warnings: string[];
};

const pct = (x: number) => (x * 100).toLocaleString('de-DE', { maximumFractionDigits: 2 });

export function assessDataQuality(candles: Candle[], timeframeMs: number): DataQualityReport {
  if (candles.length === 0) {
    return {
      gaps: 0,
      expectedBars: 0,
      zeroVolumeBars: 0,
      spikes: 0,
      firstTs: null,
      lastTs: null,
      ok: false,
      warnings: ['Keine Kerzen im Zeitraum — Datenqualität nicht prüfbar.'],
    };
  }

  const firstTs = candles[0]!.ts;
  const lastTs = candles[candles.length - 1]!.ts;
  const expectedBars = Math.floor((lastTs.getTime() - firstTs.getTime()) / timeframeMs) + 1;

  // Lücken: jeder Abstand > 1 Timeframe zählt die dazwischen fehlenden Bars
  let gaps = 0;
  let unordered = 0;
  for (let k = 1; k < candles.length; k++) {
    const diff = candles[k]!.ts.getTime() - candles[k - 1]!.ts.getTime();
    if (diff <= 0) {
      unordered++;
      continue;
    }
    const steps = Math.round(diff / timeframeMs);
    if (steps > 1) gaps += steps - 1;
  }

  const zeroVolumeBars = candles.filter((c) => !(c.volume > 0)).length;

  // Spikes: z-Score der Log-Returns (nur aus gültigen positiven Closes)
  const rets: number[] = [];
  for (let k = 1; k < candles.length; k++) {
    const a = candles[k - 1]!.close;
    const b = candles[k]!.close;
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  let spikes = 0;
  if (rets.length >= 2) {
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1));
    if (sd > 0) spikes = rets.filter((r) => Math.abs((r - mean) / sd) > SPIKE_Z).length;
  }

  const warnings: string[] = [];
  if (gaps > 0) {
    warnings.push(
      `${gaps} fehlende Kerzen (${pct(gaps / expectedBars)} % des Zeitraums) — Lücken werden nicht interpoliert; Trades über Lücken sind unsicher.`,
    );
  }
  if (unordered > 0) warnings.push(`${unordered} Kerzen mit doppeltem/rückläufigem Zeitstempel.`);
  if (zeroVolumeBars > 0) warnings.push(`${zeroVolumeBars} Kerzen mit 0-Volumen (Börsen-Ausfall/Wartung möglich).`);
  if (spikes > 0) warnings.push(`${spikes} Preis-Spike(s) mit |z| > ${SPIKE_Z} — mögliche Fehlticks/Ausreißer, Ergebnis prüfen.`);

  return {
    gaps,
    expectedBars,
    zeroVolumeBars,
    spikes,
    firstTs,
    lastTs,
    ok: warnings.length === 0,
    warnings,
  };
}

/** Lab-Gate: zu viele Lücken → Abbruch mit klarer Meldung statt geschöntem Ergebnis. */
export function assertDataQuality(report: DataQualityReport): void {
  if (report.expectedBars === 0) throw new Error('Keine Kerzen im Zeitraum — Backtest nicht belastbar.');
  const ratio = report.gaps / report.expectedBars;
  if (ratio > MAX_GAP_RATIO) {
    throw new Error(
      `Datenlücken zu groß: ${report.gaps} von ${report.expectedBars} Kerzen fehlen (${pct(ratio)} % > ${pct(MAX_GAP_RATIO)} %) — Backtest nicht belastbar. Bitte Historie nachladen.`,
    );
  }
}

export type FundingPoint = { ts: Date; rate: number };

/**
 * Funding-Snapshots (der Sync schreibt alle 30 min die aktuelle Rate) →
 * echte Settlement-Zeitpunkte. Binance-Perps rechnen alle 8h ab (00/08/16 UTC);
 * je Settlement gilt der LETZTE Snapshot im vorangehenden Intervall (ts ≤ Settlement).
 * Ohne Snapshot im Intervall fehlt das Settlement (kein Auffüllen) → `coverage` < 1.
 */
export function fundingSettlements(
  snapshots: FundingPoint[],
  from: Date,
  to: Date,
  intervalHours = 8,
): { series: FundingPoint[]; coverage: number } {
  const step = intervalHours * 3_600_000;
  const sorted = [...snapshots].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const series: FundingPoint[] = [];
  let total = 0;
  let cursor = 0;
  // Erstes Settlement strikt nach `from` (Fenster (from, to])
  for (let s = Math.floor(from.getTime() / step) * step + step; s <= to.getTime(); s += step) {
    total++;
    // Zeiger bis zum letzten Snapshot ≤ s vorziehen
    while (cursor < sorted.length && sorted[cursor]!.ts.getTime() <= s) cursor++;
    const last = sorted[cursor - 1];
    if (last && last.ts.getTime() > s - step) series.push({ ts: new Date(s), rate: last.rate });
  }
  return { series, coverage: total === 0 ? 1 : series.length / total };
}
