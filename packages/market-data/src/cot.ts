import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';

const { cotReports } = schema;

/**
 * COT-Daten als institutioneller Positionierungsfilter („/goal Ergänzung" §6).
 *
 * Quelle: CFTC „Commitments of Traders" — öffentliches Socrata-API, KEIN Key
 * (publicreporting.cftc.gov). Legacy „Futures Only"-Report (Dataset 6dca-aqww).
 * COT ist ein WÖCHENTLICHER struktureller Filter, kein Intraday-Auslöser: er
 * darf ein technisches Signal bestätigen, abschwächen oder in No-Trade schieben.
 *
 * REINE Funktionen (parse/derive) sind mit Fixtures voll getestet; sync/read
 * sind dünne Adapter.
 */

export const CFTC_DATASET_URL = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json';

export type CotMarket = {
  /** CFTC-Kontrakt-Marktcode. */
  code: string;
  /** Kurzlabel (stabil, für UI/i18n-Chips). */
  label: string;
  /** App-Symbole, denen dieser COT-Report Rückenwind/Warnung gibt. */
  appSymbols: string[];
};

/**
 * Kuratierte Märkte, die für Gladiator-Assets relevant sind (PDF §6: Futures,
 * Rohstoffe, Edelmetalle, Währungen, Indizes + CME-BTC). Codes = CFTC.
 */
export const COT_MARKETS: CotMarket[] = [
  { code: '088691', label: 'GOLD', appSymbols: ['XAU/USD', 'GOLD', 'GC'] },
  { code: '084691', label: 'SILVER', appSymbols: ['XAG/USD', 'SILVER', 'SI'] },
  { code: '067651', label: 'CRUDE_OIL_WTI', appSymbols: ['WTI', 'CL', 'OIL'] },
  { code: '133741', label: 'BITCOIN_CME', appSymbols: ['BTC/USDT', 'BTC/USD', 'BTC'] },
  { code: '13874A', label: 'SP500_EMINI', appSymbols: ['SPX', 'ES', 'SP500'] },
  { code: '099741', label: 'EURO_FX', appSymbols: ['EUR/USD', '6E'] },
];

/** App-Symbol → COT-Markt (oder null, wenn kein passender Report existiert). */
export function cotMarketForSymbol(symbol: string): CotMarket | null {
  const up = symbol.toUpperCase();
  return (
    COT_MARKETS.find((m) => m.appSymbols.some((s) => s.toUpperCase() === up)) ??
    COT_MARKETS.find((m) => m.appSymbols.some((s) => up.startsWith(s.toUpperCase()))) ??
    null
  );
}

export type CotRow = {
  marketCode: string;
  marketName: string;
  reportDate: Date;
  openInterest: number;
  noncommLong: number;
  noncommShort: number;
  commLong: number;
  commShort: number;
};

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parst die CFTC-Socrata-JSON-Antwort (Legacy Futures-Only). Kaputte Zeilen
 * werden verworfen — nie interpoliert, nie geraten.
 */
export function parseCotRows(json: unknown): CotRow[] {
  if (!Array.isArray(json)) return [];
  const out: CotRow[] = [];
  for (const raw of json) {
    const r = raw as Record<string, unknown>;
    const code = typeof r.cftc_contract_market_code === 'string' ? r.cftc_contract_market_code : null;
    const dateStr = typeof r.report_date_as_yyyy_mm_dd === 'string' ? r.report_date_as_yyyy_mm_dd : null;
    const oi = num(r.open_interest_all);
    const ncl = num(r.noncomm_positions_long_all);
    const ncs = num(r.noncomm_positions_short_all);
    const cl = num(r.comm_positions_long_all);
    const cs = num(r.comm_positions_short_all);
    if (!code || !dateStr || oi === null || ncl === null || ncs === null || cl === null || cs === null) continue;
    const reportDate = new Date(dateStr);
    if (Number.isNaN(reportDate.getTime())) continue;
    out.push({
      marketCode: code,
      marketName: typeof r.market_and_exchange_names === 'string' ? r.market_and_exchange_names : code,
      reportDate,
      openInterest: oi,
      noncommLong: ncl,
      noncommShort: ncs,
      commLong: cl,
      commShort: cs,
    });
  }
  return out;
}

export type CotStatus = 'not_applicable' | 'neutral' | 'crowded_long' | 'crowded_short' | 'contrarian_alert';

export type CotPositioning = {
  status: CotStatus;
  /** Netto-Non-Commercial (Large Specs) long − short, aktueller Report. */
  netNonComm: number;
  /** Netto / Open Interest (skalenfrei, −1..+1). */
  netRatio: number;
  /** Perzentilrang des netRatio in der Historie (0..1). */
  percentile: number;
  /** Änderung des netRatio zur Vorwoche. */
  weekChange: number;
};

/**
 * Leitet aus einer Report-Historie (neueste zuletzt ODER unsortiert) die
 * Positionierung ab. „crowded" = Extrem-Perzentil; „contrarian_alert" = Extrem
 * MIT schneller Zuspitzung in dieselbe Richtung (PDF §6: Kontraindikator).
 */
