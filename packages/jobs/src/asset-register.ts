import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '@gladiator/db';
import { schema } from '@gladiator/db';
import {
  ingestYahooChart,
  latestCandleTs,
  listBinanceSpotPairs,
  searchYahoo,
  yahooRefreshRange,
  YAHOO_LOAD_PLAN,
  YAHOO_VENUE,
  type SpotPair,
  type StockHit,
  type YahooChartMeta,
  type YahooIngestResult,
} from '@gladiator/market-data';
import { BASE_SYMBOLS, ensureCandles, normalizeTradingPair } from './universe.js';

/**
 * Asset-Register (Patrick 2026-10-25: „Assets ganz einfach hinzufügen — auch solche, die noch
 * nicht bei uns vertreten sind — und die Logik läuft im Backend, ohne dass der Nutzer es
 * merkt"). EIN Weg für jedes „Asset wählen/hinzufügen": Symbol gegen die echte Quelle prüfen
 * (Binance-Paarliste bzw. Yahoo-Suche/-Chart, notfalls vorhandene Kerzen), echte Kerzen laden,
 * Register-Zeile anlegen oder wiederverwenden (`assets.candle_venue` + `data_symbol`), auf Wunsch
 * Stern setzen, Audit. Ab dann läuft das Asset überall mit: Kerzen-Refresh (candle-refresh.ts),
 * Favoriten aller Quellen, Preis-Alarme, News, Kalender. Unbekannte Symbole werden NIE angelegt.
 */

const { assets, packages, assetFavorites, auditLog } = schema;

export const CANDLE_VENUES = ['binance', 'yahoo', 'twelvedata'] as const;
export type CandleVenue = (typeof CANDLE_VENUES)[number];

export function isCandleVenue(v: string | null | undefined): v is CandleVenue {
  return v != null && (CANDLE_VENUES as readonly string[]).includes(v);
}

/** Paket für vom Nutzer hinzugefügte Märkte (find-or-create über den festen Slug). */
export const USER_MARKETS_PACKAGE = {
  packageId: 'user-markets',
  name: 'Eigene Märkte',
  category: 'USER_MARKETS',
  description: 'Von dir hinzugefügte Märkte — Kerzen, Alarme und News laufen automatisch mit.',
} as const;

/** Yahoo-quoteType → Asset-Klasse (gleiche Großschreibung wie der v1-Katalog, siehe apps/web/src/lib/discover.ts). */
const YAHOO_TYPE: Record<string, string> = {
  EQUITY: 'STOCK',
  ETF: 'ETF',
  INDEX: 'INDEX',
  CURRENCY: 'FOREX',
  FUTURE: 'FUTURE',
  MUTUALFUND: 'FUND',
  CRYPTOCURRENCY: 'CRYPTO',
};

/**
 * Asset-Klasse aus der Quelle: Binance-Paar = CRYPTO; Yahoo nach quoteType (Suche oder
 * Chart-Metadaten). Fehlt der Typ, entscheidet die eindeutige Yahoo-Symbolik (^ = Index,
 * =X = Währungspaar, =F = Future); ein schlichter Ticker gilt dann als Aktie.
 */
export function assetTypeFor(venue: CandleVenue, quoteType: string | null | undefined, symbol: string): string {
  if (venue === 'binance') return 'CRYPTO';
  const mapped = quoteType ? YAHOO_TYPE[quoteType.toUpperCase()] : undefined;
  if (mapped) return mapped;
  const s = symbol.toUpperCase();
  if (s.startsWith('^')) return 'INDEX';
  if (s.endsWith('=X')) return 'FOREX';
  if (s.endsWith('=F')) return 'FUTURE';
  return 'STOCK';
}

/** Anzeige-Ticker: Basis des Binance-Paars; bei Yahoo ohne ^/=X/=F (Börsen-Suffix wie .DE bleibt — SAP.DE ≠ SAP). */
export function displayTicker(venue: CandleVenue, symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (venue === 'binance') return s.split('/')[0] ?? s;
  return s.replace(/^\^/, '').replace(/=[XF]$/, '');
}

const YAHOO_SYMBOL = /^\^?[A-Z0-9][A-Z0-9.\-=&]{0,23}$/;
const BINANCE_BASE = /^[A-Z0-9]{1,15}$/;

