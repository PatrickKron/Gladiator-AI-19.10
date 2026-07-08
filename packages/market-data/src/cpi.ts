import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { fetchFredPublicSeries } from './fred-public.js';
import { detectCategory } from './event-impact.js';

const { macroSeries, economicEvents } = schema;

/**
 * CPI als verpflichtender Makro-Event-Baustein („/goal Ergänzung" §5).
 *
 * Zwei Quellen, beide OHNE API-Key:
 *  1. FRED-public CSV `CPIAUCSL` (US CPI, All Urban Consumers, SA) → macro_series
 *     als seriesId 'CPI'. Liefert die YoY-Inflationsrate für den Makro-Kontext.
 *  2. Der bereits synchronisierte Wirtschaftskalender (economic_events) liefert
 *     die EVENT-Phase (pre_event/release_window/…) + Überraschung (actual vs
 *     forecast). CPI-Events werden per detectCategory('cpi') erkannt.
 *
 * REINE Funktionen für Phase/Überraschung/Score — deterministisch, kein LLM,
 * kein Fake. Sync/Read sind dünne DB-Adapter darüber.
 */

/** FRED-Serie: US-Verbraucherpreisindex, saisonbereinigt, monatlich. */
export const CPI_FRED_SERIES = 'CPIAUCSL';
/** seriesId, unter der wir CPI in macro_series ablegen. */
export const CPI_SERIES_ID = 'CPI';

export type CpiPhase = 'none' | 'pre_event' | 'release_window' | 'post_event' | 'confirmed_reaction';
export type CpiSurprise = 'higher' | 'lower' | 'inline' | null;

export type CpiEventLike = {
  title: string;
  currency: string | null;
  importance: number | null;
  scheduledAt: Date;
  actual: number | null;
  forecast: number | null;
};

export const CPI_PHASE_DEFAULTS = {
  /** Vorlauf, in dem „keine aggressiven neuen Hebeltrades" gelten (PDF §5). */
  preHours: 24,
  /** ± um den Release: „keine blind automatisierte Reaktion auf den ersten Spike". */
  releaseMin: 30,
  /** Fenster, in dem der Markt den Schock bestätigt/zurückdreht. */
  postHours: 4,
  /** Danach gilt die Reaktion als bestätigt, bis das Event „alt" ist. */
  confirmHours: 24,
};

/** true, wenn ein Kalender-Event ein CPI-Event ist (titel-basiert, deterministisch). */
export function isCpiEvent(e: { title: string }): boolean {
  return detectCategory(e.title) === 'cpi';
}

/**
 * Ermittelt die CPI-Event-Phase relativ zu `now` aus einer Liste von
 * Kalender-Events. Nimmt das dem Jetzt nächstliegende CPI-Event.
 * Rein und deterministisch — die Basis der No-Trade-/Hedge-Regeln.
 */
export function deriveCpiPhase(
  events: CpiEventLike[],
  now: Date,
  opts: typeof CPI_PHASE_DEFAULTS = CPI_PHASE_DEFAULTS,
): { phase: CpiPhase; event: CpiEventLike | null } {
  const cpi = events.filter((e) => isCpiEvent(e));
  if (cpi.length === 0) return { phase: 'none', event: null };

  const nowMs = now.getTime();
  // Kandidat = CPI-Event mit dem kleinsten zeitlichen Abstand zu jetzt.
  const nearest = cpi
    .slice()
    .sort((a, b) => Math.abs(a.scheduledAt.getTime() - nowMs) - Math.abs(b.scheduledAt.getTime() - nowMs))[0]!;

  const deltaMs = nearest.scheduledAt.getTime() - nowMs; // >0 = Event liegt in der Zukunft
  const releaseMs = opts.releaseMin * 60_000;
  const preMs = opts.preHours * 3_600_000;
  const postMs = opts.postHours * 3_600_000;
  const confirmMs = opts.confirmHours * 3_600_000;

  if (Math.abs(deltaMs) <= releaseMs) return { phase: 'release_window', event: nearest };
  if (deltaMs > 0) return { phase: deltaMs <= preMs ? 'pre_event' : 'none', event: nearest };
  // deltaMs < -releaseMs → Event liegt in der Vergangenheit
  const sincePast = -deltaMs;
  if (sincePast <= postMs) return { phase: 'post_event', event: nearest };
  if (sincePast <= confirmMs) return { phase: 'confirmed_reaction', event: nearest };
  return { phase: 'none', event: nearest };
}

/**
 * Überraschung des CPI-Release: actual vs forecast.
 * „higher" = heißer als erwartet (Inflationsdruck), „lower" = kühler.
 * Ohne actual/forecast ⇒ null (nie geraten).
 */
export function deriveCpiSurprise(event: CpiEventLike | null, toleranceAbs = 0.05): CpiSurprise {
  if (!event || event.actual === null || event.forecast === null) return null;
  const diff = event.actual - event.forecast;
  if (Math.abs(diff) <= toleranceAbs) return 'inline';
  return diff > 0 ? 'higher' : 'lower';
}

/**
 * Makro-CPI-Score-Komponente (0..1) für das Signalobjekt (PDF §11).
 * Höher = mehr Rückenwind für die Trade-Richtung; niedriger = mehr Event-Risiko.
 * Konservativ: rund um den Release ist der Score gedämpft (Event-Regime).
 */
