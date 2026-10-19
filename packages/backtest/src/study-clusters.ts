import { and, gte, inArray, like, type SQL } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { clusterKeyLevels, isLegacyClusterKey, parseClusterKey, type ClusterLevel } from '@gladiator/strategy-engine';
import { explainRapsChoice, LEVERAGE_CANDIDATES, rapsGrid, type RapsResult, type TpSchemaId } from './raps.js';

const { studyTrades, studyClusters } = schema;

/**
 * VDB2-Batch (13_ §4–§8): liest VDB1 (`study_trades`, Labor + Paper) im
 * Datenfenster, gruppiert je Cluster (exakt + übergeordnete Ebenen), fährt
 * das RAPS-Gitter und schreibt `study_clusters`. Liefert NUR Vorschläge —
 * angewendet wird nichts automatisch (Mensch im Loop, Risk-Engine deckelt).
 *
 * Umgesetzt (Blueprint-Abgleich, ehrlich):
 *  ✓ 90-Tage-Fenster, λ-Zeitzerfall (rapsGrid), MIN_TRADES_PRO_CLUSTER = 50
 *  ✓ Fallback auf übergeordneten Cluster (getOptimalParams: exakt → Session → Basis)
 *  ✓ Holdout: jüngste 20 % werden NICHT optimiert; L* und S* müssen dort allein
 *    positive Erwartung haben (≥ 10 Trades), sonst keine Empfehlung
 *  ✓ Max. Änderung je Iteration: Hebel höchstens eine Gitter-Stufe ggü. der
 *    Vorwoche (Referenz = jüngster Batch-Eintrag ≥ 6 Tage alt; Zusatzläufe
 *    derselben Woche — Labor, Neustart — zählen nicht als neue Iteration)
 *  ✓ Alpha-Decay-Markierung: RAPS < 50 % der Vorwoche (oder ≤ 0) → markiert
 *  ✓ Negative Erwartung → keine Empfehlung (nie „am wenigsten schlecht")
 *  ✓ Risiko %: Half-Kelly aus dem Trainingsteil, gedeckelt auf 2 %
 *  ✗ Diversity-Check und Signifikanztest (Vorwoche vs. aktuell) — offen
 *  ✗ Calmar (Annual Return braucht eine Equity-Zeitreihe je Cluster) — bleibt null
 *  ✗ Embedding für semantische Suche — bleibt null
 */

export const MIN_TRADES_PER_CLUSTER = 50;
export const STUDY_WINDOW_DAYS = 90;
export const STUDY_LAMBDA_TIME_DECAY = 0.02;
export const STUDY_HOLDOUT_FRACTION = 0.2;
export const MIN_HOLDOUT_TRADES = 10;
/** Risiko-Kandidaten in % (Half-Kelly wird auf den nächstkleineren abgerundet). */
export const RISK_PCT_CANDIDATES = [0.25, 0.5, 0.75, 1, 1.5, 2] as const;
const CHANGELOG_MAX = 20;
const BATCH_SOURCE = 'study-batch';

export type StudyRow = {
  clusterKey: string;
  source: 'lab' | 'paper';
  /** Gleicher Trade aus wiederholten Labor-Läufen zählt nur einmal. */
  dedupeKey: string;
  exitTs: Date;
  rMultiple: number;
  pnlRTpA: number | null;
  pnlRTpB: number | null;
  pnlRTpC: number | null;
  pnlRTpD: number | null;
  /** Max. adverse Bewegung als Anteil des Entry-Preises. */
  maePct: number;
};

export type StudyDbRow = {
  clusterKey: string;
  executedTradeId: string | null;
  direction: 'long' | 'short';
  entryTs: Date;
  exitTs: Date;
  rMultiple: string;
  maeBps: string | null;
  pnlRTpA: string | null;
  pnlRTpB: string | null;
  pnlRTpC: string | null;
  pnlRTpD: string | null;
};

