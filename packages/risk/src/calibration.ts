import type { BucketStats, TradeAnalysis } from '@gladiator/backtest';
import type { AdaptiveGate } from './risk.js';

/**
 * Selbst-Kalibrierung (Patrick 2026-07-03): leitet aus der Rundum-Trade-Analyse
 * RESTRIKTIVE Gates ab — z. B. „keine Longs unter EMA200", wenn die Statistik
 * das belegt. Governance:
 * - Nur Verschärfungen. Positive Buckets erzeugen NIE eine Lockerung.
 * - Kein Gate ohne Mindest-Stichprobe (Low-Sample-Schutz, 13_ §8).
 * - Jedes Gate trägt seine Evidenz (Trades, Expectancy, WinRate) im Klartext —
 *   Patrick sieht WARUM und kann jedes Gate deaktivieren (Mensch im Loop).
 */

export type CalibrationOptions = {
  /** Mindest-Trades pro Bucket, bevor ein Gate entstehen darf. */
  minSample?: number;
  /** Expectancy-Schwelle: Gate nur, wenn Expectancy ≤ dieser Wert (Default 0 − Toleranz 0.05). */
  maxExpectancyR?: number;
  symbol?: string;
  timeframe?: string;
};

const DEFAULT_MIN_SAMPLE = 30;
const DEFAULT_MAX_EXPECTANCY = -0.05;

function shouldGate(stats: BucketStats | undefined, minSample: number, maxExpectancy: number): stats is BucketStats {
  return stats !== undefined && stats.trades >= minSample && stats.expectancyR <= maxExpectancy;
}

function evidence(stats: BucketStats) {
  return { trades: stats.trades, expectancyR: stats.expectancyR, winRate: stats.winRate };
}

export function deriveAdaptiveGates(analysis: TradeAnalysis, opts: CalibrationOptions = {}): AdaptiveGate[] {
  const minSample = opts.minSample ?? DEFAULT_MIN_SAMPLE;
  const maxExp = opts.maxExpectancyR ?? DEFAULT_MAX_EXPECTANCY;
  const scope = { symbol: opts.symbol, timeframe: opts.timeframe };
  const gates: AdaptiveGate[] = [];

  // Richtung × EMA200-Regime (z. B. long|below)
  for (const [key, stats] of Object.entries(analysis.byDirectionRegime)) {
    if (!shouldGate(stats, minSample, maxExp)) continue;
    const [direction, emaRegime] = key.split('|') as ['long' | 'short', 'above' | 'below'];
    const regimeText = emaRegime === 'below' ? 'unter EMA200' : 'über EMA200';
    gates.push({
      kind: 'block',
      direction,
      emaRegime,
      ...scope,
      reason: `${direction === 'long' ? 'Longs' : 'Shorts'} ${regimeText}: Expectancy ${stats.expectancyR.toFixed(2)} R über ${stats.trades} Trades (WinRate ${(stats.winRate * 100).toFixed(0)} %).`,
      evidence: evidence(stats),
    });
  }

  // Sessions
  for (const [session, stats] of Object.entries(analysis.bySession)) {
    if (!shouldGate(stats, minSample, maxExp)) continue;
    gates.push({
      kind: 'block',
      session,
      ...scope,
      reason: `Session ${session}: Expectancy ${stats.expectancyR.toFixed(2)} R über ${stats.trades} Trades (WinRate ${(stats.winRate * 100).toFixed(0)} %).`,
      evidence: evidence(stats),
    });
  }

  // Marktphasen
  for (const phase of ['bull', 'bear'] as const) {
    const stats = analysis.byPhase[phase];
    if (!shouldGate(stats, minSample, maxExp)) continue;
    gates.push({
      kind: 'block',
      marketPhase: phase,
      ...scope,
      reason: `Marktphase ${phase}: Expectancy ${stats.expectancyR.toFixed(2)} R über ${stats.trades} Trades (WinRate ${(stats.winRate * 100).toFixed(0)} %).`,
      evidence: evidence(stats),
    });
  }

  return gates;
}