export function cpiScore(
  phase: CpiPhase,
  surprise: CpiSurprise,
  direction: 'long' | 'short',
): number {
  // Kein CPI in Reichweite → neutral-positiv (kein Event-Risiko).
  if (phase === 'none') return 0.6;
  // Vor dem Event & im Release-Fenster: Risiko hoch → Score gedämpft.
  if (phase === 'pre_event') return 0.35;
  if (phase === 'release_window') return 0.15;

  // Nach dem Event: die Überraschung wirkt richtungsabhängig.
  // „higher" (heiße Inflation) belastet Risk-Assets → gut für short, schlecht für long.
  if (surprise === null) return 0.4; // Reaktion unklar
  const riskOnFavorsLong = surprise === 'lower';
  const aligned = (direction === 'long' && riskOnFavorsLong) || (direction === 'short' && !riskOnFavorsLong);
  const base = phase === 'confirmed_reaction' ? 0.75 : 0.55; // bestätigt > frisch
  if (surprise === 'inline') return 0.5;
  return aligned ? base : 1 - base;
}

// ── DB-Adapter (dünn) ─────────────────────────────────────────────────────

export type CpiSyncResult = { points: number; latest: number | null };

/** Synchronisiert die CPI-Indexserie (CPIAUCSL) in macro_series (source fred-public). */
export async function syncCpiSeries(db: Db): Promise<CpiSyncResult> {
  const fromIso = new Date(Date.now() - 800 * 86_400_000).toISOString().slice(0, 10); // ~2 Jahre für YoY
  const points = await fetchFredPublicSeries(CPI_FRED_SERIES, fromIso);
  let written = 0;
  for (const p of points) {
    const day = new Date(Date.UTC(p.ts.getUTCFullYear(), p.ts.getUTCMonth(), p.ts.getUTCDate()));
    const res = await db
      .insert(macroSeries)
      .values({ source: 'fred-public', seriesId: CPI_SERIES_ID, ts: day, value: String(p.value) })
      .onConflictDoUpdate({
        target: [macroSeries.source, macroSeries.seriesId, macroSeries.ts],
        set: { value: String(p.value) },
      })
      .returning({ ts: macroSeries.ts });
    written += res.length;
  }
  return { points: written, latest: points.length > 0 ? points[points.length - 1]!.value : null };
}

/** Jahres-Inflationsrate (YoY %) aus monatlichen CPI-Indexpunkten. Null, wenn zu wenig Daten. */
export function cpiInflationYoY(points: { ts: Date; value: number }[]): number | null {
  if (points.length < 13) return null;
  const sorted = points.slice().sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const latest = sorted[sorted.length - 1]!;
  // Punkt ~12 Monate zuvor (nächstliegender).
  const target = latest.ts.getTime() - 365 * 86_400_000;
  let yearAgo = sorted[0]!;
  for (const p of sorted) {
    if (Math.abs(p.ts.getTime() - target) < Math.abs(yearAgo.ts.getTime() - target)) yearAgo = p;
  }
  if (yearAgo.value <= 0) return null;
  return (latest.value / yearAgo.value - 1) * 100;
}

export type CpiSnapshot = {
  phase: CpiPhase;
  surprise: CpiSurprise;
  inflationYoY: number | null;
  /** ISO des maßgeblichen CPI-Events (oder null). */
  eventAt: string | null;
  /** Datenquellen verbunden? (Kalender-Events vorhanden) */
  connected: boolean;
};

/**
 * Liest den aktuellen CPI-Zustand: Phase/Überraschung aus economic_events,
 * YoY-Inflation aus macro_series. NUR echte Daten — leer, wenn nicht verbunden.
 */
export async function getCpiSnapshot(db: Db, now = new Date()): Promise<CpiSnapshot> {
  // CPI-Kandidaten der letzten/nächsten ~2 Tage.
  const windowFrom = new Date(now.getTime() - 2 * 86_400_000);
  const windowTo = new Date(now.getTime() + 2 * 86_400_000);
  const rows = await db
    .select({
      title: economicEvents.title,
      currency: economicEvents.currency,
      importance: economicEvents.importance,
      scheduledAt: economicEvents.scheduledAt,
      actual: economicEvents.actual,
      forecast: economicEvents.forecast,
    })
    .from(economicEvents)
    .orderBy(desc(economicEvents.scheduledAt))
    .limit(500);
  const events: CpiEventLike[] = rows
    .filter((r) => r.scheduledAt >= windowFrom && r.scheduledAt <= windowTo)
    .map((r) => ({
      title: r.title,
      currency: r.currency,
      importance: r.importance,
      scheduledAt: r.scheduledAt,
      actual: r.actual !== null ? Number(r.actual) : null,
      forecast: r.forecast !== null ? Number(r.forecast) : null,
    }));

  const { phase, event } = deriveCpiPhase(events, now);
  const surprise = deriveCpiSurprise(event);

  const cpiRows = await db
    .select({ ts: macroSeries.ts, value: macroSeries.value })
    .from(macroSeries)
    .where(and(eq(macroSeries.source, 'fred-public'), eq(macroSeries.seriesId, CPI_SERIES_ID)))
    .orderBy(desc(macroSeries.ts))
    .limit(30);
  const inflationYoY = cpiInflationYoY(cpiRows.map((r) => ({ ts: r.ts, value: Number(r.value) })));

  return {
    phase,
    surprise,
    inflationYoY,
    eventAt: event ? event.scheduledAt.toISOString() : null,
    connected: rows.length > 0,
  };
}