/** Eingabe → exaktes Kerzen-Symbol der Quelle, oder null (dann gar nicht erst fragen). */
export function normalizeRegisterSymbol(venue: CandleVenue, raw: string): string | null {
  const s = raw.trim().toUpperCase();
  if (!s) return null;
  if (venue === 'binance') {
    const pair = normalizeTradingPair(s);
    if (pair && /^[A-Z0-9]+\/(USDT|USDC)$/.test(pair)) return pair;
    return BINANCE_BASE.test(s) ? `${s}/USDT` : null;
  }
  return YAHOO_SYMBOL.test(s) ? s : null;
}

/** Register-ID (`assets.asset_id`) für neu angelegte Märkte — eindeutig je Quelle + Symbol. */
export function assetIdFor(venue: CandleVenue, dataSymbol: string): string {
  return `user:${venue}:${dataSymbol}`;
}

export type RegisteredAsset = {
  symbol: string;
  venue: CandleVenue;
  assetType: string;
  name: string;
  ticker: string;
  /** Jüngster Stern irgendeines Users (null = nur hinzugefügt bzw. Basis). */
  favoritedAt: Date | null;
  /** Im Paket „Eigene Märkte“ angelegt. */
  userAdded: boolean;
  createdAt: Date;
};

/**
 * Priorität des Registers (rein): Basis-Symbole zuerst, dann Favoriten (jüngster Stern zuerst),
 * dann nur Hinzugefügte (jüngste zuerst). Doppelte je Quelle+Symbol: der jüngste Stern zählt.
 */