const num = (v: string | null): number | null => (v === null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * DB-Zeile → Studien-Zeile. Verworfen (null): Fremdformat-Keys, Alt-Labor-
 * Zeilen (Key …|all|all ohne Trade-Bezug: mae_bps war dort R×100, nicht bps),
 * Zeilen ohne MAE (Liquidations-Constraint wäre sonst geraten) und Zeilen
 * ganz ohne TP-Schema-Wert.
 */
export function studyRowFromDb(r: StudyDbRow): StudyRow | null {
  if (!parseClusterKey(r.clusterKey)) return null;
  const paper = r.executedTradeId !== null;
  if (!paper && isLegacyClusterKey(r.clusterKey)) return null;
  const mae = num(r.maeBps);
  const rMultiple = num(r.rMultiple);
  if (mae === null || rMultiple === null) return null;
  const tp = [num(r.pnlRTpA), num(r.pnlRTpB), num(r.pnlRTpC), num(r.pnlRTpD)] as const;
  // Ohne jeden Schema-Wert würde die Zeile jedes Schema sperren (rapsGrid: kein Raten).
  if (tp.every((v) => v === null)) return null;
  return {
    clusterKey: r.clusterKey,
    source: paper ? 'paper' : 'lab',
    dedupeKey: paper
      ? `paper|${r.executedTradeId}`
      : `${r.clusterKey}|${r.direction}|${r.entryTs.toISOString()}|${r.exitTs.toISOString()}`,
    exitTs: r.exitTs,
    rMultiple,
    pnlRTpA: tp[0],
    pnlRTpB: tp[1],
    pnlRTpC: tp[2],
    pnlRTpD: tp[3],
    maePct: Math.max(0, mae) / 10_000,
  };
}

/** Dedupe + Zuordnung jeder Zeile zu ihrem exakten UND den übergeordneten Clustern. */
export function groupRowsByCluster(rows: StudyRow[]): Map<string, StudyRow[]> {
  const seen = new Set<string>();
  const out = new Map<string, StudyRow[]>();
  for (const r of rows) {
    if (seen.has(r.dedupeKey)) continue;
    seen.add(r.dedupeKey);
    for (const { key } of clusterKeyLevels(r.clusterKey)) {
      const list = out.get(key) ?? [];
      list.push(r);
      out.set(key, list);
    }
  }
  return out;
}

/** Bisheriger Stand eines Clusters: nur der Changelog (enthält jede frühere Iteration). */
export type PrevCluster = { changelog: unknown[] };

/** Eine „Iteration" = eine Woche (13_ §4 Batch 1×/Woche). */
const ITERATION_MS = 6 * 86_400_000;

type ChangelogEntry = { at?: unknown; source?: unknown; leverage?: unknown; rapsScore?: unknown };

/**
 * Referenz-Iteration = jüngster Batch-Eintrag, der mindestens 6 Tage alt ist
 * (die Vorwoche). So zählen zusätzliche Läufe derselben Woche (Labor-Lauf,
 * Worker-Neustart) nicht als neue Iteration und umgehen die Stufen-Grenze nicht.
 */
function weeklyReference(changelog: unknown[], now: Date): { index: number; leverage: number | null; rapsScore: number | null } | null {
  for (let i = changelog.length - 1; i >= 0; i--) {
    const e = changelog[i] as ChangelogEntry | null;
    if (!e || typeof e !== 'object' || e.source !== BATCH_SOURCE || typeof e.at !== 'string') continue;
    const at = Date.parse(e.at);
    if (!Number.isFinite(at) || now.getTime() - at < ITERATION_MS) continue;
    return {
      index: i,
      leverage: typeof e.leverage === 'number' ? e.leverage : null,
      rapsScore: typeof e.rapsScore === 'number' ? e.rapsScore : null,
    };
  }
  return null;
}

export type ClusterReason = 'low_sample' | 'no_eligible' | 'negative_expectancy' | 'holdout_failed';

export type ClusterComputation = {
  clusterKey: string;
  tradeCount: number;
  paperCount: number;
  labCount: number;
  isLowSampleSize: boolean;
  recommendation: { leverage: number; tpSchema: TpSchemaId; riskPct: number } | null;
  reason: ClusterReason | null;
  raps: RapsResult;
  holdout: { trades: number; meanR: number | null };
  metrics: {
    winrate: number | null;
    profitFactor: number | null;
    expectancy: number | null;
    sharpe: number | null;
    sortino: number | null;
  };
  /** Hebel vor der Begrenzung „eine Stufe je Iteration" (sonst null). */
  clampedFrom: number | null;
  alphaDecay: boolean;
  explanation: string;
  changelog: unknown[];
};

export type ComputeOptions = {
  now: Date;
  minTrades?: number;
  lambdaTimeDecay?: number;
  holdoutFraction?: number;
  windowDays?: number;
};

function rOf(r: StudyRow, s: TpSchemaId | null): number {
  if (s === null) return r.rMultiple;
  const v = s === 'A' ? r.pnlRTpA : s === 'B' ? r.pnlRTpB : s === 'C' ? r.pnlRTpC : r.pnlRTpD;
  return v ?? r.rMultiple;
}

function seriesMetrics(rs: number[]): ClusterComputation['metrics'] {
  if (rs.length === 0) return { winrate: null, profitFactor: null, expectancy: null, sharpe: null, sortino: null };
  const n = rs.length;
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const wins = rs.filter((r) => r > 0);
  const lossSum = rs.filter((r) => r < 0).reduce((a, b) => a + b, 0);
  const std = Math.sqrt(rs.reduce((a, r) => a + (r - mean) ** 2, 0) / n);
  const downside = Math.sqrt(rs.reduce((a, r) => a + Math.min(0, r) ** 2, 0) / n);
  return {
    winrate: wins.length / n,
    profitFactor: lossSum < 0 ? wins.reduce((a, b) => a + b, 0) / Math.abs(lossSum) : null,
    expectancy: mean,
    // Je Trade (nicht annualisiert) — Cluster haben keine gemeinsame Zeitbasis.
    sharpe: std > 0 ? mean / std : null,
    sortino: downside > 0 ? mean / downside : null,
  };
}

/** Half-Kelly auf R-Basis → nächstkleinerer Kandidat (min. 0,25 %, max. 2 %). */
function halfKellyRiskPct(rs: number[]): number | null {
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r < 0);
  if (rs.length === 0 || wins.length === 0) return null;
  const w = wins.length / rs.length;
  const avgWin = wins.reduce((a, b) => a + b, 0) / wins.length;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;
  const kelly = avgLoss === 0 ? 1 : w - (1 - w) / (avgWin / avgLoss);
  if (kelly <= 0) return null;
  const halfPct = (kelly / 2) * 100;
  const fit = RISK_PCT_CANDIDATES.filter((c) => c <= halfPct);
  return fit.length > 0 ? fit[fit.length - 1]! : RISK_PCT_CANDIDATES[0];
}

