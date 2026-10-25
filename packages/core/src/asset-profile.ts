/**
 * Asset → Klasse + relevante Währungen (Chart-Seite, Patrick 2026-10-25: „alles unter Analyse,
 * Makro und Risiko soll zum GEWÄHLTEN Asset passen"). Kleiner reiner Helfer, den Server
 * (Termin-Filter, Analyse) und Web (welche Makro-Blöcke gelten) gleich benutzen.
 *
 * KONSERVATIV: nur feste, dokumentierte Regeln (Symbol-Schreibweise + Quelle). Was nicht
 * eindeutig ist, kommt als `null` zurück — nie geraten und als Tatsache ausgegeben.
 * - Krypto (Binance & Co., `BASE/QUOTE`): Stable-Quote USDT/USDC/… → USD. Andere Fiat-Quote →
 *   USD (Leitwährung des Krypto-Markts) + Notierungswährung. Krypto-Kreuz (ETH/BTC) → null.
 * - Forex: `EURUSD=X`, `JPY=X` (Yahoo-Kurzform = USD/JPY), `EUR/USD`, `GBPUSD`.
 * - Edelmetalle `XAU/USD`, `XAGUSD` → commodity (Weltmarkt in USD, daher immer mit USD).
 * - Yahoo-Futures `GC=F`, `CL=F`, … → commodity bzw. future (Index/Währung/Zins/Krypto).
 * - Yahoo-Indizes `^GSPC`, `^GDAXI`, … nach Heimatmarkt.
 * - Aktien/ETF (Yahoo/Twelve Data): Börsen-Suffix (`.DE` → EUR, `.L` → GBP …), ohne Suffix US → USD.
 *   ETF nur für bekannte Ticker, sonst `stock` (beide werden gleich behandelt).
 */

/** Klasse fürs Asset-Profil — bewusst eigener Typ: das Signal-Modell (`AssetClass`) kennt kein `future`. */
export type ProfileAssetClass = 'crypto' | 'stock' | 'etf' | 'index' | 'forex' | 'commodity' | 'future';

export type AssetProfile = {
  /** Normalisiertes Symbol (Großbuchstaben, ohne Settle-Suffix `:USDT`). */
  symbol: string;
  assetClass: ProfileAssetClass;
  /** Basis (BTC bei BTC/USDT, EUR bei EURUSD=X, XAU bei XAU/USD); null bei Aktien/Indizes. */
  base: string | null;
  /** ISO-Währungen, deren Wirtschaftstermine das Asset bewegen; null = unbekannt. */
  currencies: string[] | null;
  /** Währung, in der der Kurs notiert; null = unbekannt oder Unterwährung (London notiert in Pence). */
  quoteCurrency: string | null;
};