export function orderRegistered(rows: RegisteredAsset[], baseSymbols: readonly string[] = BASE_SYMBOLS): RegisteredAsset[] {
  const byKey = new Map<string, RegisteredAsset>();
  for (const r of rows) {
    const key = `${r.venue}:${r.symbol}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, r);
      continue;
    }
    const newer = (r.favoritedAt?.getTime() ?? -1) > (prev.favoritedAt?.getTime() ?? -1) ? r : prev;
    byKey.set(key, { ...newer, userAdded: prev.userAdded || r.userAdded });
  }
  const out: RegisteredAsset[] = [];
  for (const symbol of baseSymbols) {
    const key = `binance:${symbol}`;
    const row = byKey.get(key);
    const ticker = symbol.split('/')[0] ?? symbol;
    out.push(row ?? { symbol, venue: 'binance', assetType: 'CRYPTO', name: ticker, ticker, favoritedAt: null, userAdded: false, createdAt: new Date(0) });
    byKey.delete(key);
  }
  const rest = [...byKey.values()];
  const favs = rest.filter((r) => r.favoritedAt).sort((a, b) => b.favoritedAt!.getTime() - a.favoritedAt!.getTime());
  const added = rest.filter((r) => !r.favoritedAt).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return [...out, ...favs, ...added];
}

/**
 * Registrierte Märkte mit Quelle: alle von Usern hinzugefügten bzw. mit Kerzenquelle verknüpften
 * Assets und alle Favoriten (ein User-Typ → Favoriten aller User), plus Basis-Symbole, nach
 * Priorität (orderRegistered). Katalog-Favoriten ohne Quelle: Krypto-Paar → Binance; sonst nur,
 * wenn für den Ticker schon echte Yahoo-/Twelve-Data-Kerzen liegen — nie eine geratene Quelle.
 * Ohne Cap; Verbraucher deckeln selbst (Kerzen-Refresh: REFRESH_MAX).
 */
export async function registeredAssets(db: Db): Promise<RegisteredAsset[]> {
  const res = await db.execute(sql`
    SELECT a.id, a.ticker, a.name, a.asset_type, a.trading_pair, a.candle_venue, a.data_symbol, a.created_at,
           (p.package_id = ${USER_MARKETS_PACKAGE.packageId}) AS user_added,
           max(f.created_at) AS fav_at
    FROM assets a
    JOIN packages p ON p.id = a.package_id
    LEFT JOIN asset_favorites f ON f.asset_id = a.id
    WHERE a.is_active = true AND (a.candle_venue IS NOT NULL OR f.asset_id IS NOT NULL)
    GROUP BY a.id, p.package_id
  `);
  type Row = {
    ticker: string;
    name: string;
    asset_type: string;
    trading_pair: string | null;
    candle_venue: string | null;
    data_symbol: string | null;
    created_at: string | Date;
    user_added: boolean;
    fav_at: string | Date | null;
  };
  const rows = res.rows as Row[];
  const resolved: RegisteredAsset[] = [];
  const unresolved: Row[] = [];
  const make = (r: Row, symbol: string, venue: CandleVenue): RegisteredAsset => ({
    symbol,
    venue,
    assetType: r.asset_type.toUpperCase(),
    name: r.name,
    ticker: r.ticker,
    favoritedAt: r.fav_at ? new Date(r.fav_at) : null,
    userAdded: Boolean(r.user_added),
    createdAt: new Date(r.created_at),
  });
  for (const r of rows) {
    if (isCandleVenue(r.candle_venue) && r.data_symbol) {
      resolved.push(make(r, r.data_symbol, r.candle_venue));
      continue;
    }
    const pair = r.asset_type.toUpperCase() === 'CRYPTO' ? normalizeTradingPair(r.trading_pair) : null;
    if (pair) resolved.push(make(r, pair, 'binance'));
    else unresolved.push(r);
  }
  if (unresolved.length > 0) {
    const tickers = [...new Set(unresolved.map((r) => r.ticker.toUpperCase()))];
    const found = await db.execute(sql`
      SELECT t.sym AS symbol,
             CASE WHEN EXISTS (SELECT 1 FROM ohlcv o WHERE o.venue = 'yahoo' AND o.symbol = t.sym) THEN 'yahoo'
                  WHEN EXISTS (SELECT 1 FROM ohlcv o WHERE o.venue = 'twelvedata' AND o.symbol = t.sym) THEN 'twelvedata' END AS venue
      FROM unnest(ARRAY[${sql.join(tickers.map((t) => sql`${t}`), sql`, `)}]::text[]) AS t(sym)
    `);
    const venueOf = new Map((found.rows as { symbol: string; venue: string | null }[]).filter((r) => isCandleVenue(r.venue)).map((r) => [r.symbol, r.venue as CandleVenue]));
    for (const r of unresolved) {
      const v = venueOf.get(r.ticker.toUpperCase());
      if (v) resolved.push(make(r, r.ticker.toUpperCase(), v));
    }
  }
  return orderRegistered(resolved);
}

// ── Register-Dienst ───────────────────────────────────────────────────────

export type AssetRegisterErrorCode = 'BAD_INPUT' | 'UNKNOWN_SYMBOL' | 'UNREACHABLE' | 'NO_CANDLES';

/** Fachlicher Fehler des Registers — die API übersetzt `code` in einen tRPC-Code. */
export class AssetRegisterError extends Error {
  constructor(
    readonly code: AssetRegisterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AssetRegisterError';
  }
}

type YahooIngest = (db: Db, opts: { symbol: string; timeframe?: string; range?: string }) => Promise<YahooIngestResult>;

/** Netz-Quellen austauschbar (Tests); Produktion nutzt die echten Adapter. */
export type RegisterDeps = {
  listPairs?: () => Promise<SpotPair[]>;
  searchYahoo?: (q: string, limit: number) => Promise<StockHit[]>;
  ensureBinance?: (db: Db, symbol: string) => Promise<{ symbol: string; inserted: number; errors: string[] }>;
  ingestYahoo?: YahooIngest;
  now?: () => Date;
};

export type RegisterInput = {
  venue: 'binance' | 'yahoo';
  symbol: string;
  /** Anzeigename aus der Suche des Clients — nur Fallback, die Quelle gewinnt. */
  name?: string | null;
  /** Yahoo-quoteType aus der Suche des Clients — nur Fallback, die Quelle gewinnt. */
  kind?: string | null;
  userId: string;
  /** Stern für den aufrufenden User setzen (product.addAsset); Kerzen auf Abruf lassen ihn unberührt. */
  favorite?: boolean;
  ip?: string | null;
  via?: string;
};

export type RegisteredAssetView = { id: number; assetId: string; ticker: string; name: string; assetType: string; venue: CandleVenue; symbol: string; exchange: string | null };

export type RegisterResult = {
  asset: RegisteredAssetView;
  /** Neue Zeile im Paket „Eigene Märkte“ (false = schon im Register oder Katalog-Asset wiederverwendet). */
  created: boolean;
  /** Ist das Asset jetzt Favorit des aufrufenden Users? */
  favorite: boolean;
  inserted: number;
  errors: string[];
  /** Echte Kerzen je Zeitrahmen in der DB (nach dem Laden). */
  candles: Record<string, number>;
};

type Descriptor = {
  venue: CandleVenue;
  dataSymbol: string;
  ticker: string;
  name: string;
  assetType: string;
  exchange: string | null;
  tradingPair: string | null;
  baseCurrency: string | null;
  quoteCurrency: string | null;
};

const errText = (err: unknown) => String(err instanceof Error ? err.message : err).slice(0, 200);

async function candleCounts(db: Db, venue: string, symbol: string): Promise<Record<string, number>> {
  const res = await db.execute(sql`SELECT timeframe, count(*)::int AS n FROM ohlcv WHERE venue = ${venue} AND symbol = ${symbol} GROUP BY timeframe`);
  return Object.fromEntries((res.rows as { timeframe: string; n: number }[]).map((r) => [r.timeframe, r.n]));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Yahoo-Kerzen laden — Erstladung UND Refresh in einem: je Zeitrahmen des Ladeplans
 * (1d · 1h · 15m) das kleinste Fenster ab der letzten Kerze (ohne Kerze das volle Erstlade-
 * Fenster). Lehnt Yahoo 60 Tage 15m ab, wird 1 Monat versucht. Fehler je Zeitrahmen, nie Abbruch.
 */
export async function loadYahooCandles(
  db: Db,
  symbol: string,
  opts: { ingest?: YahooIngest; now?: Date; pauseMs?: number } = {},
): Promise<{ inserted: number; errors: string[]; meta: YahooChartMeta | null }> {
  const ingest = opts.ingest ?? ingestYahooChart;
  const now = opts.now ?? new Date();
  let inserted = 0;
  let meta: YahooChartMeta | null = null;
  const errors: string[] = [];
  for (const [i, plan] of YAHOO_LOAD_PLAN.entries()) {
    if (i > 0 && opts.pauseMs) await sleep(opts.pauseMs);
    try {
      const last = await latestCandleTs(db, { venue: YAHOO_VENUE, symbol, timeframe: plan.timeframe });
      const range = yahooRefreshRange(plan.timeframe, last, now);
      let r = await ingest(db, { symbol, timeframe: plan.timeframe, range });
      if (r.error && range === '60d') r = await ingest(db, { symbol, timeframe: plan.timeframe, range: '1mo' });
      inserted += r.inserted;
      meta ??= r.meta ?? null;
      if (r.error) errors.push(`${plan.timeframe}: ${r.error}`);
    } catch (err) {
      errors.push(`${plan.timeframe}: ${errText(err)}`);
    }
  }
  return { inserted, errors, meta };
}

async function loadBinance(db: Db, symbol: string, deps: RegisterDeps): Promise<{ d: Descriptor; inserted: number; errors: string[]; candles: Record<string, number> }> {
  let pairs: SpotPair[] | null = null;
  let unreachable = '';
  try {
    pairs = await (deps.listPairs ?? listBinanceSpotPairs)();
  } catch (err) {
    unreachable = errText(err);
  }
  if (pairs) {
    if (!pairs.some((p) => p.symbol === symbol)) throw new AssetRegisterError('UNKNOWN_SYMBOL', `${symbol} ist kein Binance-Spot-Paar gegen USDT.`);
  } else if (Object.keys(await candleCounts(db, 'binance', symbol)).length === 0) {
    // Ohne Paarliste reicht nur eine vorhandene echte Kerzenreihe als Beleg.
    throw new AssetRegisterError('UNREACHABLE', `Binance nicht erreichbar — ${unreachable.slice(0, 160)}`);
  }
  const res = await (deps.ensureBinance ?? ensureCandles)(db, symbol);
  const candles = await candleCounts(db, 'binance', symbol);
  if (Object.keys(candles).length === 0) {
    throw new AssetRegisterError('NO_CANDLES', `Binance liefert keine Kerzen für ${symbol} (${res.errors[0] ?? 'unbekannt'}).`);
  }
  const [base, quote] = symbol.split('/') as [string, string];
  return {
    d: { venue: 'binance', dataSymbol: symbol, ticker: base, name: base, assetType: 'CRYPTO', exchange: 'BINANCE', tradingPair: symbol, baseCurrency: base, quoteCurrency: quote },
    inserted: res.inserted,
    errors: res.errors,
    candles,
  };
}

async function loadYahoo(db: Db, symbol: string, input: RegisterInput, deps: RegisterDeps): Promise<{ d: Descriptor; inserted: number; errors: string[]; candles: Record<string, number> }> {
  let hit: StockHit | null = null;
  try {
    hit = (await (deps.searchYahoo ?? searchYahoo)(symbol, 10)).find((h) => h.symbol === symbol) ?? null;
  } catch {
    // Suche nicht erreichbar — dann entscheiden die Chart-Antwort bzw. vorhandene Kerzen.
  }
  const load = await loadYahooCandles(db, symbol, { ingest: deps.ingestYahoo, now: deps.now?.() });
  const candles = await candleCounts(db, YAHOO_VENUE, symbol);
  if (Object.keys(candles).length === 0) {
    throw new AssetRegisterError('NO_CANDLES', `Yahoo liefert keine Kerzen für ${symbol} (${load.errors.join(' · ') || 'unbekannt'}).`);
  }
  const quoteType = hit?.type ?? load.meta?.instrumentType ?? input.kind ?? null;
  const clientName = input.name?.trim().slice(0, 120) || null;
  const ticker = displayTicker('yahoo', symbol);
  return {
    d: {
      venue: 'yahoo',
      dataSymbol: symbol,
      ticker,
      name: hit?.name ?? load.meta?.name ?? clientName ?? ticker,
      assetType: assetTypeFor('yahoo', quoteType, symbol),
      exchange: hit?.exchange || load.meta?.exchange || null,
      tradingPair: null,
      baseCurrency: null,
      quoteCurrency: load.meta?.currency ?? null,
    },
    inserted: load.inserted,
    errors: load.errors,
    candles,
  };
}

/** Paket „Eigene Märkte“ finden oder anlegen (idempotent über den Slug). */
export async function ensureUserMarketsPackage(db: Db): Promise<number> {
  await db
    .insert(packages)
    .values({ packageId: USER_MARKETS_PACKAGE.packageId, name: USER_MARKETS_PACKAGE.name, category: USER_MARKETS_PACKAGE.category, description: USER_MARKETS_PACKAGE.description })
    .onConflictDoNothing({ target: packages.packageId });
  const [p] = await db.select({ id: packages.id }).from(packages).where(eq(packages.packageId, USER_MARKETS_PACKAGE.packageId)).limit(1);
  if (!p) throw new Error('Paket „Eigene Märkte“ konnte nicht angelegt werden.');
  return p.id;
}

type AssetRow = typeof assets.$inferSelect;

async function findBySource(db: Db, venue: CandleVenue, dataSymbol: string): Promise<AssetRow | undefined> {
  const [row] = await db.select().from(assets).where(and(eq(assets.candleVenue, venue), eq(assets.dataSymbol, dataSymbol))).limit(1);
  return row;
}

/**
 * Register-Zeile sicherstellen: schon verknüpft → dieselbe Zeile; sonst ein passendes
 * Katalog-Asset (gleiches Paar bzw. gleicher Ticker + Klasse, noch ohne Quelle) wiederverwenden
 * und verknüpfen; sonst neu im Paket „Eigene Märkte“. Der Unique-Index (candle_venue,
 * data_symbol) macht parallele Aufrufe sicher.
 */
export async function upsertRegisteredAsset(db: Db, d: Descriptor): Promise<{ row: AssetRow; created: boolean; linked: boolean }> {
  const existing = await findBySource(db, d.venue, d.dataSymbol);
  if (existing) return { row: existing, created: false, linked: false };

  const reuse =
    d.venue === 'binance'
      ? sql`upper(replace(${assets.tradingPair}, '/', '')) = ${d.dataSymbol.replace('/', '')} AND ${assets.candleVenue} IS NULL`
      : sql`upper(${assets.ticker}) = ${d.ticker} AND upper(${assets.assetType}) = ${d.assetType} AND ${assets.candleVenue} IS NULL`;
  const [seed] = await db.select().from(assets).where(reuse).orderBy(asc(assets.id)).limit(1);
  if (seed) {
    try {
      const [row] = await db
        .update(assets)
        .set({ candleVenue: d.venue, dataSymbol: d.dataSymbol, isActive: true })
        .where(and(eq(assets.id, seed.id), isNull(assets.candleVenue)))
        .returning();
      if (row) return { row, created: false, linked: true };
    } catch {
      // paralleler Aufruf hat dieselbe Quelle schon verknüpft → unten neu lesen
    }
    const again = await findBySource(db, d.venue, d.dataSymbol);
    if (again) return { row: again, created: false, linked: false };
  }

  const packageId = await ensureUserMarketsPackage(db);
  const [row] = await db
    .insert(assets)
    .values({
      assetId: assetIdFor(d.venue, d.dataSymbol),
      packageId,
      ticker: d.ticker,
      name: d.name,
      exchange: d.exchange,
      assetType: d.assetType,
      tradingPair: d.tradingPair,
      baseCurrency: d.baseCurrency,
      quoteCurrency: d.quoteCurrency,
      candleVenue: d.venue,
      dataSymbol: d.dataSymbol,
    })
    .onConflictDoNothing()
    .returning();
  if (row) {
    await db.execute(sql`UPDATE packages SET asset_count = (SELECT count(*)::int FROM assets WHERE package_id = ${packageId}) WHERE id = ${packageId}`);
    return { row, created: true, linked: true };
  }
  const raced = await findBySource(db, d.venue, d.dataSymbol);
  if (raced) return { row: raced, created: false, linked: false };
  throw new Error(`Register-Zeile für ${d.venue}:${d.dataSymbol} konnte nicht angelegt werden.`);
}

/**
 * Ein Asset ins Register bringen (product.addAsset, market.ensureCandles, market.ensureStockCandles):
 * prüfen → Kerzen laden → Zeile sicherstellen → optional Stern → Audit (bei neuer Verknüpfung
 * oder Stern). Ohne eine einzige echte Kerze wird nichts angelegt.
 */
export async function registerAsset(db: Db, input: RegisterInput, deps: RegisterDeps = {}): Promise<RegisterResult> {
  const symbol = normalizeRegisterSymbol(input.venue, input.symbol);
  if (!symbol) {
    throw new AssetRegisterError('BAD_INPUT', `„${input.symbol.slice(0, 40)}“ ist kein gültiges ${input.venue === 'binance' ? 'Binance-Paar' : 'Yahoo-Symbol'}.`);
  }
  const loaded = input.venue === 'binance' ? await loadBinance(db, symbol, deps) : await loadYahoo(db, symbol, input, deps);
  const { row, created, linked } = await upsertRegisteredAsset(db, loaded.d);

  if (input.favorite) {
    await db.insert(assetFavorites).values({ userId: input.userId, assetId: row.id }).onConflictDoNothing();
  }
  const [fav] = await db
    .select({ assetId: assetFavorites.assetId })
    .from(assetFavorites)
    .where(and(eq(assetFavorites.userId, input.userId), eq(assetFavorites.assetId, row.id)))
    .limit(1);

  if (linked || input.favorite) {
    await db.insert(auditLog).values({
      actor: 'user',
      userId: input.userId,
      action: 'asset.register',
      entityType: 'asset',
      entityId: String(row.id),
      details: { venue: loaded.d.venue, symbol, created, linked, favorite: Boolean(input.favorite), inserted: loaded.inserted, errors: loaded.errors.slice(0, 10), via: input.via ?? null },
      ip: input.ip ?? null,
    });
  }

  return {
    asset: {
      id: row.id,
      assetId: row.assetId,
      ticker: row.ticker,
      name: row.name,
      assetType: row.assetType,
      venue: loaded.d.venue,
      symbol,
      exchange: row.exchange,
    },
    created,
    favorite: Boolean(fav),
    inserted: loaded.inserted,
    errors: loaded.errors,
    candles: loaded.candles,
  };
}

