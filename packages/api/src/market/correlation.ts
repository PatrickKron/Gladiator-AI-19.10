import { eq } from 'drizzle-orm';
import { schema, type Db } from '@gladiator/db';
import { candleUniverse, getOhlcv, TWELVEDATA_VENUE, YAHOO_VENUE } from '@gladiator/market-data';
import { normalizeTradingPair, scanUniverse } from '@gladiator/jobs';
import { correlationMatrix, dailyCloses, utcDateKey } from '@gladiator/indicators';

/**
 * Heatmap › Korrelation: Universum (welche Symbole haben echte Tageskerzen?) und die
 * Matrix aus der DB. Die Mathematik (Ausrichtung, Log-Renditen, Pearson) liegt rein und
 * getestet in @gladiator/indicators (correlation.ts) — hier nur Laden und Zuschneiden.
 */

export const CORRELATION_VENUES = ['binance', YAHOO_VENUE, TWELVEDATA_VENUE] as const;
export type CorrelationVenue = (typeof CORRELATION_VENUES)[number];
export const CORRELATION_DAYS = [30, 90, 180] as const;
export type CorrelationDays = (typeof CORRELATION_DAYS)[number];
/** Unter so vielen gemeinsamen Tagesrenditen gibt es keine Zahl („zu wenig gemeinsame Daten"). */
export const MIN_COMMON_RETURNS = 20;
export const MAX_CORRELATION_SYMBOLS = 20;
export const DEFAULT_CORRELATION_SYMBOLS = 12;
/** Puffer vor dem Fensterbeginn, damit die erste Rendite im Fenster einen Basiskurs hat (Wochenenden, Feiertage). */
const BUFFER_DAYS = 14;
const DAY_MS = 86_400_000;

export type CandleSymbol = { symbol: string; venue: string; candles: number };
export type SymbolRef = { symbol: string; venue: string };
export type FavoriteAsset = { ticker: string; assetType: string; tradingPair: string | null };

/** Erstes Enddatum im Fenster: heute (UTC) minus `days` Tage → genau `days` Kalendertage bis gestern. */
export function correlationFromDate(nowMs: number, days: number): string {
  const todayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return utcDateKey(todayStart - days * DAY_MS);
}

/**
 * Vorauswahl: erst die Favoriten (Krypto über das normalisierte Paar auf Binance, sonst der
 * Ticker auf Yahoo/Twelve Data — die Venue mit den meisten Kerzen), dann das Scan-Universum.
 * Nur Symbole mit echten Tageskerzen. Kommen so keine zwei zusammen, wird mit dem Universum
 * aufgefüllt — eine Matrix braucht mindestens zwei Reihen.
 */
export function pickDefaultSymbols(universe: readonly CandleSymbol[], favorites: readonly FavoriteAsset[], scan: readonly string[], cap: number): SymbolRef[] {
  const out: SymbolRef[] = [];
  const seen = new Set<string>();
  const push = (s: CandleSymbol | undefined) => {
    if (!s || out.length >= cap) return;
    const key = `${s.venue}:${s.symbol}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ symbol: s.symbol, venue: s.venue });
  };
  const binance = new Map(universe.filter((u) => u.venue === 'binance').map((u) => [u.symbol.toUpperCase(), u]));
  const stockVenue = (ticker: string) =>
    universe
      .filter((u) => u.venue !== 'binance' && u.symbol.toUpperCase() === ticker)
      .sort((a, b) => b.candles - a.candles)[0];

  for (const f of favorites) {
    if (f.assetType.toUpperCase() === 'CRYPTO') {
      const pair = normalizeTradingPair(f.tradingPair);
      push(pair ? binance.get(pair) : undefined);
    } else {
      push(stockVenue(f.ticker.toUpperCase()));
    }
  }
  for (const s of scan) push(binance.get(s.toUpperCase()));
  if (out.length < 2) for (const u of universe) push(u);
  return out;
}

/** Alle Symbole mit genug echten Tageskerzen (je Venue) + Vorauswahl für die Matrix. */
export async function loadHeatmapUniverse(db: Db, userId: string) {
  const perVenue = await Promise.all(
    CORRELATION_VENUES.map(async (venue) =>
      (await candleUniverse(db, { venue, timeframe: '1d', minCandles: MIN_COMMON_RETURNS + 1, limit: 500 })).map((r) => ({ symbol: r.symbol, venue, candles: r.candles })),
    ),
  );
  const symbols: CandleSymbol[] = perVenue.flat();
  const favorites = await db
    .select({ ticker: schema.assets.ticker, assetType: schema.assets.assetType, tradingPair: schema.assets.tradingPair })
    .from(schema.assetFavorites)
    .innerJoin(schema.assets, eq(schema.assets.id, schema.assetFavorites.assetId))
    .where(eq(schema.assetFavorites.userId, userId))
    .orderBy(schema.assets.ticker);
  const scan = await scanUniverse(db);
  return {
    symbols,
    defaults: pickDefaultSymbols(symbols, favorites, scan, DEFAULT_CORRELATION_SYMBOLS),
    minReturns: MIN_COMMON_RETURNS,
    maxSymbols: MAX_CORRELATION_SYMBOLS,
  };
}

/** Matrix der Tagesrendite-Korrelationen für die gewählten Symbole im Fenster `days`. */
export async function loadCorrelation(db: Db, input: { symbols: SymbolRef[]; days: number }, now: Date = new Date()) {
  const nowMs = now.getTime();
  const fromDate = correlationFromDate(nowMs, input.days);
  const since = new Date(Date.parse(`${fromDate}T00:00:00Z`) - BUFFER_DAYS * DAY_MS);
  const series = await Promise.all(
    input.symbols.map(async (s) => dailyCloses(await getOhlcv(db, { venue: s.venue, symbol: s.symbol, timeframe: '1d', since }), nowMs)),
  );
  const { r, n } = correlationMatrix(series, { minReturns: MIN_COMMON_RETURNS, fromDate });
  const symbols = input.symbols.map((s, i) => {
    const dates = [...series[i]!.keys()].filter((d) => d >= fromDate);
    return { symbol: s.symbol, venue: s.venue, closes: dates.length, firstDate: dates[0] ?? null, lastDate: dates[dates.length - 1] ?? null };
  });
  const lastDates = symbols.map((s) => s.lastDate).filter((d): d is string => d !== null);
  return {
    days: input.days,
    fromDate,
    asOf: lastDates.length > 0 ? lastDates.sort()[lastDates.length - 1]! : null,
    minReturns: MIN_COMMON_RETURNS,
    symbols,
    matrix: r,
    counts: n,
  };
}
