import ccxt from 'ccxt';

/**
 * Börsen-Vergleich (Vision-Punkt 2): für ein Symbol die ÖFFENTLICHEN Kurse
 * mehrerer Börsen (keyless) — Bid/Ask, Taker-Gebühr, bei Perps Funding und
 * max. Hebel. Gerankt nach EFFEKTIVEM Preis inkl. Gebühr, damit „günstigster
 * Ask" nicht mit „günstigstem Kauf" verwechselt wird. Nicht erreichbare
 * Börsen bleiben sichtbar („nicht erreichbar"), nie geschätzt.
 */

export const COMPARE_VENUES = ['binance', 'bybit', 'okx', 'bitget', 'kucoin', 'mexc', 'gate', 'hyperliquid'] as const;
export type CompareVenue = (typeof COMPARE_VENUES)[number];

export type VenueQuoteStatus = 'ok' | 'not_listed' | 'unavailable';

export type VenueQuote = {
  venue: string;
  status: VenueQuoteStatus;
  marketSymbol: string | null;
  marketType: 'spot' | 'swap' | null;
  bid: number | null;
  ask: number | null;
  /** Taker-Gebühr als Anteil (0.001 = 0,1 %), laut Börsen-Marktdaten. */
  takerFee: number | null;
  /** Funding je Periode (Perps), sonst null. */
  fundingRate: number | null;
  maxLeverage: number | null;
  error: string | null;
};

export type RawVenueQuote = {
  bid: number | null;
  ask: number | null;
  takerFee: number | null;
  fundingRate: number | null;
  maxLeverage: number | null;
  marketType: 'spot' | 'swap';
  marketSymbol: string;
};

/** Symbol je Börse: Hyperliquid kennt nur USDC-Perps, sonst Spot wie angefragt. */
export function venueSymbol(venue: string, symbol: string): { symbol: string; type: 'spot' | 'swap' } {
  const [base] = symbol.split('/');
  if (venue === 'hyperliquid') return { symbol: `${base}/USDC:USDC`, type: 'swap' };
  return { symbol, type: 'spot' };
}

export type RankedVenueQuote = VenueQuote & {
  effectivePrice: number | null;
  /** Abstand zum besten effektiven Preis in Basispunkten (0 = bester). */
  diffBps: number | null;
  best: boolean;
};

export function rankVenueQuotes(quotes: VenueQuote[], side: 'buy' | 'sell'): RankedVenueQuote[] {
  const withPrice = quotes.map((q) => {
    const raw = side === 'buy' ? q.ask : q.bid;
    const fee = q.takerFee !== null && Number.isFinite(q.takerFee) ? q.takerFee : 0;
    const effectivePrice = q.status === 'ok' && raw !== null && raw > 0 ? (side === 'buy' ? raw * (1 + fee) : raw * (1 - fee)) : null;
    return { ...q, effectivePrice };
  });
  const priced = withPrice.filter((q) => q.effectivePrice !== null);
  const bestPrice =
    priced.length === 0
      ? null
      : side === 'buy'
        ? Math.min(...priced.map((q) => q.effectivePrice!))
        : Math.max(...priced.map((q) => q.effectivePrice!));
  return withPrice
    .map((q) => ({
      ...q,
      diffBps:
        q.effectivePrice === null || bestPrice === null ? null : (Math.abs(q.effectivePrice - bestPrice) / bestPrice) * 10_000,
      best: q.effectivePrice !== null && q.effectivePrice === bestPrice,
    }))
    .sort((a, b) => {
      if (a.effectivePrice === null) return b.effectivePrice === null ? 0 : 1;
      if (b.effectivePrice === null) return -1;
      return side === 'buy' ? a.effectivePrice - b.effectivePrice : b.effectivePrice - a.effectivePrice;
    });
}

export type VenueQuoteFetcher = (venue: string, symbol: string) => Promise<RawVenueQuote | null>;

/** Alle Börsen parallel; Fehler je Börse isoliert und ehrlich ausgewiesen. */
export async function fetchVenueQuotes(symbol: string, venues: readonly string[], fetcher: VenueQuoteFetcher = ccxtVenueQuote): Promise<VenueQuote[]> {
  const settled = await Promise.allSettled(venues.map((v) => fetcher(v, symbol)));
  return settled.map((r, i): VenueQuote => {
    const venue = venues[i]!;
    const empty = { venue, marketSymbol: null, marketType: null, bid: null, ask: null, takerFee: null, fundingRate: null, maxLeverage: null };
    if (r.status === 'rejected') {
      return { ...empty, status: 'unavailable', error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
    }
    if (r.value === null) return { ...empty, status: 'not_listed', error: null };
    return { venue, status: 'ok', error: null, ...r.value };
  });
}

type CcxtLike = {
  loadMarkets(): Promise<Record<string, { taker?: number; type?: string; limits?: { leverage?: { max?: number } } }>>;
  fetchTicker(symbol: string): Promise<{ bid?: number; ask?: number }>;
  fetchFundingRate?(symbol: string): Promise<{ fundingRate?: number }>;
  has: Record<string, unknown>;
};

const clients = new Map<string, CcxtLike>();
function client(venue: string): CcxtLike {
  let c = clients.get(venue);
  if (!c) {
    const Ctor = (ccxt as unknown as Record<string, new (opts: object) => CcxtLike>)[venue];
    if (!Ctor) throw new Error(`Börse ${venue} unbekannt`);
    c = new Ctor({ enableRateLimit: true, timeout: 8_000 });
    clients.set(venue, c);
  }
  return c;
}

/** Echter, keyless Abruf über ccxt (öffentliche Endpunkte). */
export async function ccxtVenueQuote(venue: string, symbol: string): Promise<RawVenueQuote | null> {
  const ex = client(venue);
  const target = venueSymbol(venue, symbol);
  const markets = await ex.loadMarkets();
  const m = markets[target.symbol];
  if (!m) return null;
  const t = await ex.fetchTicker(target.symbol);
  let fundingRate: number | null = null;
  if (target.type === 'swap' && ex.has.fetchFundingRate && ex.fetchFundingRate) {
    try {
      fundingRate = (await ex.fetchFundingRate(target.symbol)).fundingRate ?? null;
    } catch {
      fundingRate = null; // Funding fehlt ehrlich, der Kurs bleibt gültig
    }
  }
  return {
    bid: typeof t.bid === 'number' ? t.bid : null,
    ask: typeof t.ask === 'number' ? t.ask : null,
    takerFee: typeof m.taker === 'number' ? m.taker : null,
    fundingRate,
    maxLeverage: typeof m.limits?.leverage?.max === 'number' ? m.limits.leverage.max : null,
    marketType: target.type,
    marketSymbol: target.symbol,
  };
}