/** ISO-Fiat-Codes, die als Währungsleg gelten (bewusst nur echte Währungen, keine Stables). */
const FIAT = new Set(['USD', 'EUR', 'JPY', 'GBP', 'CHF', 'AUD', 'CAD', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'TRY', 'ZAR', 'MXN', 'BRL', 'CNY', 'CNH', 'HKD', 'SGD', 'INR', 'KRW', 'TWD', 'THB', 'ILS']);
/** Krypto-Quotes, die 1:1 am USD hängen. */
const USD_STABLES = new Set(['USD', 'USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'DAI', 'USDP', 'USDE', 'USDS', 'USD1']);
const CRYPTO_VENUES = new Set(['binance', 'binanceusdm', 'bybit', 'okx', 'kraken', 'coinbase', 'bitget', 'kucoin', 'mexc', 'gate', 'hyperliquid', 'dydx']);
const STOCK_VENUES = new Set(['yahoo', 'twelvedata']);
const METALS = new Set(['XAU', 'XAG', 'XPT', 'XPD']);

/** Yahoo-Futures-Wurzel → Klasse/Basis/Währungen (nur sicher bekannte Kontrakte). */
const FUTURES: Record<string, { cls: 'commodity' | 'future'; base: string | null; currencies: string[] }> = {
  // Metalle (COMEX/NYMEX)
  GC: { cls: 'commodity', base: 'XAU', currencies: ['USD'] },
  MGC: { cls: 'commodity', base: 'XAU', currencies: ['USD'] },
  SI: { cls: 'commodity', base: 'XAG', currencies: ['USD'] },
  SIL: { cls: 'commodity', base: 'XAG', currencies: ['USD'] },
  PL: { cls: 'commodity', base: 'XPT', currencies: ['USD'] },
  PA: { cls: 'commodity', base: 'XPD', currencies: ['USD'] },
  HG: { cls: 'commodity', base: 'COPPER', currencies: ['USD'] },
  // Energie
  CL: { cls: 'commodity', base: 'WTI', currencies: ['USD'] },
  MCL: { cls: 'commodity', base: 'WTI', currencies: ['USD'] },
  BZ: { cls: 'commodity', base: 'BRENT', currencies: ['USD'] },
  NG: { cls: 'commodity', base: 'NATGAS', currencies: ['USD'] },
  RB: { cls: 'commodity', base: null, currencies: ['USD'] },
  HO: { cls: 'commodity', base: null, currencies: ['USD'] },
  // Agrar (CBOT/ICE US, in USD)
  ZC: { cls: 'commodity', base: null, currencies: ['USD'] },
  ZW: { cls: 'commodity', base: null, currencies: ['USD'] },
  ZS: { cls: 'commodity', base: null, currencies: ['USD'] },
  KE: { cls: 'commodity', base: null, currencies: ['USD'] },
  CC: { cls: 'commodity', base: null, currencies: ['USD'] },
  KC: { cls: 'commodity', base: null, currencies: ['USD'] },
  SB: { cls: 'commodity', base: null, currencies: ['USD'] },
  CT: { cls: 'commodity', base: null, currencies: ['USD'] },
  LE: { cls: 'commodity', base: null, currencies: ['USD'] },
  HE: { cls: 'commodity', base: null, currencies: ['USD'] },
  // US-Index-Futures (CME/CBOT)
  ES: { cls: 'future', base: null, currencies: ['USD'] },
  MES: { cls: 'future', base: null, currencies: ['USD'] },
  NQ: { cls: 'future', base: null, currencies: ['USD'] },
  MNQ: { cls: 'future', base: null, currencies: ['USD'] },
  YM: { cls: 'future', base: null, currencies: ['USD'] },
  RTY: { cls: 'future', base: null, currencies: ['USD'] },
  // US-Zins-Futures
  ZN: { cls: 'future', base: null, currencies: ['USD'] },
  ZB: { cls: 'future', base: null, currencies: ['USD'] },
  ZF: { cls: 'future', base: null, currencies: ['USD'] },
  ZT: { cls: 'future', base: null, currencies: ['USD'] },
  DX: { cls: 'future', base: 'USD', currencies: ['USD'] },
  // CME-Währungs-Futures (Fremdwährung in USD)
  '6E': { cls: 'future', base: 'EUR', currencies: ['EUR', 'USD'] },
  '6J': { cls: 'future', base: 'JPY', currencies: ['JPY', 'USD'] },
  '6B': { cls: 'future', base: 'GBP', currencies: ['GBP', 'USD'] },
  '6S': { cls: 'future', base: 'CHF', currencies: ['CHF', 'USD'] },
  '6A': { cls: 'future', base: 'AUD', currencies: ['AUD', 'USD'] },
  '6C': { cls: 'future', base: 'CAD', currencies: ['CAD', 'USD'] },
  '6N': { cls: 'future', base: 'NZD', currencies: ['NZD', 'USD'] },
  '6M': { cls: 'future', base: 'MXN', currencies: ['MXN', 'USD'] },
  // CME-Krypto-Futures
  BTC: { cls: 'future', base: 'BTC', currencies: ['USD'] },
  MBT: { cls: 'future', base: 'BTC', currencies: ['USD'] },
  ETH: { cls: 'future', base: 'ETH', currencies: ['USD'] },
  MET: { cls: 'future', base: 'ETH', currencies: ['USD'] },
};

/** Yahoo-Index (^…) → Heimatwährung. */
const INDICES: Record<string, string> = {
  GSPC: 'USD', SPX: 'USD', NDX: 'USD', IXIC: 'USD', DJI: 'USD', RUT: 'USD', VIX: 'USD', SOX: 'USD', NYA: 'USD', TNX: 'USD', TYX: 'USD', FVX: 'USD', IRX: 'USD',
  GDAXI: 'EUR', STOXX50E: 'EUR', FCHI: 'EUR', AEX: 'EUR', IBEX: 'EUR', ATX: 'EUR',
  FTSE: 'GBP', FTMC: 'GBP',
  N225: 'JPY', SSMI: 'CHF', HSI: 'HKD', GSPTSE: 'CAD', AXJO: 'AUD', BSESN: 'INR', NSEI: 'INR', KS11: 'KRW', BVSP: 'BRL', MXX: 'MXN',
};

/**
 * Yahoo-Börsen-Suffix → [Termin-Währung, Kurswährung]. Kurswährung null, wo Yahoo in der
 * Unterwährung notiert (London GBp, Johannesburg ZAc, Tel Aviv ILA) — dort zeigen wir kein Zeichen.
 */
const SUFFIX: Record<string, [string, string | null]> = {
  DE: ['EUR', 'EUR'], F: ['EUR', 'EUR'], BE: ['EUR', 'EUR'], MU: ['EUR', 'EUR'], SG: ['EUR', 'EUR'], HM: ['EUR', 'EUR'], DU: ['EUR', 'EUR'], HA: ['EUR', 'EUR'],
  VI: ['EUR', 'EUR'], PA: ['EUR', 'EUR'], AS: ['EUR', 'EUR'], BR: ['EUR', 'EUR'], MI: ['EUR', 'EUR'], MC: ['EUR', 'EUR'], LS: ['EUR', 'EUR'], IR: ['EUR', 'EUR'], HE: ['EUR', 'EUR'],
  L: ['GBP', null], SW: ['CHF', 'CHF'], T: ['JPY', 'JPY'], HK: ['HKD', 'HKD'], TO: ['CAD', 'CAD'], V: ['CAD', 'CAD'], AX: ['AUD', 'AUD'], NZ: ['NZD', 'NZD'],
  ST: ['SEK', 'SEK'], OL: ['NOK', 'NOK'], CO: ['DKK', 'DKK'], SS: ['CNY', 'CNY'], SZ: ['CNY', 'CNY'], KS: ['KRW', 'KRW'], KQ: ['KRW', 'KRW'],
  NS: ['INR', 'INR'], BO: ['INR', 'INR'], SA: ['BRL', 'BRL'], MX: ['MXN', 'MXN'], WA: ['PLN', 'PLN'], SI: ['SGD', 'SGD'], JO: ['ZAR', null], TW: ['TWD', 'TWD'], TA: ['ILS', null],
};

/** Bekannte US-ETFs (sonst `stock` — Termin-Logik ist für beide gleich). */
const ETFS = new Set([
  'SPY', 'IVV', 'VOO', 'VTI', 'QQQ', 'DIA', 'IWM', 'EEM', 'EFA', 'GLD', 'IAU', 'SLV', 'USO', 'UNG', 'CPER', 'PPLT', 'TLT', 'IEF', 'SHY', 'BIL',
  'HYG', 'LQD', 'JNK', 'EMB', 'XLE', 'XLF', 'XLK', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'SMH', 'SOXX', 'SOXL', 'TQQQ', 'SQQQ', 'UPRO',
  'SH', 'PSQ', 'RWM', 'UVXY', 'VIXY', 'SVXY', 'ARKK', 'GDX', 'GDXJ', 'IBIT', 'FBTC', 'GBTC', 'ETHA', 'BITO', 'BITI', 'URA', 'QTUM', 'PHO', 'EWW', 'VNM',
  'FXE', 'FXY', 'FXB', 'FXF', 'FXA', 'FXC',
]);

const uniq = (xs: string[]): string[] => [...new Set(xs)];

function cryptoPair(symbol: string, base: string, quote: string): AssetProfile | null {
  if (!/^[A-Z0-9]{1,15}$/.test(base) || !/^[A-Z0-9]{2,10}$/.test(quote)) return null;
  if (USD_STABLES.has(quote)) return { symbol, assetClass: 'crypto', base, currencies: ['USD'], quoteCurrency: 'USD' };
  if (FIAT.has(quote)) return { symbol, assetClass: 'crypto', base, currencies: uniq(['USD', quote]), quoteCurrency: quote };
  return { symbol, assetClass: 'crypto', base, currencies: null, quoteCurrency: null };
}

function fxPair(symbol: string, base: string, quote: string): AssetProfile | null {
  if (!FIAT.has(base) || !FIAT.has(quote) || base === quote) return null;
  return { symbol, assetClass: 'forex', base, currencies: [base, quote], quoteCurrency: quote };
}

function metalPair(symbol: string, base: string, quote: string): AssetProfile | null {
  if (!METALS.has(base) || !FIAT.has(quote)) return null;
  return { symbol, assetClass: 'commodity', base, currencies: uniq([quote, 'USD']), quoteCurrency: quote };
}

/** `BASE/QUOTE` ohne bekannte Quelle: Metall, Forex oder Krypto — in dieser Reihenfolge. */
function slashPair(symbol: string, base: string, quote: string): AssetProfile | null {
  return metalPair(symbol, base, quote) ?? fxPair(symbol, base, quote) ?? (FIAT.has(base) ? null : cryptoPair(symbol, base, quote));
}

function equity(symbol: string, ticker: string, ccy: string | null, quote: string | null): AssetProfile {
  return { symbol, assetClass: ETFS.has(ticker) ? 'etf' : 'stock', base: null, currencies: ccy ? [ccy] : null, quoteCurrency: quote };
}

/**
 * Profil eines Chart-Symbols. `venue` = Kerzenquelle der App (`binance`, `yahoo`, `twelvedata` …);
 * ohne Quelle werden nur eindeutige Schreibweisen erkannt (ein nackter Ticker bleibt null).
 */
export function assetProfile(raw: string, venue?: string | null): AssetProfile | null {
  const full = raw.trim().toUpperCase();
  if (!full || /\s/.test(full)) return null;
  const v = venue ? venue.toLowerCase() : null;

  if (v && CRYPTO_VENUES.has(v)) {
    const symbol = full.split(':')[0]!;
    const parts = symbol.split('/');
    if (parts.length !== 2) return null;
    return cryptoPair(symbol, parts[0]!, parts[1]!);
  }
  const symbol = full;

  // Yahoo-Forex: EURUSD=X, JPY=X (= USD/JPY)
  const fx = /^([A-Z]{3})([A-Z]{3})?=X$/.exec(symbol);
  if (fx) return fx[2] ? fxPair(symbol, fx[1]!, fx[2]) : fxPair(symbol, 'USD', fx[1]!);
  if (symbol.endsWith('=X')) return null;

  // Yahoo-Futures: GC=F …
  const fut = /^([A-Z0-9]{1,4})=F$/.exec(symbol);
  if (fut) {
    const known = FUTURES[fut[1]!];
    if (known) return { symbol, assetClass: known.cls, base: known.base, currencies: known.currencies, quoteCurrency: 'USD' };
    return { symbol, assetClass: 'future', base: null, currencies: null, quoteCurrency: null };
  }
  if (symbol.endsWith('=F')) return null;

  // Yahoo-Indizes: ^GSPC …
  if (symbol.startsWith('^')) {
    const id = symbol.slice(1);
    if (!/^[A-Z0-9.]{1,12}$/.test(id)) return null;
    const ccy = INDICES[id] ?? null;
    return { symbol, assetClass: 'index', base: null, currencies: ccy ? [ccy] : null, quoteCurrency: ccy };
  }

  // BASE/QUOTE (Twelve Data, TradingView, generisch)
  const slash = symbol.split('/');
  if (slash.length === 2) return slashPair(symbol, slash[0]!, slash[1]!);
  if (slash.length > 2) return null;

  // Yahoo-Krypto: BTC-USD
  const dash = /^([A-Z0-9]{2,10})-([A-Z]{3,4})$/.exec(symbol);
  if (dash && (FIAT.has(dash[2]!) || USD_STABLES.has(dash[2]!)) && !FIAT.has(dash[1]!)) return cryptoPair(symbol, dash[1]!, dash[2]!);

  // Zusammengeschrieben: XAUUSD, EURUSD (beide Teile eindeutig)
  const six = /^([A-Z]{3})([A-Z]{3})$/.exec(symbol);
  if (six) {
    const p = metalPair(symbol, six[1]!, six[2]!) ?? fxPair(symbol, six[1]!, six[2]!);
    if (p) return p;
  }

  if (!v || !STOCK_VENUES.has(v)) return null;

  // Aktien/ETF mit Börsen-Suffix (SAP.DE, HSBA.L, 7203.T)
  const suf = /^([A-Z0-9][A-Z0-9&-]{0,11})\.([A-Z]{1,3})$/.exec(symbol);
  if (suf) {
    const m = SUFFIX[suf[2]!];
    return m ? equity(symbol, suf[1]!, m[0], m[1]) : equity(symbol, suf[1]!, null, null);
  }
  // US-Ticker ohne Suffix (AAPL, BRK-B)
  if (/^[A-Z][A-Z0-9]{0,5}(-[A-Z])?$/.test(symbol)) return equity(symbol, symbol, 'USD', 'USD');
  return null;
}

/** US-Aktienmarkt (Aktie/ETF/Index in USD) — dort gilt z. B. der Buffett-Indikator. */
export function isUsEquity(p: AssetProfile | null): boolean {
  return p !== null && (p.assetClass === 'stock' || p.assetClass === 'etf' || p.assetClass === 'index') && p.currencies?.length === 1 && p.currencies[0] === 'USD';
}

/** Kalender-Event mit der regelbasierten Einordnung aus `classifyEvent` (@gladiator/market-data). */
export type AssetEventLike = {
  currency: string | null;
  /** 1 = niedrig … 3 = hoch (Feed-Wert, wie die Engine filtert). */
  importance: number | null;
  scope: 'global' | 'usd' | 'eur' | 'gbp' | 'jpy' | 'regional';
  cryptoRelevance: number;
  equityRelevance: number;
};

/** Mindest-Relevanz eines Termins für das Asset (0..3, `classifyEvent`). */
export const ASSET_EVENT_MIN_RELEVANCE = 2;

/**
 * Betrifft ein High-Impact-Termin dieses Asset? Regeln:
 * 1. nur importance ≥ 3 — exakt der Filter der Engine (`noTradeWindowFor`);
 * 2. Asset/Währung unbekannt ⇒ JA (konservativ: lieber ein Termin zu viel als einer zu wenig);
 * 3. Termin-Währung ∈ Asset-Währungen ODER globale Reichweite (FOMC);
 * 4. Relevanz ≥ 2: Krypto nach `cryptoRelevance`, US-Aktien/ETF/Index nach `equityRelevance`;
 *    Forex, Rohstoffe, Futures und Nicht-US-Aktien reagieren direkt auf ihre Währung (Regel 3 reicht) —
 *    `equityRelevance` ist im Klassifikator nur für US-Aktien definiert.
 */
export function eventRelevantForAsset(profile: AssetProfile | null, e: AssetEventLike): boolean {
  if ((e.importance ?? 0) < 3) return false;
  if (!profile || profile.currencies === null) return true;
  const ccy = e.currency ? e.currency.toUpperCase() : null;
  const matches = (ccy !== null && profile.currencies.includes(ccy)) || e.scope === 'global';
  if (!matches) return false;
  if (profile.assetClass === 'crypto') return e.cryptoRelevance >= ASSET_EVENT_MIN_RELEVANCE;
  if (isUsEquity(profile)) return e.equityRelevance >= ASSET_EVENT_MIN_RELEVANCE;
  return true;
}

/**
 * Wirkung des aktiven No-Trade-Fensters der Engine auf das Asset. Die Engine sperrt GLOBAL —
 * `global` heißt: Sperre aktiv, obwohl der Termin dieses Asset nicht betrifft. Die UI darf das
 * Asset dann NIE als frei zeigen.
 */
export function noTradeScope(windowEvent: AssetEventLike | null, profile: AssetProfile | null): 'none' | 'asset' | 'global' {
  if (!windowEvent) return 'none';
  return eventRelevantForAsset(profile, { ...windowEvent, importance: 3 }) ? 'asset' : 'global';
}