/** Liquidations-Regel wie rapsGrid: MAE% × L ≥ 100 % ⇒ −1R × L. */
function leveragedR(r: StudyRow, s: TpSchemaId, leverage: number): number {
  return r.maePct * leverage >= 1 ? -leverage : rOf(r, s) * leverage;
}

export function computeCluster(
  clusterKey: string,
  rowsIn: StudyRow[],
  prev: PrevCluster | null,
  opts: ComputeOptions,
): ClusterComputation {
  const minTrades = opts.minTrades ?? MIN_TRADES_PER_CLUSTER;
  const lambda = opts.lambdaTimeDecay ?? STUDY_LAMBDA_TIME_DECAY;
  const rows = [...rowsIn].sort((a, b) => a.exitTs.getTime() - b.exitTs.getTime());
  const n = rows.length;
  const holdoutN = Math.floor(n * (opts.holdoutFraction ?? STUDY_HOLDOUT_FRACTION));
  const training = rows.slice(0, n - holdoutN);
  const holdoutRows = rows.slice(n - holdoutN);
  const isLowSampleSize = n < minTrades;

  const raps = rapsGrid(training, { now: opts.now, lambdaTimeDecay: lambda, minTrades: Math.ceil(minTrades * (1 - STUDY_HOLDOUT_FRACTION)) });
  const best = raps.best;

  let reason: ClusterReason | null = null;
  let holdoutMean: number | null = null;
  if (best && holdoutRows.length > 0) {
    holdoutMean = holdoutRows.reduce((a, r) => a + leveragedR(r, best.tpSchema, best.leverage), 0) / holdoutRows.length;
  }

  if (isLowSampleSize || holdoutN < MIN_HOLDOUT_TRADES) reason = 'low_sample';
  else if (!best) reason = 'no_eligible';
  else if (best.muWeighted <= 0) reason = 'negative_expectancy';
  else if (holdoutMean === null || holdoutMean <= 0) reason = 'holdout_failed';

  const schemaForMetrics = best ? best.tpSchema : null;
  const metrics = seriesMetrics(rows.map((r) => rOf(r, schemaForMetrics)));

  const history = prev?.changelog ?? [];
  const ref = weeklyReference(history, opts.now);
  let recommendation: ClusterComputation['recommendation'] = null;
  let clampedFrom: number | null = null;
  if (reason === null && best) {
    const riskPct = halfKellyRiskPct(training.map((r) => rOf(r, best.tpSchema)));
    if (riskPct === null) {
      reason = 'negative_expectancy';
    } else {
      let leverage = best.leverage;
      // Max. Parameteränderung je Iteration (13_ §8): eine Gitter-Stufe.
      const prevIdx = ref?.leverage != null ? LEVERAGE_CANDIDATES.indexOf(ref.leverage as (typeof LEVERAGE_CANDIDATES)[number]) : -1;
      const newIdx = LEVERAGE_CANDIDATES.indexOf(leverage as (typeof LEVERAGE_CANDIDATES)[number]);
      if (prevIdx >= 0 && Math.abs(newIdx - prevIdx) > 1) {
        clampedFrom = leverage;
        leverage = LEVERAGE_CANDIDATES[prevIdx + Math.sign(newIdx - prevIdx)]!;
      }
      recommendation = { leverage, tpSchema: best.tpSchema, riskPct };
    }
  }

  const newRaps = best ? best.rapsScore : null;
  const alphaDecay =
    ref?.rapsScore != null && ref.rapsScore > 0 && (newRaps === null || newRaps <= 0 || newRaps < ref.rapsScore * 0.5);

  const paperCount = rows.filter((r) => r.source === 'paper').length;
  const labCount = n - paperCount;
  const reasonText: Record<ClusterReason, string> = {
    low_sample: `nur ${n} Trades (Mindeststichprobe ${minTrades}, Holdout ≥ ${MIN_HOLDOUT_TRADES})`,
    no_eligible: 'keine Hebel/TP-Kombination ohne Liquidation',
    negative_expectancy: 'Erwartung nicht positiv',
    holdout_failed: `Holdout (jüngste ${Math.round(STUDY_HOLDOUT_FRACTION * 100)} %) besteht nicht allein (Ø ${holdoutMean?.toFixed(3) ?? '—'}R)`,
  };
  const parts = [
    best ? explainRapsChoice(raps, clusterKey) : `${clusterKey}: kein bewertbares Gitter.`,
    `Basis: ${n} Trades (${labCount} Labor, ${paperCount} Paper), Fenster ${opts.windowDays ?? STUDY_WINDOW_DAYS} Tage, Holdout ${holdoutRows.length}.`,
    recommendation
      ? `Vorschlag: Hebel ${recommendation.leverage}×, TP-Schema ${recommendation.tpSchema}, Risiko ${recommendation.riskPct} % (Half-Kelly).`
      : `Kein Vorschlag: ${reasonText[reason ?? 'no_eligible']}.`,
  ];
  if (clampedFrom !== null) parts.push(`Hebel auf eine Stufe Änderung begrenzt (Gitter wollte ${clampedFrom}×, Vorwoche ${ref!.leverage}×).`);
  if (alphaDecay) parts.push(`Alpha-Decay: RAPS fiel von ${ref!.rapsScore!.toFixed(3)} auf ${newRaps?.toFixed(3) ?? '—'}.`);

  const entry = {
    at: opts.now.toISOString(),
    source: BATCH_SOURCE,
    tradeCount: n,
    paperCount,
    labCount,
    leverage: recommendation?.leverage ?? null,
    tpSchema: recommendation?.tpSchema ?? null,
    riskPct: recommendation?.riskPct ?? null,
    rapsScore: newRaps,
    holdoutMeanR: holdoutMean,
    reason,
    clampedFrom,
    alphaDecay,
  };
  const changelog: unknown[] = [...history, entry].slice(-CHANGELOG_MAX);
  // Wochen-Referenz nie wegkürzen — sonst könnten viele Läufe die Grenze aushebeln.
  if (ref && !changelog.includes(history[ref.index])) changelog.unshift(history[ref.index]);

  return {
    clusterKey,
    tradeCount: n,
    paperCount,
    labCount,
    isLowSampleSize,
    recommendation,
    reason,
    raps,
    holdout: { trades: holdoutRows.length, meanR: holdoutMean },
    metrics,
    clampedFrom,
    alphaDecay,
    explanation: parts.join(' '),
    changelog,
  };
}