export function deriveCotPositioning(history: CotRow[], opts = { extremePct: 0.85, fastChange: 0.05 }): CotPositioning {
  if (history.length === 0) {
    return { status: 'not_applicable', netNonComm: 0, netRatio: 0, percentile: 0.5, weekChange: 0 };
  }
  const sorted = history.slice().sort((a, b) => a.reportDate.getTime() - b.reportDate.getTime());
  const ratios = sorted.map((r) => (r.openInterest > 0 ? (r.noncommLong - r.noncommShort) / r.openInterest : 0));
  const latest = sorted[sorted.length - 1]!;
  const netRatio = ratios[ratios.length - 1]!;
  const weekChange = ratios.length >= 2 ? netRatio - ratios[ratios.length - 2]! : 0;

  // Perzentilrang des aktuellen Verhältnisses.
  const below = ratios.filter((r) => r < netRatio).length;
  const percentile = ratios.length > 1 ? below / (ratios.length - 1) : 0.5;

  let status: CotStatus = 'neutral';
  const highExtreme = percentile >= opts.extremePct;
  const lowExtreme = percentile <= 1 - opts.extremePct;
  if (highExtreme) status = 'crowded_long';
  else if (lowExtreme) status = 'crowded_short';
  // Kontraindikator: Extrem PLUS weitere schnelle Zuspitzung in dieselbe Richtung.
  if (highExtreme && weekChange >= opts.fastChange) status = 'contrarian_alert';
  if (lowExtreme && weekChange <= -opts.fastChange) status = 'contrarian_alert';

  return { status, netNonComm: latest.noncommLong - latest.noncommShort, netRatio, percentile, weekChange };
}

/**
 * COT-Score-Komponente (0..1) für das Signalobjekt (PDF §11), richtungsabhängig.
 * Überlaufene Positionierung in Trade-Richtung → Abschlag (Kontraindikator).
 */
export function cotScore(pos: CotPositioning, direction: 'long' | 'short'): number {
  if (pos.status === 'not_applicable') return 0.5;
  if (pos.status === 'neutral') return 0.55;
  const crowdedWithTrade =
    (direction === 'long' && (pos.status === 'crowded_long' || (pos.status === 'contrarian_alert' && pos.netRatio > 0))) ||
    (direction === 'short' && (pos.status === 'crowded_short' || (pos.status === 'contrarian_alert' && pos.netRatio < 0)));
  const crowdedAgainstTrade =
    (direction === 'long' && (pos.status === 'crowded_short' || (pos.status === 'contrarian_alert' && pos.netRatio < 0))) ||
    (direction === 'short' && (pos.status === 'crowded_long' || (pos.status === 'contrarian_alert' && pos.netRatio > 0)));
  if (crowdedWithTrade) return pos.status === 'contrarian_alert' ? 0.2 : 0.35; // überlaufen → riskant
  if (crowdedAgainstTrade) return 0.65; // konträre Chance
  return 0.5;
}

// ── DB-Adapter ─────────────────────────────────────────────────────────────

export type CotSyncResult = { markets: number; rows: number; errors: string[] };

/** Holt die letzten ~60 Wochen je kuratiertem Markt und upsertet nach cot_reports. */
export async function syncCot(db: Db, markets: CotMarket[] = COT_MARKETS): Promise<CotSyncResult> {
  const result: CotSyncResult = { markets: 0, rows: 0, errors: [] };
  for (const m of markets) {
    try {
      const url =
        `${CFTC_DATASET_URL}?cftc_contract_market_code=${encodeURIComponent(m.code)}` +
        `&$order=report_date_as_yyyy_mm_dd DESC&$limit=60`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        result.errors.push(`${m.label}: HTTP ${res.status}`);
        continue;
      }
      const rows = parseCotRows(await res.json());
      for (const r of rows) {
        const inserted = await db
          .insert(cotReports)
          .values({
            marketCode: r.marketCode,
            marketName: r.marketName,
            label: m.label,
            reportDate: r.reportDate,
            openInterest: String(r.openInterest),
            noncommLong: String(r.noncommLong),
            noncommShort: String(r.noncommShort),
            commLong: String(r.commLong),
            commShort: String(r.commShort),
            source: 'cftc',
          })
          .onConflictDoNothing()
          .returning({ id: cotReports.id });
        result.rows += inserted.length;
      }
      result.markets += 1;
    } catch (err) {
      result.errors.push(`${m.label}: ${String(err)}`);
    }
  }
  return result;
}

export type CotSnapshotEntry = { market: CotMarket; positioning: CotPositioning; reportDate: string | null; weeks: number };

/** Liest die Positionierung je Markt (oder gezielt für ein App-Symbol). */
export async function getCotSnapshot(db: Db, symbol?: string): Promise<CotSnapshotEntry[]> {
  const markets = symbol ? [cotMarketForSymbol(symbol)].filter((m): m is CotMarket => m !== null) : COT_MARKETS;
  if (markets.length === 0) return [];
  const codes = markets.map((m) => m.code);
  const rows = await db
    .select()
    .from(cotReports)
    .where(and(eq(cotReports.source, 'cftc'), inArray(cotReports.marketCode, codes)))
    .orderBy(desc(cotReports.reportDate))
    .limit(60 * markets.length);

  const out: CotSnapshotEntry[] = [];
  for (const m of markets) {
    const hist: CotRow[] = rows
      .filter((r) => r.marketCode === m.code)
      .map((r) => ({
        marketCode: r.marketCode,
        marketName: r.marketName,
        reportDate: r.reportDate,
        openInterest: Number(r.openInterest),
        noncommLong: Number(r.noncommLong),
        noncommShort: Number(r.noncommShort),
        commLong: Number(r.commLong),
        commShort: Number(r.commShort),
      }));
    const positioning = deriveCotPositioning(hist);
    const latest = hist.slice().sort((a, b) => b.reportDate.getTime() - a.reportDate.getTime())[0] ?? null;
    out.push({ market: m, positioning, reportDate: latest ? latest.reportDate.toISOString() : null, weeks: hist.length });
  }
  return out;
}
