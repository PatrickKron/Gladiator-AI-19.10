/**
 * Monte-Carlo über die Trade-Reihenfolge (Repo-Masterliste, Phase 4): Wie
 * robust ist ein Backtest gegen Glück in der Reihenfolge? Die R-Multiples der
 * echten Trades (netto) werden gemischt (Permutation) oder mit Zurücklegen
 * gezogen (Bootstrap); jede Simulation läuft mit demselben Risiko je Trade
 * (Anteil des aktuellen Kapitals, wie die Engine) und ergibt Endrendite,
 * maximalen Drawdown und längste Verlustserie. Deterministisch über `seed`
 * (mulberry32) — gleiche Eingabe, gleiche Zahlen. Keine Kurse werden erfunden:
 * es werden nur die beobachteten Trade-Ergebnisse neu angeordnet.
 */

export type MonteCarloMode = 'shuffle' | 'bootstrap';

export type MonteCarloInput = {
  /** R-Multiples der Trades (netto), in Original-Reihenfolge. */
  rMultiples: number[];
  startEquity: number;
  /** Risiko je Trade in Prozent des aktuellen Kapitals. */
  riskPct: number;
  runs: number;
  seed: number;
  mode?: MonteCarloMode;
  /** Drawdown-Schwellen (%) für die Wahrscheinlichkeiten. */
  drawdownThresholds?: number[];
};

export type Percentiles = { p5: number; p25: number; p50: number; p75: number; p95: number; mean: number };

export type MonteCarloResult = {
  runs: number;
  trades: number;
  seed: number;
  mode: MonteCarloMode;
  riskPct: number;
  finalReturnPct: Percentiles;
  maxDrawdownPct: Percentiles;
  longestLossStreak: Percentiles;
  /** Anteil der Simulationen, deren maximaler Drawdown die Schwelle überschreitet. */
  probDrawdownOver: { pct: number; probability: number }[];
  /** Anteil der Simulationen mit Endkapital unter dem Start. */
  probLoss: number;
  /** Anteil der Simulationen, die auf ≤ 0 fielen (Ruin). */
  probRuin: number;
  /** Fächer: Kapital nach k Trades (Perzentile über alle Simulationen), ≤ 101 Stützstellen. */
  fan: { index: number; p5: number; p25: number; p50: number; p75: number; p95: number }[];
  /** Die beobachtete Original-Reihenfolge zum Vergleich. */
  original: { finalReturnPct: number; maxDrawdownPct: number; longestLossStreak: number };
};

/** mulberry32 — kleiner, deterministischer PRNG (32-bit-Seed). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(xs: number[], rnd: () => number): number[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

function bootstrapped(xs: number[], rnd: () => number): number[] {
  return xs.map(() => xs[Math.floor(rnd() * xs.length)]!);
}

/** Ein Pfad: Kapital nach jedem Trade, max. Drawdown, längste Verlustserie. */
export function simulatePath(rs: number[], startEquity: number, riskPct: number): { equity: number[]; maxDrawdownPct: number; longestLossStreak: number; ruined: boolean } {
  const equity: number[] = [startEquity];
  let eq = startEquity;
  let peak = startEquity;
  let maxDd = 0;
  let streak = 0;
  let longest = 0;
  let ruined = false;
  for (const r of rs) {
    if (!ruined) {
      eq += eq * (riskPct / 100) * r;
      if (eq <= 0) {
        eq = 0;
        ruined = true;
      }
    }
    equity.push(eq);
    if (eq > peak) peak = eq;
    else if (peak > 0) maxDd = Math.max(maxDd, ((peak - eq) / peak) * 100);
    if (r < 0) {
      streak++;
      if (streak > longest) longest = streak;
    } else {
      streak = 0;
    }
  }
  return { equity, maxDrawdownPct: maxDd, longestLossStreak: longest, ruined };
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const w = pos - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
}

function percentiles(values: number[]): Percentiles {
  const s = values.slice().sort((a, b) => a - b);
  return {
    p5: percentile(s, 0.05),
    p25: percentile(s, 0.25),
    p50: percentile(s, 0.5),
    p75: percentile(s, 0.75),
    p95: percentile(s, 0.95),
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

const DEFAULT_THRESHOLDS = [10, 20, 30, 50];
const MAX_FAN_POINTS = 100;

export function runMonteCarlo(input: MonteCarloInput): MonteCarloResult {
  const { rMultiples, startEquity, riskPct } = input;
  const runs = Math.max(1, Math.floor(input.runs));
  const mode: MonteCarloMode = input.mode ?? 'shuffle';
  const thresholds = input.drawdownThresholds ?? DEFAULT_THRESHOLDS;
  if (rMultiples.length === 0) throw new Error('Monte-Carlo braucht mindestens einen Trade.');
  if (!(startEquity > 0)) throw new Error('Startkapital muss positiv sein.');
  if (!(riskPct > 0)) throw new Error('Risiko je Trade muss positiv sein.');

  const rnd = mulberry32(input.seed);
  const n = rMultiples.length;
  const step = Math.max(1, Math.ceil(n / MAX_FAN_POINTS));
  const fanIdx: number[] = [];
  for (let k = 0; k <= n; k += step) fanIdx.push(k);
  if (fanIdx[fanIdx.length - 1] !== n) fanIdx.push(n);
  const fanValues: number[][] = fanIdx.map(() => []);

  const finals: number[] = [];
  const dds: number[] = [];
  const streaks: number[] = [];
  const over = thresholds.map(() => 0);
  let losses = 0;
  let ruins = 0;

  for (let i = 0; i < runs; i++) {
    const rs = mode === 'shuffle' ? shuffled(rMultiples, rnd) : bootstrapped(rMultiples, rnd);
    const path = simulatePath(rs, startEquity, riskPct);
    const final = path.equity[n]!;
    finals.push(((final - startEquity) / startEquity) * 100);
    dds.push(path.maxDrawdownPct);
    streaks.push(path.longestLossStreak);
    thresholds.forEach((th, j) => {
      if (path.maxDrawdownPct > th) over[j]!++;
    });
    if (final < startEquity) losses++;
    if (path.ruined) ruins++;
    fanIdx.forEach((k, j) => fanValues[j]!.push(path.equity[k]!));
  }

  const original = simulatePath(rMultiples, startEquity, riskPct);
  return {
    runs,
    trades: n,
    seed: input.seed,
    mode,
    riskPct,
    finalReturnPct: percentiles(finals),
    maxDrawdownPct: percentiles(dds),
    longestLossStreak: percentiles(streaks),
    probDrawdownOver: thresholds.map((pct, j) => ({ pct, probability: over[j]! / runs })),
    probLoss: losses / runs,
    probRuin: ruins / runs,
    fan: fanIdx.map((k, j) => {
      const s = fanValues[j]!.slice().sort((a, b) => a - b);
      return { index: k, p5: percentile(s, 0.05), p25: percentile(s, 0.25), p50: percentile(s, 0.5), p75: percentile(s, 0.75), p95: percentile(s, 0.95) };
    }),
    original: {
      finalReturnPct: ((original.equity[n]! - startEquity) / startEquity) * 100,
      maxDrawdownPct: original.maxDrawdownPct,
      longestLossStreak: original.longestLossStreak,
    },
  };
}
