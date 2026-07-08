import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { syncBuffett } from './buffett.js';
import { syncCot } from './cot.js';
import { syncCpiSeries } from './cpi.js';
import { deriveGrsFromSeries, type Grs, type MacroPoint } from './grs.js';
import { FRED_PUBLIC_SERIES, fetchFredPublicSeries } from './fred-public.js';
import { fetchYahooChart, MACRO_SYMBOLS, type MacroSeriesId } from './yahoo.js';

const { macroSeries } = schema;

/**
 * Makro-Zeitreihen (Phase-1-Rest): VIX/DXY/US10Y als Tages-Serien →
 * macro_series. PRIMÄR über die öffentliche FRED-CSV (offizielle Fed-Daten,
 * kein Key — Yahoo blockt Rechenzentrums-IPs mit 429); Yahoo als Fallback.
 * Optional FRED-API (FRED_API_KEY) für Zusatz-Serien.
 */

export type MacroSyncResult = { series: { seriesId: string; points: number; latest: number | null; source: string }[]; errors: string[] };

async function upsertPoints(db: Db, source: string, seriesId: string, points: { ts: Date; value: number }[]): Promise<number> {
  let written = 0;
  for (const p of points) {
    // Tagespunkte auf Mitternacht UTC normalisieren (stabile PKs über Läufe)
    const day = new Date(Date.UTC(p.ts.getUTCFullYear(), p.ts.getUTCMonth(), p.ts.getUTCDate()));
    const res = await db
      .insert(macroSeries)
      .values({ source, seriesId, ts: day, value: String(p.value) })
      .onConflictDoUpdate({
        target: [macroSeries.source, macroSeries.seriesId, macroSeries.ts],
        set: { value: String(p.value) },
      })
      .returning({ ts: macroSeries.ts });
    written += res.length;
  }
  return written;
}

export async function syncMacroSeries(db: Db): Promise<MacroSyncResult> {
  const result: MacroSyncResult = { series: [], errors: [] };
  const fromIso = new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10);

  for (const seriesId of Object.keys(MACRO_SYMBOLS) as MacroSeriesId[]) {
    // 1. Primär: FRED-public-CSV (offiziell, kein Key, kein IP-Block)
    try {
      const points = await fetchFredPublicSeries(FRED_PUBLIC_SERIES[seriesId], fromIso);
      if (points.length === 0) throw new Error('leere Serie');
      const written = await upsertPoints(db, 'fred-public', seriesId, points);
      result.series.push({ seriesId, points: written, latest: points[points.length - 1]!.value, source: 'fred-public' });
      continue;
    } catch (err) {
      result.errors.push(`${seriesId} (fred-public): ${String(err)}`);
    }
    // 2. Fallback: Yahoo-Chart-API
    try {
      const chart = await fetchYahooChart(MACRO_SYMBOLS[seriesId], '6mo', '1d');
      if (!chart) throw new Error('leere Antwort');
      const written = await upsertPoints(db, 'yahoo', seriesId, chart.points.map((p) => ({ ts: p.ts, value: p.close })));
      result.series.push({ seriesId, points: written, latest: chart.price, source: 'yahoo' });
    } catch (err) {
      result.errors.push(`${seriesId} (yahoo): ${String(err)}`);
    }
  }

  // ── KI-Intelligence-Quellen (CPI/COT/Buffett) huckepack im Makro-Sync ──
  // Bewusst KEIN eigener Worker-Job (worker.ts gehört der laufenden
  // Worker-Prozess-Trennung). Quellen sind wöchentlich (COT) bzw.
  // monatlich/quartalsweise (CPI/Buffett) → 6-h-Drossel reicht dicke.
  if (Date.now() - lastIntelSyncMs >= INTEL_SYNC_MIN_INTERVAL_MS) {
    lastIntelSyncMs = Date.now();
    const intel = await syncIntelligenceSources(db);
    result.series.push(...intel.series);
    result.errors.push(...intel.errors);
  }
  return result;
}

/** Drossel für den huckepack laufenden Intelligence-Sync (je Prozess). */
export const INTEL_SYNC_MIN_INTERVAL_MS = 6 * 3_600_000;
let lastIntelSyncMs = 0;

/**
 * Synchronisiert die Intelligence-Quellen (CPI-Serie, COT-Reports,
 * Buffett-Indikator). Jede Quelle fällt einzeln ehrlich in `errors` —
 * eine tote Quelle blockiert die anderen nicht.
 */
export async function syncIntelligenceSources(db: Db): Promise<MacroSyncResult> {
  const result: MacroSyncResult = { series: [], errors: [] };
  try {
    const cpi = await syncCpiSeries(db);
    result.series.push({ seriesId: 'CPI', points: cpi.points, latest: cpi.latest, source: 'fred-public' });
  } catch (err) {
    result.errors.push(`CPI (fred-public): ${String(err)}`);
  }
  try {
    const cot = await syncCot(db);
    result.series.push({ seriesId: 'COT', points: cot.rows, latest: null, source: 'cftc' });
    result.errors.push(...cot.errors.map((e) => `COT (cftc): ${e}`));
  } catch (err) {
    result.errors.push(`COT (cftc): ${String(err)}`);
  }
  try {
    const buffett = await syncBuffett(db);
    result.series.push({ seriesId: 'BUFFETT', points: buffett.skipped ? 0 : 1, latest: buffett.ratio, source: 'fred-public' });
  } catch (err) {
    result.errors.push(`BUFFETT (fred-public): ${String(err)}`);
  }
  return result;
}

/** Liest beide Quellen; bei doppeltem Tag gewinnt fred-public (offizielle Daten). */
export async function getMacroSeries(db: Db, seriesId: MacroSeriesId, limit = 130): Promise<MacroPoint[]> {
  const rows = await db
    .select({ ts: macroSeries.ts, value: macroSeries.value, source: macroSeries.source })
    .from(macroSeries)
    .where(and(inArray(macroSeries.source, ['fred-public', 'yahoo']), eq(macroSeries.seriesId, seriesId)))
    .orderBy(desc(macroSeries.ts))
    .limit(limit * 2);
  const byDay = new Map<number, { value: number; source: string }>();
  for (const r of rows) {
    const key = r.ts.getTime();
    const existing = byDay.get(key);
    if (!existing || (existing.source !== 'fred-public' && r.source === 'fred-public')) {
      byDay.set(key, { value: Number(r.value), source: r.source });
    }
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-limit)
    .map(([ts, v]) => ({ ts: new Date(ts), value: v.value }));
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
