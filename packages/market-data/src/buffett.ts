import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { fetchFredPublicSeries } from './fred-public.js';

const { valuationIndicators } = schema;

/**
 * Warren-Buffett-Indikator als Bewertungsfilter („/goal Ergänzung" §7).
 *
 * Verhältnis Gesamtaktienmarkt-Bewertung / Wirtschaftsleistung. Quellen ohne
 * Key (FRED-public CSV):
 *   - Zähler:  NCBEILQ027S (Fed Z.1: Nonfinancial Corporate Business, Corporate
 *              Equities, Liability — Mio. USD, quartalsweise). Die Wilshire-
 *              Serien (WILL5000…) wurden im Juni 2024 KOMPLETT aus FRED
 *              entfernt und liefern nur noch HTML-Fehlerseiten — verifiziert.
 *              Z.1 ist der Standard-Ersatz (u. a. Advisor Perspectives).
 *   - Nenner:  GDP (Bruttoinlandsprodukt, Mrd. USD, quartalsweise)
 *   → Faktor 1000 (Mio. → Mrd.), damit das Verhältnis die übliche Lesart hat
 *     (≈ 2,3 = 230 % — live gegen GuruFocus ≈ 2,31 abgeglichen).
 *
 * WICHTIG (kein Fake): Klassifiziert wird über das EIGENE historische
 * PERZENTIL (selbstkalibrierend, ehrlich). Der Indikator ist ein LANGFRISTIGER
 * Bewertungsfilter, KEIN Entry-Auslöser: er verbietet Longs nicht, er
 * behandelt sie bei hoher Bewertung nur konservativer.
 */

export const BUFFETT_NUMERATOR_SERIES = 'NCBEILQ027S';
export const BUFFETT_DENOMINATOR_SERIES = 'GDP';
/** NCBEILQ027S ist in Mio. USD, GDP in Mrd. USD → Zähler durch 1000 teilen. */
export const BUFFETT_NUMERATOR_SCALE = 1 / 1000;
export const BUFFETT_INDICATOR_ID = 'buffett_us';

export type BuffettStatus = 'not_applicable' | 'neutral' | 'elevated' | 'extreme';

export type BuffettPoint = { ts: Date; ratio: number };

/** Marktkapitalisierung / BIP. Null, wenn Nenner ≤ 0. */
export function computeBuffettRatio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

/** Perzentilrang eines Werts in einer Zahlenreihe (0..1). */
function percentileRank(value: number, arr: number[]): number {
  if (arr.length <= 1) return 0.5;
  const below = arr.filter((v) => v < value).length;
  return below / (arr.length - 1);
}

/**
 * Klassifiziert die Bewertung über das historische Perzentil des Verhältnisses.
 * < 8 Punkte ⇒ not_applicable (zu wenig Geschichte, nie geraten).
 */
export function deriveBuffettStatus(
  history: BuffettPoint[],
  opts = { elevatedPct: 0.75, extremePct: 0.9 },
): { status: BuffettStatus; ratio: number | null; percentile: number } {
  if (history.length < 8) {
    const last = history[history.length - 1];
    return { status: 'not_applicable', ratio: last ? last.ratio : null, percentile: 0.5 };
  }
  const sorted = history.slice().sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const ratios = sorted.map((p) => p.ratio);
  const current = ratios[ratios.length - 1]!;
  const percentile = percentileRank(current, ratios);
  let status: BuffettStatus = 'neutral';
  if (percentile >= opts.extremePct) status = 'extreme';
  else if (percentile >= opts.elevatedPct) status = 'elevated';
  return { status, ratio: current, percentile };
}

/**
 * Buffett-Score-Komponente (0..1) für das Signalobjekt (PDF §11),
 * richtungsabhängig. Hohe Bewertung → Longs konservativer (niedriger),
 * Shorts leicht gestützt. Für nicht-Aktienmärkte (BTC) not_applicable → neutral.
 */
export function buffettScore(status: BuffettStatus, direction: 'long' | 'short'): number {
  if (status === 'not_applicable') return 0.5;
  if (status === 'neutral') return 0.6;
  const penalty = status === 'extreme' ? 0.35 : 0.2;
  if (direction === 'long') return Math.max(0, 0.6 - penalty);
  return Math.min(1, 0.6 + penalty * 0.5);
}

