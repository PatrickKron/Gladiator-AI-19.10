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
  /**
   * Erwarteter CFTC-Marktname (`market_and_exchange_names`). Der Sync übernimmt NUR Zeilen,
   * deren Name passt — ein falscher Code liefert so nie still fremde Daten.
   */
  cftcName: RegExp;
  /** App-Symbole, die genau diesen Markt notieren (exakt, Groß/Klein egal — KEIN Präfix-Abgleich). */
  appSymbols: string[];
  /**
   * Symbole, die den Markt spiegelbildlich notieren (USD/JPY ↔ CME-Yen-Kontrakt in USD je JPY):
   * ihre Positionierung wird gespiegelt ausgegeben (Netto-Long Yen = Netto-Short USD/JPY).
   */
  inverseSymbols?: string[];
};

/**
 * Kuratierte Märkte (PDF §6: Futures, Rohstoffe, Edelmetalle, Währungen, Indizes + CME-Krypto).
 * Codes = CFTC Legacy Futures-Only; jeder Code ist in cot.test.ts gegen die echte Quelle geprüft
 * (Marktname muss passen), der Sync prüft denselben Namen bei jedem Lauf.
 *
 * Alias-Regeln (Patrick 2026-10-25: „COT nur für das jeweilige Asset"):
 * - Nur EINDEUTIGE Schreibweisen: Yahoo (`GC=F`, `EURUSD=X`, `^GSPC`), TradingView (`GC1!`,
 *   `XAUUSD`, `SPX`), Twelve Data (`XAU/USD`), Krypto-Paare (`BTC/USDT`, `BTC-USD`, `BTCUSD`).
 * - Bewusst NICHT: nackte Kontrakt-Wurzeln, die zugleich US-Aktien-Ticker sind
 *   (GOLD = Barrick, CL = Colgate, ES = Eversource, WTI = W&T Offshore, SI, GC, NQ, HG).
 * - ETFs, die 1:1 den Basiswert abbilden (GLD/IAU, SLV, USO, UNG, CPER, PPLT, SPY/IVV/VOO, QQQ,
 *   IBIT/FBTC/GBTC, ETHA, FXE/FXY/FXB/FXF/FXA/FXC) zeigen die COT des BASISWERTS — die UI sagt
 *   das dazu. Gehebelte/inverse ETFs (SPXL, SQQQ …) bewusst nicht.
 * - Grayscale-Mini-Trusts notieren an der NYSE als `BTC`/`ETH` und bilden ebenfalls den Basiswert ab.
 */