const s = (v: number | null): string | null => (v === null || !Number.isFinite(v) ? null : String(v));

/**
 * Wochen-Batch: alle (bzw. per `keyPrefix` eingegrenzte) Cluster neu
 * berechnen. Cluster im Bereich ohne Trades im Fenster werden ehrlich auf
 * „keine Empfehlung" gesetzt — kein veralteter Vorschlag bleibt stehen.
 */
export async function recomputeStudyClusters(
  db: Db,
  opts: { now?: Date; keyPrefix?: string; windowDays?: number } = {},
): Promise<{ clusters: number; recommended: number; rowsUsed: number; rowsSkipped: number }> {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? STUDY_WINDOW_DAYS;
  const since = new Date(now.getTime() - windowDays * 86_400_000);
  // LIKE-Platzhalter im Präfix neutralisieren (Symbole enthalten nur „/", aber sicher ist sicher)
  const prefixPattern = opts.keyPrefix ? `${opts.keyPrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;

  const tradeConds: SQL[] = [gte(studyTrades.exitTs, since)];
  if (prefixPattern) tradeConds.push(like(studyTrades.clusterKey, prefixPattern));
  const dbRows = await db
    .select({
      clusterKey: studyTrades.clusterKey,
      executedTradeId: studyTrades.executedTradeId,
      direction: studyTrades.direction,
      entryTs: studyTrades.entryTs,
      exitTs: studyTrades.exitTs,
      rMultiple: studyTrades.rMultiple,
      maeBps: studyTrades.maeBps,
      pnlRTpA: studyTrades.pnlRTpA,
      pnlRTpB: studyTrades.pnlRTpB,
      pnlRTpC: studyTrades.pnlRTpC,
      pnlRTpD: studyTrades.pnlRTpD,
    })
    .from(studyTrades)
    .where(and(...tradeConds));

  const rows: StudyRow[] = [];
  for (const r of dbRows) {
    const sr = studyRowFromDb(r);
    if (sr) rows.push(sr);
  }
  const grouped = groupRowsByCluster(rows);

  const existing = await db
    .select({
      clusterKey: studyClusters.clusterKey,
      changelog: studyClusters.changelog,
    })
    .from(studyClusters)
    .where(prefixPattern ? like(studyClusters.clusterKey, prefixPattern) : undefined);
  const prevByKey = new Map(existing.map((e) => [e.clusterKey, e]));
  const keys = new Set([...grouped.keys(), ...existing.map((e) => e.clusterKey).filter((k) => parseClusterKey(k) !== null)]);

  let recommended = 0;
  for (const key of keys) {
    const p = prevByKey.get(key);
    const prev: PrevCluster | null = p ? { changelog: Array.isArray(p.changelog) ? p.changelog : [] } : null;
    const c = computeCluster(key, grouped.get(key) ?? [], prev, { now, windowDays });
    if (c.recommendation) recommended++;
    const values = {
      optimalLeverage: c.recommendation ? String(c.recommendation.leverage) : null,
      optimalTpSchemaId: c.recommendation?.tpSchema ?? null,
      optimalRiskPct: c.recommendation ? String(c.recommendation.riskPct) : null,
      rapsScore: c.raps.best ? s(c.raps.best.rapsScore) : null,
      sharpe: s(c.metrics.sharpe),
      sortino: s(c.metrics.sortino),
      calmar: null,
      winrate: s(c.metrics.winrate),
      profitFactor: s(c.metrics.profitFactor),
      expectancy: s(c.metrics.expectancy),
      tradeCount: c.tradeCount,
      dataWindowDays: windowDays,
      lambdaTimeDecay: String(STUDY_LAMBDA_TIME_DECAY),
      isLowSampleSize: c.isLowSampleSize,
      changelog: c.changelog,
      causalityExplanation: c.explanation,
      updatedAt: now,
    };
    await db
      .insert(studyClusters)
      .values({ clusterKey: key, ...values })
      .onConflictDoUpdate({ target: studyClusters.clusterKey, set: values });
  }

  return { clusters: keys.size, recommended, rowsUsed: rows.length, rowsSkipped: dbRows.length - rows.length };
}

// ───────────────────────── getOptimalParams (13_ §7) ─────────────────────────

export type StoredCluster = {
  clusterKey: string;
  optimalLeverage: string | null;
  optimalTpSchemaId: string | null;
  optimalRiskPct: string | null;
  rapsScore: string | null;
  tradeCount: number;
  isLowSampleSize: boolean;
  causalityExplanation: string | null;
  changelog: unknown;
  updatedAt: Date;
};

export type RiskCaps = { maxLeverage: number; riskPctPerTrade: number };

export type OptimalParams =
  | {
      available: true;
      clusterKey: string;
      level: ClusterLevel;
      tradeCount: number;
      leverage: number;
      tpSchema: TpSchemaId;
      riskPct: number;
      rapsScore: number | null;
      /** true = der Cluster-Wert lag über dem Risk-Setting und wurde gedeckelt. */
      capped: { leverage: boolean; riskPct: boolean };
      explanation: string | null;
      updatedAt: Date;
    }
  | {
      available: false;
      reason: 'invalid_key' | 'no_data' | 'low_sample' | 'not_recommended';
      /** Größte gefundene Stichprobe über alle Ebenen. */
      tradeCount: number;
      minTrades: number;
    };

function writtenByBatch(changelog: unknown): boolean {
  if (!Array.isArray(changelog) || changelog.length === 0) return false;
  const last = changelog[changelog.length - 1] as { source?: unknown } | null;
  return last !== null && typeof last === 'object' && last.source === BATCH_SOURCE;
}

const TP_SCHEMA_SET = new Set<string>(['A', 'B', 'C', 'D']);

/**
 * Rein: wählt aus den gespeicherten Clustern (exakt → Session → Basis) die
 * erste belastbare Empfehlung und deckelt sie durch die Risk-Settings.
 * Nur vom Batch geschriebene Zeilen zählen (Alt-Labor-Upserts nicht).
 */
export function pickOptimalParams(
  byKey: Map<string, StoredCluster>,
  clusterKey: string,
  caps: RiskCaps,
  minTrades = MIN_TRADES_PER_CLUSTER,
): OptimalParams {
  const levels = clusterKeyLevels(clusterKey);
  if (levels.length === 0) return { available: false, reason: 'invalid_key', tradeCount: 0, minTrades };

  let maxTrades = 0;
  let sawEnough = false;
  let sawAny = false;
  for (const { level, key } of levels) {
    const row = byKey.get(key);
    if (!row || !writtenByBatch(row.changelog)) continue;
    sawAny = true;
    maxTrades = Math.max(maxTrades, row.tradeCount);
    const enough = !row.isLowSampleSize && row.tradeCount >= minTrades;
    if (enough) sawEnough = true;
    const lev = row.optimalLeverage === null ? NaN : Number(row.optimalLeverage);
    const risk = row.optimalRiskPct === null ? NaN : Number(row.optimalRiskPct);
    const schemaId = row.optimalTpSchemaId;
    if (!enough || !(lev >= 1) || !(risk > 0) || schemaId === null || !TP_SCHEMA_SET.has(schemaId)) continue;

    const levCap = Math.max(1, Math.floor(caps.maxLeverage));
    const riskCap = caps.riskPctPerTrade;
    return {
      available: true,
      clusterKey: key,
      level,
      tradeCount: row.tradeCount,
      leverage: Math.min(lev, levCap),
      tpSchema: schemaId as TpSchemaId,
      riskPct: Math.min(risk, riskCap),
      rapsScore: row.rapsScore === null ? null : Number(row.rapsScore),
      capped: { leverage: lev > levCap, riskPct: risk > riskCap },
      explanation: row.causalityExplanation,
      updatedAt: row.updatedAt,
    };
  }
  return {
    available: false,
    reason: sawEnough ? 'not_recommended' : sawAny ? 'low_sample' : 'no_data',
    tradeCount: maxTrades,
    minTrades,
  };
}

/** DB-Wrapper: lädt die Ebenen des Keys aus `study_clusters` und ruft pickOptimalParams. */
export async function getOptimalParams(db: Db, clusterKey: string, caps: RiskCaps): Promise<OptimalParams> {
  const keys = clusterKeyLevels(clusterKey).map((l) => l.key);
  if (keys.length === 0) return pickOptimalParams(new Map(), clusterKey, caps);
  const rows = await db
    .select({
      clusterKey: studyClusters.clusterKey,
      optimalLeverage: studyClusters.optimalLeverage,
      optimalTpSchemaId: studyClusters.optimalTpSchemaId,
      optimalRiskPct: studyClusters.optimalRiskPct,
      rapsScore: studyClusters.rapsScore,
      tradeCount: studyClusters.tradeCount,
      isLowSampleSize: studyClusters.isLowSampleSize,
      causalityExplanation: studyClusters.causalityExplanation,
      changelog: studyClusters.changelog,
      updatedAt: studyClusters.updatedAt,
    })
    .from(studyClusters)
    .where(inArray(studyClusters.clusterKey, keys));
  return pickOptimalParams(new Map(rows.map((r) => [r.clusterKey, r])), clusterKey, caps);
}
