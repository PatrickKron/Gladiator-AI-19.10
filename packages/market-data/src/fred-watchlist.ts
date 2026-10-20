import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import { fetchFredPublicSeries, type FredCsvPoint } from './fred-public.js';

const { macroSeries } = schema;

/**
 * Daten-Assistent (Patrick: „die App soll sich Daten selbst holen und
 * abbilden"): eigene OFFIZIELLE Fed-Serien per FRED-ID hinzufügen. Jede Serie
 * wird beim Hinzufügen gegen die echte Quelle geprüft (keine Daten → nichts
 * gespeichert) und danach im macro-sync mitgezogen.
 *
 * Speicherung ohne eigene Tabelle: macro_series mit source = 'fred-user' —
 * die Watchlist IST die Menge dieser Serien (eine Wahrheit, kein Zweitregister).
 * Nur offizielle, öffentliche Quellen; kein Scraping nicht-öffentlicher APIs.
 */

export const FRED_USER_SOURCE = 'fred-user';

export type FredFetcher = (fredId: string, fromIso: string) => Promise<FredCsvPoint[]>;

export type FredCatalogEntry = { id: string; title: string; freq: 'D' | 'W' | 'M' | 'Q'; keywords: string[] };

/**
 * Kuratierter Katalog bekannter Serien (IDs = echte FRED-Kennungen). Er
 * liefert nur Vorschläge — Daten kommen immer erst nach Prüfung von FRED.
 */
export const FRED_CATALOG: FredCatalogEntry[] = [
  { id: 'M2SL', title: 'M2 Money Stock', freq: 'M', keywords: ['geldmenge', 'money supply', 'm2', 'liquidität', 'liquidity'] },
  { id: 'WALCL', title: 'Fed Total Assets (Bilanzsumme)', freq: 'W', keywords: ['fed bilanz', 'balance sheet', 'qe', 'qt', 'liquidität', 'liquidity', 'bilanz'] },
  { id: 'RRPONTSYD', title: 'Overnight Reverse Repo', freq: 'D', keywords: ['reverse repo', 'rrp', 'liquidität', 'liquidity', 'repo'] },
  { id: 'WTREGEN', title: 'Treasury General Account', freq: 'W', keywords: ['tga', 'treasury', 'liquidität', 'liquidity', 'finanzministerium'] },
  { id: 'T10Y2Y', title: '10J minus 2J Treasury (Zinskurve)', freq: 'D', keywords: ['zinskurve', 'yield curve', 'inversion', 'rezession', 'recession', 'spread'] },
  { id: 'T10Y3M', title: '10J minus 3M Treasury (Zinskurve)', freq: 'D', keywords: ['zinskurve', 'yield curve', 'inversion', 'rezession', 'recession'] },
  { id: 'DFF', title: 'Effective Federal Funds Rate', freq: 'D', keywords: ['leitzins', 'fed funds', 'zinsen', 'rates', 'fomc'] },
  { id: 'SOFR', title: 'Secured Overnight Financing Rate', freq: 'D', keywords: ['sofr', 'zinsen', 'rates', 'geldmarkt', 'money market'] },
  { id: 'DGS2', title: '2-Year Treasury Yield', freq: 'D', keywords: ['rendite', 'yield', 'zinsen', 'anleihen', 'bonds', '2y'] },
  { id: 'DFII10', title: '10-Year Real Yield (TIPS)', freq: 'D', keywords: ['realzins', 'real yield', 'tips', 'gold', 'zinsen'] },
  { id: 'T10YIE', title: '10-Year Breakeven Inflation', freq: 'D', keywords: ['inflation', 'breakeven', 'inflationserwartung', 'expectations'] },
  { id: 'CPIAUCSL', title: 'CPI All Items', freq: 'M', keywords: ['inflation', 'cpi', 'verbraucherpreise', 'prices'] },
  { id: 'PCEPILFE', title: 'Core PCE Price Index', freq: 'M', keywords: ['inflation', 'pce', 'kerninflation', 'core'] },
  { id: 'UNRATE', title: 'Unemployment Rate', freq: 'M', keywords: ['arbeitslosigkeit', 'unemployment', 'arbeitsmarkt', 'jobs', 'labor'] },
  { id: 'PAYEMS', title: 'Nonfarm Payrolls', freq: 'M', keywords: ['nfp', 'payrolls', 'arbeitsmarkt', 'jobs', 'labor', 'beschäftigung'] },
  { id: 'ICSA', title: 'Initial Jobless Claims', freq: 'W', keywords: ['jobless claims', 'arbeitslosenanträge', 'arbeitsmarkt', 'labor'] },
  { id: 'BAMLH0A0HYM2', title: 'High-Yield Credit Spread', freq: 'D', keywords: ['credit spread', 'kreditspread', 'high yield', 'junk', 'risiko', 'risk'] },
  { id: 'NFCI', title: 'Chicago Fed Financial Conditions', freq: 'W', keywords: ['financial conditions', 'finanzbedingungen', 'stress', 'risiko', 'risk'] },
  { id: 'STLFSI4', title: 'St. Louis Fed Financial Stress', freq: 'W', keywords: ['stress', 'finanzstress', 'financial stress', 'risiko', 'risk'] },
  { id: 'DCOILWTICO', title: 'WTI Crude Oil', freq: 'D', keywords: ['öl', 'oil', 'wti', 'rohstoffe', 'commodities', 'energie'] },
  { id: 'DEXUSEU', title: 'USD/EUR Wechselkurs', freq: 'D', keywords: ['euro', 'eurusd', 'wechselkurs', 'fx', 'devisen', 'dollar'] },
  { id: 'GDP', title: 'US GDP (nominal)', freq: 'Q', keywords: ['bip', 'gdp', 'wachstum', 'growth', 'konjunktur'] },
  { id: 'UMCSENT', title: 'U. Michigan Consumer Sentiment', freq: 'M', keywords: ['verbraucherstimmung', 'sentiment', 'consumer', 'konsum'] },
  { id: 'MORTGAGE30US', title: '30-Year Mortgage Rate', freq: 'W', keywords: ['hypothek', 'mortgage', 'immobilien', 'housing', 'zinsen'] },
];