export const COT_MARKETS: CotMarket[] = [
  { code: '088691', label: 'GOLD', cftcName: /GOLD/, appSymbols: ['GC=F', 'MGC=F', 'GC1!', 'XAUUSD', 'XAU/USD', 'GLD', 'IAU'] },
  { code: '084691', label: 'SILVER', cftcName: /SILVER/, appSymbols: ['SI=F', 'SIL=F', 'SI1!', 'XAGUSD', 'XAG/USD', 'SLV'] },
  { code: '067651', label: 'CRUDE_OIL_WTI', cftcName: /CRUDE OIL|WTI/, appSymbols: ['CL=F', 'MCL=F', 'CL1!', 'USOIL', 'WTIUSD', 'XTIUSD', 'USO'] },
  { code: '133741', label: 'BITCOIN_CME', cftcName: /BITCOIN/, appSymbols: ['BTC/USDT', 'BTC/USDC', 'BTC/USD', 'BTC-USD', 'BTCUSD', 'BTCUSDT', 'BTC=F', 'BTC1!', 'BTC', 'IBIT', 'FBTC', 'GBTC'] },
  { code: '146021', label: 'ETHER_CME', cftcName: /ETHER/, appSymbols: ['ETH/USDT', 'ETH/USDC', 'ETH/USD', 'ETH-USD', 'ETHUSD', 'ETHUSDT', 'ETH=F', 'ETH1!', 'ETH', 'ETHA'] },
  { code: '13874A', label: 'SP500_EMINI', cftcName: /S&P 500|S&P500/, appSymbols: ['ES=F', 'ES1!', '^GSPC', '^SPX', 'SPX', 'SP500', 'SPX500', 'US500', 'SPY', 'IVV', 'VOO'] },
  { code: '209742', label: 'NASDAQ100_EMINI', cftcName: /NASDAQ/, appSymbols: ['NQ=F', 'NQ1!', '^NDX', 'NDX', 'NAS100', 'US100', 'QQQ'] },
  { code: '099741', label: 'EURO_FX', cftcName: /EURO FX/, appSymbols: ['EURUSD=X', 'EUR/USD', 'EURUSD', '6E=F', '6E1!', 'FXE'] },
  { code: '097741', label: 'JAPANESE_YEN', cftcName: /YEN/, appSymbols: ['6J=F', '6J1!', 'FXY', 'JPYUSD=X', 'JPY/USD'], inverseSymbols: ['USDJPY=X', 'JPY=X', 'USD/JPY', 'USDJPY'] },
  { code: '096742', label: 'BRITISH_POUND', cftcName: /POUND|STERLING/, appSymbols: ['GBPUSD=X', 'GBP/USD', 'GBPUSD', '6B=F', '6B1!', 'FXB'] },
  { code: '092741', label: 'SWISS_FRANC', cftcName: /SWISS FRANC/, appSymbols: ['6S=F', '6S1!', 'FXF', 'CHFUSD=X', 'CHF/USD'], inverseSymbols: ['USDCHF=X', 'CHF=X', 'USD/CHF', 'USDCHF'] },
  { code: '232741', label: 'AUSTRALIAN_DOLLAR', cftcName: /AUSTRALIAN DOLLAR/, appSymbols: ['AUDUSD=X', 'AUD/USD', 'AUDUSD', '6A=F', '6A1!', 'FXA'] },
  { code: '090741', label: 'CANADIAN_DOLLAR', cftcName: /CANADIAN DOLLAR/, appSymbols: ['6C=F', '6C1!', 'FXC', 'CADUSD=X', 'CAD/USD'], inverseSymbols: ['USDCAD=X', 'CAD=X', 'USD/CAD', 'USDCAD'] },
  { code: '085692', label: 'COPPER', cftcName: /COPPER/, appSymbols: ['HG=F', 'HG1!', 'XCUUSD', 'COPPER', 'CPER'] },
  { code: '023651', label: 'NATURAL_GAS', cftcName: /NAT(URAL)? GAS/, appSymbols: ['NG=F', 'NG1!', 'XNGUSD', 'NATGAS', 'UNG'] },
  { code: '076651', label: 'PLATINUM', cftcName: /PLATINUM/, appSymbols: ['PL=F', 'PL1!', 'XPTUSD', 'XPT/USD', 'PPLT'] },
];

const COT_ALIAS = new Map<string, { market: CotMarket; inverse: boolean }>();
for (const m of COT_MARKETS) {
  for (const s of m.appSymbols) COT_ALIAS.set(s.toUpperCase(), { market: m, inverse: false });
  for (const s of m.inverseSymbols ?? []) COT_ALIAS.set(s.toUpperCase(), { market: m, inverse: true });
}

/** App-Symbol → COT-Markt (oder null, wenn kein passender Report existiert). Nur exakte Aliase. */
export function cotMarketForSymbol(symbol: string): CotMarket | null {
  return COT_ALIAS.get(symbol.trim().toUpperCase())?.market ?? null;
}

