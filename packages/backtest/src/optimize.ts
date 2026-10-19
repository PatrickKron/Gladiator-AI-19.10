import { parseInstructionDsl, type Candle, type InstructionDsl, type SmcCoreParams } from '@gladiator/strategy-engine';
import type { BacktestConfig, BacktestTrade, Evaluator } from './engine.js';
import { computeMetrics, type Metrics } from './metrics.js';
import { evaluateBacktestValidity, holdoutMetrics, type HoldoutMetrics, type ValidityCheck, type ValidityVerdict } from './validity.js';
import { runWalkForward } from './walkforward.js';

/**
 * Nacht-Optimierung (08_ §4/§5): kleines Parameter-Grid → Walk-Forward
 * (IS optimieren, OOS validieren) → Vergleich mit der AKTUELLEN Version auf
 * DENSELBEN OOS-Fenstern. Nur bei klarem Netto-Vorsprung entsteht ein
 * VORSCHLAG — scharf geschaltet wird hier nichts (Mensch im Loop, Regel 7).
 *
 * Rein und deterministisch: die DB-Anbindung (Kerzen, Funding, Persistenz)
 * liegt im Job (@gladiator/jobs), damit Labor und Nacht-Lauf dieselbe Engine
 * benutzen (eine Wahrheit).
 */

/** Obergrenze je Grid — hält die Laufzeit des Nacht-Jobs beschränkt. */
export const MAX_GRID = 12;

/** „Klar besser" heißt: alle diese Schwellen auf den kombinierten OOS-Kennzahlen. */
export type OptimizationThresholds = {
  /** Mindest-Trades des Kandidaten über alle OOS-Fenster. */
  minOosTrades: number;
  /** OOS-Erwartung muss um mindestens so viele R besser sein als die aktuelle Version. */
  minExpectancyGainR: number;
  /** OOS-Profit-Factor muss ≥ Baseline × Faktor sein (und echt größer). */
  minProfitFactorRatio: number;
  /** Der vorgeschlagene Satz muss mindestens diesen Anteil der IS-Fenster gewonnen haben. */
  minWinShare: number;
};

export const OPTIMIZATION_THRESHOLDS: OptimizationThresholds = {
  minOosTrades: 30,
  minExpectancyGainR: 0.05,
  minProfitFactorRatio: 1.1,
  minWinShare: 0.5,
};