/** FRED-IDs: Großbuchstaben, Ziffern, Unterstrich; max. 30 Zeichen. Sonst null. */
export function normalizeFredId(raw: string): string | null {
  const id = raw.trim().toUpperCase();
  return /^[A-Z0-9_]{1,30}$/.test(id) ? id : null;
}

/** Klartext → passende Katalog-Serien (deterministisch, bewertet nach Treffern). */
export function suggestFredSeries(query: string, limit = 6): FredCatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/).filter((w) => w.length >= 2);
  const scored = FRED_CATALOG.map((entry) => {
    let score = entry.id.toLowerCase() === q ? 100 : 0;
    const hay = [entry.title.toLowerCase(), ...entry.keywords];
    for (const w of words) {
      if (entry.id.toLowerCase() === w) score += 50;
      if (entry.keywords.some((k) => k === w)) score += 5;
      else if (hay.some((h) => h.includes(w))) score += 2;
    }
    if (entry.keywords.some((k) => k === q)) score += 10;
    return { entry, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
  return scored.slice(0, limit).map((s) => s.entry);
}

async function upsert(db: Db, seriesId: string, points: FredCsvPoint[]): Promise<number> {
  let written = 0;
  for (const p of points) {
    const day = new Date(Date.UTC(p.ts.getUTCFullYear(), p.ts.getUTCMonth(), p.ts.getUTCDate()));
    await db
      .insert(macroSeries)
      .values({ source: FRED_USER_SOURCE, seriesId, ts: day, value: String(p.value) })
      .onConflictDoUpdate({
        target: [macroSeries.source, macroSeries.seriesId, macroSeries.ts],
        set: { value: String(p.value) },
      });
    written++;
  }
  return written;
}

const isoDaysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

export type FredWatchAddResult = { seriesId: string; points: number; latest: number; latestTs: Date };

/** Serie hinzufügen: erst echte Daten von FRED, dann speichern (10 Jahre Historie). */
export async function addFredWatch(db: Db, rawId: string, fetcher: FredFetcher = fetchFredPublicSeries): Promise<FredWatchAddResult> {
  const seriesId = normalizeFredId(rawId);
  if (!seriesId) throw new Error(`Ungültige FRED-ID "${rawId}" — erlaubt sind A–Z, 0–9 und _.`);
  let points: FredCsvPoint[];
  try {
    points = await fetcher(seriesId, isoDaysAgo(3653));
  } catch (err) {
    throw new Error(`FRED-Serie ${seriesId}: keine Daten abrufbar (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (points.length === 0) throw new Error(`FRED-Serie ${seriesId}: keine Daten — ID prüfen (fred.stlouisfed.org).`);
  const written = await upsert(db, seriesId, points);
  const last = points[points.length - 1]!;
  return { seriesId, points: written, latest: last.value, latestTs: last.ts };
}

export type FredWatchEntry = {
  seriesId: string;
  title: string | null;
  points: number;
  latest: number;
  latestTs: Date;
  /** Vorheriger Wert (für Veränderung); null bei nur einem Punkt. */
  previous: number | null;
};

export async function listFredWatch(db: Db): Promise<FredWatchEntry[]> {
  const rows = await db.execute(sql`
    SELECT series_id, count(*)::int AS n,
           (array_agg(value ORDER BY ts DESC))[1]::float8 AS latest,
           (array_agg(value ORDER BY ts DESC))[2]::float8 AS previous,
           max(ts) AS latest_ts
    FROM macro_series WHERE source = ${FRED_USER_SOURCE}
    GROUP BY series_id ORDER BY series_id`);
  return (rows.rows as { series_id: string; n: number; latest: number; previous: number | null; latest_ts: Date | string }[]).map((r) => ({
    seriesId: r.series_id,
    title: FRED_CATALOG.find((c) => c.id === r.series_id)?.title ?? null,
    points: r.n,
    latest: Number(r.latest),
    previous: r.previous === null ? null : Number(r.previous),
    latestTs: new Date(r.latest_ts),
  }));
}

export async function readFredWatchSeries(db: Db, rawId: string, limit = 500): Promise<{ ts: Date; value: number }[]> {
  const seriesId = normalizeFredId(rawId);
  if (!seriesId) return [];
  const rows = await db
    .select({ ts: macroSeries.ts, value: macroSeries.value })
    .from(macroSeries)
    .where(and(eq(macroSeries.source, FRED_USER_SOURCE), eq(macroSeries.seriesId, seriesId)))
    .orderBy(asc(macroSeries.ts));
  return rows.slice(-limit).map((r) => ({ ts: r.ts, value: Number(r.value) }));
}

export async function removeFredWatch(db: Db, rawId: string): Promise<void> {
  const seriesId = normalizeFredId(rawId);
  if (!seriesId) return;
  await db.delete(macroSeries).where(and(eq(macroSeries.source, FRED_USER_SOURCE), eq(macroSeries.seriesId, seriesId)));
}

/** Teil des macro-sync: jede beobachtete Serie ab (letzter Punkt − 60 Tage) nachziehen. */
export async function syncFredWatch(db: Db, fetcher: FredFetcher = fetchFredPublicSeries): Promise<{ synced: string[]; errors: string[] }> {
  const out = { synced: [] as string[], errors: [] as string[] };
  for (const w of await listFredWatch(db)) {
    try {
      const from = new Date(w.latestTs.getTime() - 60 * 86_400_000).toISOString().slice(0, 10);
      const points = await fetcher(w.seriesId, from);
      await upsert(db, w.seriesId, points);
      out.synced.push(w.seriesId);
    } catch (err) {
      out.errors.push(`${w.seriesId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