// ── DB-Adapter ─────────────────────────────────────────────────────────────

export type BuffettSyncResult = { ratio: number | null; numerator: number | null; denominator: number | null; skipped?: boolean };

function latestValue(points: { ts: Date; value: number }[]): { ts: Date; value: number } | null {
  if (points.length === 0) return null;
  return points.slice().sort((a, b) => a.ts.getTime() - b.ts.getTime())[points.length - 1]!;
}

/**
 * Holt Zähler (Z.1 Corporate Equities) + Nenner (GDP) von FRED-public und legt
 * die GESAMTE quartalsweise Verhältnis-Historie in valuation_indicators ab
 * (beide Serien sind quartalsweise mit identischen Quartalsdaten → exakter
 * Datums-Match; nichts wird interpoliert). Die volle Historie ist nötig, damit
 * deriveBuffettStatus per Perzentil klassifizieren kann (≥ 8 Punkte).
 */
export async function syncBuffett(db: Db): Promise<BuffettSyncResult> {
  const fromIso = new Date(Date.now() - 20 * 365 * 86_400_000).toISOString().slice(0, 10); // 20 Jahre Historie
  const [numPts, denPts] = await Promise.all([
    fetchFredPublicSeries(BUFFETT_NUMERATOR_SERIES, fromIso),
    fetchFredPublicSeries(BUFFETT_DENOMINATOR_SERIES, fromIso),
  ]);
  const denByDay = new Map(denPts.map((p) => [p.ts.toISOString().slice(0, 10), p.value]));

  let latest: { ratio: number; numerator: number; denominator: number } | null = null;
  for (const num of numPts.slice().sort((a, b) => a.ts.getTime() - b.ts.getTime())) {
    const den = denByDay.get(num.ts.toISOString().slice(0, 10));
    if (den === undefined) continue; // Quartal ohne GDP-Wert (z. B. Release-Lag) → ehrlich auslassen
    const ratio = computeBuffettRatio(num.value * BUFFETT_NUMERATOR_SCALE, den);
    if (ratio === null) continue;
    const ts = new Date(Date.UTC(num.ts.getUTCFullYear(), num.ts.getUTCMonth(), num.ts.getUTCDate()));
    await db
      .insert(valuationIndicators)
      .values({
        indicator: BUFFETT_INDICATOR_ID,
        ts,
        value: String(ratio),
        numerator: String(num.value),
        denominator: String(den),
        source: 'fred-public',
      })
      .onConflictDoUpdate({
        target: [valuationIndicators.indicator, valuationIndicators.ts],
        set: { value: String(ratio), numerator: String(num.value), denominator: String(den) },
      });
    latest = { ratio, numerator: num.value, denominator: den };
  }

  if (!latest) {
    const num = latestValue(numPts);
    const den = latestValue(denPts);
    return { ratio: null, numerator: num?.value ?? null, denominator: den?.value ?? null, skipped: true };
  }
  return latest;
}

export type BuffettSnapshot = {
  status: BuffettStatus;
  ratio: number | null;
  percentile: number;
  ts: string | null;
  connected: boolean;
};

/** Liest die Bewertungs-Historie und klassifiziert. Leer ⇒ nicht verbunden. */
export async function getBuffettSnapshot(db: Db): Promise<BuffettSnapshot> {
  const rows = await db
    .select({ ts: valuationIndicators.ts, value: valuationIndicators.value })
    .from(valuationIndicators)
    .where(and(eq(valuationIndicators.indicator, BUFFETT_INDICATOR_ID), eq(valuationIndicators.source, 'fred-public')))
    .orderBy(desc(valuationIndicators.ts))
    .limit(400);
  const history: BuffettPoint[] = rows.map((r) => ({ ts: r.ts, ratio: Number(r.value) }));
  const { status, ratio, percentile } = deriveBuffettStatus(history);
  const latest = history.slice().sort((a, b) => b.ts.getTime() - a.ts.getTime())[0] ?? null;
  return { status, ratio, percentile, ts: latest ? latest.ts.toISOString() : null, connected: rows.length > 0 };
}