/** Stabile Identität eines Parametersatzes (Schlüssel-Reihenfolge egal). */
export function paramsKey(p: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(p));
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function uniqueByKey<T>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((p) => {
    const k = paramsKey(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * SMC-Core-Grid (≤ 9): Swing-Pivot-Breite (±2 Bars, links/rechts gleich
 * verschoben) × EMA-Retest-Nähe (×0,75 / ×1 / ×1,5). Bewusst klein — die
 * übrigen Parameter bleiben wie in der aktuellen Version.
 */
export function smcCoreGrid(current: SmcCoreParams): SmcCoreParams[] {
  const out: SmcCoreParams[] = [];
  for (const d of [-2, 0, 2]) {
    for (const f of [0.75, 1, 1.5]) {
      out.push({
        ...current,
        swingLeftBars: clamp(current.swingLeftBars + d, 2, 30),
        swingRightBars: clamp(current.swingRightBars + d, 2, 30),
        emaProximityPct: f === 1 ? current.emaProximityPct : clamp(round2(current.emaProximityPct * f), 0.1, 10),
      });
    }
  }
  return uniqueByKey(out).slice(0, MAX_GRID);
}

/**
 * DSL-Grid (≤ 12): nur Risiko-/Exit-Parameter — Stop (×0,75/×1/×1,25,
 * ATR-Multiplikator oder %), alle TP-RR gemeinsam (×0,8/×1/×1,25) und
 * Trailing-Stop-Varianten. Einstiegslogik, Symbol, Richtung bleiben unberührt.
 * Jede Variante wird gegen das DSL-Schema validiert (nichts Ungültiges).
 */
export function dslGrid(dsl: InstructionDsl): InstructionDsl[] {
  const withStop = (f: number): InstructionDsl['stopLoss'] =>
    f === 1
      ? dsl.stopLoss
      : dsl.stopLoss.type === 'ATR'
        ? { type: 'ATR', mult: clamp(round2(dsl.stopLoss.mult * f), 0.01, 10) }
        : { type: 'pct', pct: clamp(round2(dsl.stopLoss.pct * f), 0.01, 50) };
  const withTps = (f: number): InstructionDsl['takeProfits'] =>
    f === 1 ? dsl.takeProfits : dsl.takeProfits.map((tp) => ({ rr: clamp(round2(tp.rr * f), 0.01, 20) }));

  const raw: unknown[] = [];
  for (const s of [0.75, 1, 1.25]) {
    for (const t of [0.8, 1, 1.25]) raw.push({ ...dsl, stopLoss: withStop(s), takeProfits: withTps(t) });
  }
  // Trailing-Varianten auf dem unveränderten Stop/TP-Satz
  const withoutTrail: InstructionDsl = { ...dsl };
  delete withoutTrail.trailingStop;
  const trailVariants: (number | null)[] = dsl.trailingStop
    ? [null, clamp(round2(dsl.trailingStop.pct / 2), 0.1, 50), clamp(round2(dsl.trailingStop.pct * 2), 0.1, 50)]
    : [1, 3];
  for (const pct of trailVariants) raw.push(pct === null ? withoutTrail : { ...withoutTrail, trailingStop: { pct } });

  const valid: InstructionDsl[] = [];
  for (const candidate of raw) {
    const parsed = parseInstructionDsl(candidate);
    if (parsed.ok) valid.push(parsed.dsl);
  }
  return uniqueByKey(valid).slice(0, MAX_GRID);
}

/**
 * Vorschlag = der Satz, der die meisten IS-Fenster gewonnen hat (Stabilität);
 * bei Gleichstand der jüngere Sieger. `winners` in chronologischer Reihenfolge.
 */
export function pickProposal<P>(winners: P[]): { params: P; wins: number; total: number } | null {
  if (winners.length === 0) return null;
  const stats = new Map<string, { params: P; wins: number; lastIdx: number }>();
  winners.forEach((p, idx) => {
    const k = paramsKey(p);
    const s = stats.get(k);
    if (s) {
      s.wins++;
      s.lastIdx = idx;
    } else stats.set(k, { params: p, wins: 1, lastIdx: idx });
  });
  let best: { params: P; wins: number; lastIdx: number } | null = null;
  for (const s of stats.values()) {
    if (!best || s.wins > best.wins || (s.wins === best.wins && s.lastIdx > best.lastIdx)) best = s;
  }
  return { params: best!.params, wins: best!.wins, total: winners.length };
}

export type OptimizationJudgeInput = {
  /** Aktuelle Version, OOS über dieselben Fenster (feste Parameter). */
  baseline: Metrics;
  /** Walk-Forward mit Grid (IS-Sieger je Fenster), kombiniert OOS. */
  candidate: Metrics;
  /** Jüngster Abschnitt der OOS-Strecke des Kandidaten. */
  holdout: HoldoutMetrics;
  differsFromCurrent: boolean;
  wins: number;
  windows: number;
};

const fmtR = (n: number | null) => (n === null ? '—' : `${n.toFixed(2)} R`);
const fmtPf = (n: number | null, trades: number) => (trades === 0 ? '—' : n === null ? '∞' : n.toFixed(2));

/**
 * Entscheidet, ob ein Vorschlag entsteht. Konservativ: JEDE Bedingung muss
 * halten; der Kandidat muss zusätzlich das reguläre Validitäts-Gate inkl.
 * Holdout bestehen (dasselbe Gate wie vor jeder Promotion).
 */
export function judgeOptimization(
  input: OptimizationJudgeInput,
  thresholds: OptimizationThresholds = OPTIMIZATION_THRESHOLDS,
): ValidityVerdict {
  const { baseline: b, candidate: c } = input;
  const checks: ValidityCheck[] = [];

  checks.push({
    name: 'differs',
    passed: input.differsFromCurrent,
    detail: input.differsFromCurrent
      ? 'Vorgeschlagene Parameter unterscheiden sich von der aktuellen Version'
      : 'Bester Satz ist die aktuelle Version — nichts vorzuschlagen',
  });

  const share = input.windows > 0 ? input.wins / input.windows : 0;
  const stable = input.windows > 0 && share >= thresholds.minWinShare;
  checks.push({
    name: 'stability',
    passed: stable,
    detail: `IS-Sieger in ${input.wins} von ${input.windows} Fenstern (≥ ${Math.round(thresholds.minWinShare * 100)} % nötig)`,
  });

  const tradesOk = c.tradeCount >= thresholds.minOosTrades;
  checks.push({
    name: 'oosTrades',
    passed: tradesOk,
    detail: `${c.tradeCount} OOS-Trades (≥ ${thresholds.minOosTrades} nötig)`,
  });

  // Baseline ohne Trades: Erwartung 0 R / PF 0 als neutrale Referenz.
  const baseExp = b.tradeCount === 0 ? 0 : (b.expectancy ?? 0);
  const candExp = c.expectancy;
  const expOk = candExp !== null && candExp - baseExp >= thresholds.minExpectancyGainR;
  checks.push({
    name: 'expectancyGain',
    passed: expOk,
    detail: `OOS-Erwartung ${fmtR(candExp)} vs. aktuell ${fmtR(b.tradeCount === 0 ? null : b.expectancy)} (Vorsprung ≥ ${thresholds.minExpectancyGainR} R nötig)`,
  });

  const pfOf = (m: Metrics) => (m.tradeCount === 0 ? 0 : (m.profitFactor ?? Infinity));
  const basePf = pfOf(b);
  const candPf = pfOf(c);
  const pfOk = c.tradeCount > 0 && candPf > basePf && candPf >= basePf * thresholds.minProfitFactorRatio;
  checks.push({
    name: 'profitFactorGain',
    passed: pfOk,
    detail: `OOS-Profit-Factor ${fmtPf(c.profitFactor, c.tradeCount)} vs. aktuell ${fmtPf(b.profitFactor, b.tradeCount)} (≥ ×${thresholds.minProfitFactorRatio} nötig)`,
  });

  const validity = evaluateBacktestValidity({ ...c, holdout: input.holdout });
  checks.push({
    name: 'validity',
    passed: validity.passed,
    detail: validity.passed
      ? 'Validitäts-Gate inkl. jüngstem OOS-Abschnitt bestanden'
      : `Validitäts-Gate nicht bestanden: ${validity.reasons.join(' · ')}`,
  });

  const failed = checks.filter((x) => !x.passed);
  return { passed: failed.length === 0, checks, reasons: failed.map((x) => x.detail) };
}

export type StudyMarket = {
  /** Anzeige-Schlüssel, z. B. „BTC/USDT 4h". */
  key: string;
  candles: Candle[];
  /** Engine-Basis inkl. Kostenmodell, Funding-Serie, Trailing (wie im Labor). */
  base: Omit<BacktestConfig, 'evaluate'>;
};

export type OptimizationSpec<P> = {
  current: P;
  grid: P[];
  makeEvaluator: (params: P) => Evaluator;
  isBars: number;
  oosBars: number;
  warmupBars?: number;
  thresholds?: OptimizationThresholds;
};

export type OptimizationStudy<P> = {
  markets: {
    key: string;
    windows: number;
    baselineOos: Metrics;
    candidateOos: Metrics;
    winners: { oosFrom: string; oosTo: string; params: P }[];
  }[];
  /** Anzahl OOS-Fenster über alle Märkte. */
  windows: number;
  /** Tatsächlich geprüftes Grid (inkl. aktueller Version). */
  grid: P[];
  gridSize: number;
  /** Kombinierte OOS-Kennzahlen (alle Märkte gepoolt, netto). */
  baseline: Metrics;
  candidate: Metrics;
  holdout: HoldoutMetrics | null;
  oosFrom: Date | null;
  oosTo: Date | null;
  proposal: { params: P; wins: number; total: number } | null;
  verdict: ValidityVerdict;
};

/** Trades mehrerer Märkte chronologisch zu einer Netto-Kennzahl zusammenführen. */
function pooled(trades: BacktestTrade[], initialEquity: number, barsPerYear: number): Metrics {
  const sorted = [...trades].sort((a, b) => a.exitTs.getTime() - b.exitTs.getTime());
  const steps = [initialEquity];
  for (const t of sorted) steps.push(steps[steps.length - 1]! + t.netPnl);
  return computeMetrics(sorted, steps, { barsPerYear });
}

/**
 * Führt die Studie aus: je Markt (a) Walk-Forward NUR mit der aktuellen
 * Version (= ihr OOS-Ergebnis auf den Fenstern) und (b) Walk-Forward mit dem
 * Grid (IS-Optimierung → OOS). Beide nutzen exakt dieselben Fenster.
 */
export function runOptimizationStudy<P>(markets: StudyMarket[], spec: OptimizationSpec<P>): OptimizationStudy<P> {
  const currentKey = paramsKey(spec.current);
  const grid = spec.grid.some((p) => paramsKey(p) === currentKey) ? spec.grid : [spec.current, ...spec.grid];
  if (grid.length > MAX_GRID) throw new Error(`Parameter-Grid zu groß (${grid.length} > ${MAX_GRID}).`);

  const out: OptimizationStudy<P>['markets'] = [];
  const baseTrades: BacktestTrade[] = [];
  const candTrades: BacktestTrade[] = [];
  const allWinners: { ts: number; params: P }[] = [];
  let oosFrom: Date | null = null;
  let oosTo: Date | null = null;
  const first = markets[0];

  for (const m of markets) {
    const wfConfig = { isBars: spec.isBars, oosBars: spec.oosBars, warmupBars: spec.warmupBars ?? 0, base: m.base };
    const baseline = runWalkForward(m.candles, { ...wfConfig, paramGrid: [spec.current], makeEvaluator: spec.makeEvaluator });
    const candidate = runWalkForward(m.candles, { ...wfConfig, paramGrid: grid, makeEvaluator: spec.makeEvaluator });
    baseTrades.push(...baseline.oosTrades);
    candTrades.push(...candidate.oosTrades);

    const winners = candidate.windows.map((w) => {
      const from = m.candles[w.oosStart]!.ts;
      const to = m.candles[w.oosEnd - 1]!.ts;
      if (!oosFrom || from < oosFrom) oosFrom = from;
      if (!oosTo || to > oosTo) oosTo = to;
      allWinners.push({ ts: from.getTime(), params: w.bestParams });
      return { oosFrom: from.toISOString(), oosTo: to.toISOString(), params: w.bestParams };
    });
    out.push({
      key: m.key,
      windows: candidate.windows.length,
      baselineOos: baseline.combinedOos,
      candidateOos: candidate.combinedOos,
      winners,
    });
  }

  const initialEquity = first?.base.initialEquity ?? 10_000;
  const barsPerYear = first?.base.barsPerYear ?? 8760;
  const baseline = pooled(baseTrades, initialEquity, barsPerYear);
  const candidate = pooled(candTrades, initialEquity, barsPerYear);
  const windows = out.reduce((a, m) => a + m.windows, 0);
  const proposal = pickProposal(allWinners.sort((a, b) => a.ts - b.ts).map((w) => w.params));
  const holdout = oosFrom && oosTo ? holdoutMetrics(candTrades, oosFrom, oosTo) : null;

  const verdict: ValidityVerdict =
    proposal && holdout
      ? judgeOptimization(
          {
            baseline,
            candidate,
            holdout,
            differsFromCurrent: paramsKey(proposal.params) !== currentKey,
            wins: proposal.wins,
            windows: proposal.total,
          },
          spec.thresholds,
        )
      : {
          passed: false,
          checks: [{ name: 'windows', passed: false, detail: 'Kein vollständiges IS/OOS-Fenster — zu wenig echte Kerzen.' }],
          reasons: ['Kein vollständiges IS/OOS-Fenster — zu wenig echte Kerzen.'],
        };

  return { markets: out, windows, grid, gridSize: grid.length, baseline, candidate, holdout, oosFrom, oosTo, proposal, verdict };
}

export type ParamChange = { path: string; from: unknown; to: unknown };

/** Flache Liste der geänderten Parameter-Pfade (a = aktuell, b = Vorschlag); fehlend = null. */
export function diffParams(a: unknown, b: unknown): ParamChange[] {
  const flat = (v: unknown, prefix: string, out: Map<string, unknown>) => {
    if (v !== null && typeof v === 'object') {
      const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
      for (const [k, x] of entries) flat(x, prefix ? `${prefix}.${k}` : k, out);
    } else if (v !== undefined) out.set(prefix, v);
    return out;
  };
  const fa = flat(a, '', new Map());
  const fb = flat(b, '', new Map());
  const keys = [...new Set([...fa.keys(), ...fb.keys()])].sort();
  return keys
    .filter((k) => fa.get(k) !== fb.get(k))
    .map((k) => ({ path: k, from: fa.has(k) ? fa.get(k) : null, to: fb.has(k) ? fb.get(k) : null }));
}

/** Prüf-Status eines Vorschlags (in `optimizations.results.review` — Status-Enum bleibt 'done'). */
export type ProposalReviewState = 'open' | 'accepted' | 'rejected' | 'superseded';

export type ProposalMetricsSummary = Pick<
  Metrics,
  'tradeCount' | 'netPnl' | 'winRate' | 'profitFactor' | 'expectancy' | 'maxDrawdownPct' | 'netReturnPct' | 'sharpe'
>;

/**
 * Gespeichertes Ergebnis einer Nacht-Optimierung (`optimizations.results`).
 * Eine Zeile entsteht NUR, wenn der Kandidat klar besser ist; die neue Version
 * legt erst ein Mensch per „Übernehmen" an (als draft → reguläres Promotions-Gate).
 */
export type OptimizationProposalResults = {
  kind: 'smc' | 'dsl';
  strategySlug: string;
  baseVersion: number;
  review: { state: ProposalReviewState; at: string | null; newVersionId?: string; newVersion?: number; reason?: string };
  window: { from: string; to: string; oosFrom: string | null; oosTo: string | null; windows: number; isBars: number; oosBars: number };
  before: ProposalMetricsSummary;
  after: ProposalMetricsSummary;
  holdout: { fromTs: string; tradeCount: number; expectancy: number | null; profitFactor: number | null } | null;
  wins: number;
  checks: ValidityCheck[];
  changes: ParamChange[];
  markets: {
    key: string;
    windows: number;
    before: ProposalMetricsSummary;
    after: ProposalMetricsSummary;
    fundingSource: 'historical' | 'model';
    dataWarnings: string[];
  }[];
};

export function summarizeMetrics(m: Metrics): ProposalMetricsSummary {
  return {
    tradeCount: m.tradeCount,
    netPnl: Math.round(m.netPnl * 100) / 100,
    winRate: m.winRate,
    profitFactor: m.profitFactor,
    expectancy: m.expectancy,
    maxDrawdownPct: m.maxDrawdownPct,
    netReturnPct: m.netReturnPct,
    sharpe: m.sharpe,
  };
}

/** Review-Status aus dem gespeicherten JSON lesen (fehlend → 'open', damit nichts verschwindet). */
export function readProposalState(results: unknown): ProposalReviewState {
  const s = (results as { review?: { state?: unknown } } | null)?.review?.state;
  return s === 'accepted' || s === 'rejected' || s === 'superseded' || s === 'open' ? s : 'open';
}
