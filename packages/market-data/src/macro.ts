import { and, asc, desc, eq } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { deriveGrsFromSeries, type Grs, type MacroPoint } from './grs.js';
import { fetchYahooChart, MACRO_SYMBOLS, type MacroSeriesId } from './yahoo.js';

const { macroSeries } = schema;

/**
 * Makro-Zeitreihen (Phase-1-Rest): VIX/DXY/US10Y als Tages-Serien via Yahoo
 * (öffentlich, kein Key) → macro_series. Optional FRED (FRED_API_KEY, legt
 * nur Patrick an) für zusätzliche Serien — ohne Key ehrlich nicht verbunden.
 */

export type MacroSyncResult = { series: { seriesId: string; points: number; latest: number | null }[]; errors: string[] };

export async function syncMacroSeries(db: Db): Promise<MacroSyncResult> {
  const result: MacroSyncResult = { series: [], errors: [] };
  for (const [seriesId, symbol] of Object.entries(MACRO_SYMBOLS)) {
    try {
      const chart = await fetchYahooChart(symbol, '6mo', '1d');
      if (!chart) throw new Error('leere Antwort');
      let written = 0;
      for (const p of chart.points) {
        // Tagespunkte auf Mitternacht UTC normalisieren (stabile PKs über Läufe)
        const day = new Date(Date.UTC(p.ts.getUTCFullYear(), p.ts.getUTCMonth(), p.ts.getUTCDate()));
        const res = await db
          .insert(macroSeries)
          .values({ source: 'yahoo', seriesId, ts: day, value: String(p.close) })
          .onConflictDoUpdate({
            target: [macroSeries.source, macroSeries.seriesId, macroSeries.ts],
            set: { value: String(p.close) },
          })
          .returning({ ts: macroSeries.ts });
        written += res.length;
      }
      result.series.push({ seriesId, points: written, latest: chart.price });
    } catch (err) {
      result.errors.push(`${seriesId}: ${String(err)}`);
    }
  }
  return result;
}

export async function getMacroSeries(db: Db, seriesId: MacroSeriesId, limit = 130): Promise<MacroPoint[]> {
  const rows = await db
    .select({ ts: macroSeries.ts, value: macroSeries.value })
    .from(macroSeries)
    .where(and(eq(macroSeries.source, 'yahoo'), eq(macroSeries.seriesId, seriesId)))
    .orderBy(desc(macroSeries.ts))
    .limit(limit);
  return rows.reverse().map((r) => ({ ts: r.ts, value: Number(r.value) }));
}

export type MacroSnapshot = {
  vix: MacroPoint | null;
  dxy: MacroPoint | null;
  us10y: MacroPoint | null;
  grs: Grs | null;
  series: { vix: MacroPoint[]; dxy: MacroPoint[]; us10y: MacroPoint[] };
  /** true, wenn der jüngste Punkt < 5 Tage alt ist (Wochenende/Feiertage toleriert). */
  fresh: boolean;
};

export async function getMacroSnapshot(db: Db): Promise<MacroSnapshot> {
  const [vix, dxy, us10y] = await Promise.all([
    getMacroSeries(db, 'VIX'),
    getMacroSeries(db, 'DXY'),
    getMacroSeries(db, 'US10Y'),
  ]);
  const last = (s: MacroPoint[]) => (s.length > 0 ? s[s.length - 1]! : null);
  const lastVix = last(vix);
  const maxAgeMs = 5 * 86_400_000;
  const fresh = lastVix !== null && Date.now() - lastVix.ts.getTime() < maxAgeMs;
  return {
    vix: lastVix,
    dxy: last(dxy),
    us10y: last(us10y),
    grs: deriveGrsFromSeries(vix, dxy, us10y),
    series: { vix, dxy, us10y },
    fresh,
  };
}

// ── FRED (optional, nur mit Key — legt Patrick an) ───────────────────────

export function fredConfigured(): boolean {
  return Boolean(process.env.FRED_API_KEY);
}

/** Zusätzliche FRED-Serien (z. B. Fed Funds DFF), NUR wenn der Key existiert. */
export async function syncFredSeries(db: Db, seriesIds: string[] = ['DFF']): Promise<{ synced: string[]; skipped: boolean }> {
  const key = process.env.FRED_API_KEY;
  if (!key) return { synced: [], skipped: true };
  const synced: string[] = [];
  for (const seriesId of seriesIds) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${key}&file_type=json&observation_start=2025-01-01`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`FRED ${seriesId}: HTTP ${res.status}`);
    const json = (await res.json()) as { observations?: { date: string; value: string }[] };
    for (const obs of json.observations ?? []) {
      const value = Number(obs.value);
      if (!Number.isFinite(value)) continue; // FRED nutzt '.' für fehlende Werte
      await db
        .insert(macroSeries)
        .values({ source: 'fred', seriesId, ts: new Date(`${obs.date}T00:00:00Z`), value: String(value) })
        .onConflictDoUpdate({ target: [macroSeries.source, macroSeries.seriesId, macroSeries.ts], set: { value: String(value) } });
    }
    synced.push(seriesId);
  }
  return { synced, skipped: false };
}

/** Kleiner Helfer für Tests/Anzeigen: ältesten + jüngsten Punkt einer Serie. */
export async function macroSeriesRange(db: Db, seriesId: MacroSeriesId) {
  const rows = await db
    .select({ ts: macroSeries.ts })
    .from(macroSeries)
    .where(and(eq(macroSeries.source, 'yahoo'), eq(macroSeries.seriesId, seriesId)))
    .orderBy(asc(macroSeries.ts));
  return rows.length > 0 ? { from: rows[0]!.ts, to: rows[rows.length - 1]!.ts, points: rows.length } : null;
}