/** Notiert das Symbol den Markt spiegelbildlich (USD/JPY zum Yen-Kontrakt)? */
export function cotIsInverse(symbol: string): boolean {
  return COT_ALIAS.get(symbol.trim().toUpperCase())?.inverse ?? false;
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
 * Report-Zeilen aus Sicht eines spiegelbildlich notierten Symbols (USD/JPY statt Yen-Kontrakt):
 * Long und Short tauschen — Netto-Long der Fremdwährung = Netto-Short des Paars. Die
 * Positionierung wird danach ganz normal abgeleitet (exakt, auch bei Gleichständen im Perzentil).
 */
export function invertCotRows(rows: CotRow[]): CotRow[] {
  return rows.map((r) => ({ ...r, noncommLong: r.noncommShort, noncommShort: r.noncommLong, commLong: r.commShort, commShort: r.commLong }));
}

/** Sync-Schutz: nur Zeilen mit dem Code UND dem erwarteten Marktnamen; der Rest wird gemeldet. */
export function verifyCotRows(market: CotMarket, rows: CotRow[]): { rows: CotRow[]; rejected: string[] } {
  const ok: CotRow[] = [];
  const rejected: string[] = [];
  for (const r of rows) {
    if (r.marketCode === market.code && market.cftcName.test(r.marketName)) ok.push(r);
    else rejected.push(`${r.marketCode}: ${r.marketName}`);
  }
  return { rows: ok, rejected };
}

/** Wochenverlauf netRatio (aufsteigend); OI ≤ 0 fällt raus (kein Teilen durch null). */
export function cotHistoryPoints(rows: CotRow[]): { reportDate: string; netRatio: number }[] {
  return rows
    .filter((r) => r.openInterest > 0)
    .sort((a, b) => a.reportDate.getTime() - b.reportDate.getTime())
    .map((r) => ({ reportDate: r.reportDate.toISOString(), netRatio: (r.noncommLong - r.noncommShort) / r.openInterest }));
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
      const parsed = parseCotRows(await res.json());
      const { rows, rejected } = verifyCotRows(m, parsed);
      if (rejected.length > 0) {
        // Falscher Code oder umbenannter Markt: laut melden, nichts Fremdes speichern.
        result.errors.push(`${m.label}: ${rejected.length} Zeile(n) mit unerwartetem Marktnamen verworfen (${rejected[0]})`);
      }
      if (parsed.length > 0 && rows.length === 0) continue;
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

/** Markt ohne interne Prüf-Felder (geht über tRPC an die UI). */
export type CotMarketInfo = { code: string; label: string; appSymbols: string[] };

export type CotSnapshotEntry = {
  market: CotMarketInfo;
  positioning: CotPositioning;
  reportDate: string | null;
  weeks: number;
  /** true: Positionierung aus Sicht des (spiegelbildlich notierten) Symbols, z. B. USD/JPY. */
  inverse: boolean;
};

const marketInfo = (m: CotMarket): CotMarketInfo => ({ code: m.code, label: m.label, appSymbols: m.appSymbols });

async function readCotRows(db: Db, markets: CotMarket[], perMarket: number): Promise<Map<string, CotRow[]>> {
  const codes = markets.map((m) => m.code);
  const rows = await db
    .select()
    .from(cotReports)
    .where(and(eq(cotReports.source, 'cftc'), inArray(cotReports.marketCode, codes)))
    .orderBy(desc(cotReports.reportDate))
    .limit(perMarket * markets.length);
  const out = new Map<string, CotRow[]>();
  for (const r of rows) {
    const list = out.get(r.marketCode) ?? [];
    list.push({
      marketCode: r.marketCode,
      marketName: r.marketName,
      reportDate: r.reportDate,
      openInterest: Number(r.openInterest),
      noncommLong: Number(r.noncommLong),
      noncommShort: Number(r.noncommShort),
      commLong: Number(r.commLong),
      commShort: Number(r.commShort),
    });
    out.set(r.marketCode, list);
  }
  return out;
}

/**
 * Liest die Positionierung je Markt (oder gezielt für ein App-Symbol). Mit Symbol: nur dessen
 * Markt (exakter Alias), bei spiegelbildlicher Notierung gespiegelt (`inverse: true`).
 */
export async function getCotSnapshot(db: Db, symbol?: string): Promise<CotSnapshotEntry[]> {
  const markets = symbol ? [cotMarketForSymbol(symbol)].filter((m): m is CotMarket => m !== null) : COT_MARKETS;
  if (markets.length === 0) return [];
  const inverse = symbol ? cotIsInverse(symbol) : false;
  const byCode = await readCotRows(db, markets, 60);

  const out: CotSnapshotEntry[] = [];
  for (const m of markets) {
    const hist = byCode.get(m.code) ?? [];
    const positioning = deriveCotPositioning(inverse ? invertCotRows(hist) : hist);
    const latest = hist[0] ?? null;
    out.push({ market: marketInfo(m), positioning, reportDate: latest ? latest.reportDate.toISOString() : null, weeks: hist.length, inverse });
  }
  return out;
}

/** Wochenverlauf (netRatio) des COT-Markts eines Symbols — null, wenn es keinen gibt. */
export async function getCotHistory(db: Db, symbol: string, weeks = 60): Promise<{ market: CotMarketInfo; inverse: boolean; points: { reportDate: string; netRatio: number }[] } | null> {
  const m = cotMarketForSymbol(symbol);
  if (!m) return null;
  const inverse = cotIsInverse(symbol);
  const byCode = await readCotRows(db, [m], Math.max(1, Math.min(weeks, 260)));
  const rows = byCode.get(m.code) ?? [];
  return { market: marketInfo(m), inverse, points: cotHistoryPoints(inverse ? invertCotRows(rows) : rows) };
}
