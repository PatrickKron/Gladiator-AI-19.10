/**
 * Impact-Klassifikation für Wirtschaftskalender-Events (09_ §3.7-Erweiterung).
 *
 * REGELBASIERT & DETERMINISTISCH — kein LLM, kein Zufall, kein Fake. Ordnet
 * einem ForexFactory-Event echte, ökonomisch begründete Auswirkungen zu:
 * - welche Kategorie (NFP, CPI, FOMC, EZB …),
 * - welche Märkte typischerweise reagieren (USD-Paare, Gold, S&P 500, DXY …),
 * - wie stark Krypto (BTC/ETH/SOL/UNI) und US-Aktien voraussichtlich reagieren.
 *
 * Der Klassifikator liefert nur STABILE Schlüssel (`category`, `markets`-Tags).
 * Die menschenlesbaren „Was ist das / warum relevant"-Texte liegen als i18n je
 * Kategorie in allen fünf Sprachen — so bleibt die Erklärung übersetzbar und
 * treibt keinen freien Text durch das Backend.
 */

/** Markt-Tags (semantisch, für die i18n-Erklärungschips). */
export type MarketTag =
  | 'all_markets'
  | 'usd_pairs'
  | 'eur_pairs'
  | 'gbp_pairs'
  | 'jpy_pairs'
  | 'gold'
  | 'oil'
  | 'sp500'
  | 'nasdaq'
  | 'dax'
  | 'ftse'
  | 'nikkei'
  | 'dxy'
  | 'us10y'
  | 'bonds'
  | 'crypto';

export type EventCategory =
  | 'fomc'
  | 'fed_speak'
  | 'nfp'
  | 'cpi'
  | 'ppi'
  | 'gdp'
  | 'unemployment'
  | 'jobless_claims'
  | 'retail'
  | 'pmi'
  | 'consumer_sentiment'
  | 'housing'
  | 'trade_balance'
  | 'rate_decision'
  | 'ecb'
  | 'boe'
  | 'boj'
  | 'holiday'
  | 'other';

export type ImpactLevel = 0 | 1 | 2 | 3;

export type EventImpact = {
  category: EventCategory;
  /** Gesamt-Impact 1..3 (aus ForexFactory-Importance; null ⇒ 1). */
  severity: 1 | 2 | 3;
  /** Reichweite: global (Fed) vs. an eine Währung/Region gebunden. */
  scope: 'global' | 'usd' | 'eur' | 'gbp' | 'jpy' | 'regional';
  /** Typischerweise reagierende Märkte (semantische Tags → i18n). */
  markets: MarketTag[];
  /** Wie stark reagiert Krypto (BTC/ETH/SOL/UNI)? 0..3 */
  cryptoRelevance: ImpactLevel;
  /** Wie stark reagieren US-Aktien/Indizes? 0..3 */
  equityRelevance: ImpactLevel;
};

function clampSeverity(importance: number | null | undefined): 1 | 2 | 3 {
  if (importance == null || !Number.isFinite(importance)) return 1;
  if (importance >= 3) return 3;
  if (importance <= 1) return 1;
  return 2;
}

/** Währung → Forex-Paar-Tag (nur Majors; sonst null). */
function pairTag(ccy: string): MarketTag | null {
  switch (ccy) {
    case 'USD':
      return 'usd_pairs';
    case 'EUR':
      return 'eur_pairs';
    case 'GBP':
      return 'gbp_pairs';
    case 'JPY':
      return 'jpy_pairs';
    default:
      return null;
  }
}

/** Währung → Leitindex-Tags (Aktienmarkt der Region). */
function indexTags(ccy: string): MarketTag[] {
  switch (ccy) {
    case 'USD':
      return ['sp500', 'nasdaq'];
    case 'EUR':
      return ['dax'];
    case 'GBP':
      return ['ftse'];
    case 'JPY':
      return ['nikkei'];
    default:
      return [];
  }
}

/** Eindeutige Reihenfolge erhalten, Duplikate/null entfernen. */
function uniqTags(tags: (MarketTag | null)[]): MarketTag[] {
  const out: MarketTag[] = [];
  for (const t of tags) if (t && !out.includes(t)) out.push(t);
  return out;
}

/**
 * Erkennt die Ereignis-Kategorie anhand von Titel-Schlüsselwörtern.
 * Reihenfolge = Priorität (spezifisch vor generisch).
 */
export function detectCategory(title: string): EventCategory {
  const t = title.toLowerCase();

  if (/\bbank holiday\b|\bholiday\b/.test(t)) return 'holiday';

  // Zentralbanken / Zinsen zuerst — höchste Marktwirkung.
  if (/\bfomc\b|federal funds rate|fed interest rate|fed monetary policy|fed press conf/.test(t)) return 'fomc';
  if (/fed chair|\bpowell\b|fomc member|fed .*(speak|testif)|fed governor/.test(t)) return 'fed_speak';
  if (/\becb\b|main refinancing|european central bank|\blagarde\b|ecb press/.test(t)) return 'ecb';
  if (/\bboe\b|official bank rate|bank of england|\bmpc\b|\bbailey\b/.test(t)) return 'boe';
  if (/\bboj\b|bank of japan|\bueda\b/.test(t)) return 'boj';
  if (/interest rate decision|rate statement|cash rate|overnight rate|policy rate|rate decision/.test(t)) return 'rate_decision';

  // Arbeitsmarkt.
  if (/non[-\s]?farm|\bnfp\b|employment change|payrolls/.test(t)) return 'nfp';
  if (/unemployment claims|jobless claims|initial claims|continuing claims/.test(t)) return 'jobless_claims';
  if (/unemployment rate/.test(t)) return 'unemployment';

  // Inflation / Wachstum / Konsum.
  if (/\bcpi\b|consumer price|inflation rate|inflation data/.test(t)) return 'cpi';
  if (/\bppi\b|producer price/.test(t)) return 'ppi';
  if (/\bgdp\b|gross domestic/.test(t)) return 'gdp';
  if (/retail sales/.test(t)) return 'retail';
  if (/\bpmi\b|purchasing managers|ism (manufacturing|services|non-manufacturing)/.test(t)) return 'pmi';
  if (/consumer sentiment|consumer confidence|michigan/.test(t)) return 'consumer_sentiment';
  if (/housing|home sales|building permits|new home|mortgage/.test(t)) return 'housing';
  if (/trade balance|current account/.test(t)) return 'trade_balance';

  return 'other';
}

function lvl(n: number): ImpactLevel {
  if (n <= 0) return 0;
  if (n >= 3) return 3;
  return n as ImpactLevel;
}

/**
 * Ordnet einem Event seine Marktwirkung zu. Rein (keine Seiteneffekte),
 * damit vollständig testbar. `currency` = ForexFactory-Währungscode (== country).
 */
export function classifyEvent(e: { title: string; currency: string | null; importance: number | null }): EventImpact {
  const severity = clampSeverity(e.importance);
  const ccy = (e.currency ?? '').toUpperCase();
  const isUsd = ccy === 'USD';
  const category = detectCategory(e.title);

  const pt = pairTag(ccy);
  const idx = indexTags(ccy);

  switch (category) {
    case 'fomc':
      return {
        category,
        severity,
        scope: 'global',
        markets: uniqTags(['all_markets', 'dxy', 'us10y', 'sp500', 'nasdaq', 'gold', 'crypto']),
        cryptoRelevance: 3,
        equityRelevance: 3,
      };
    case 'fed_speak':
      return {
        category,
        severity,
        scope: 'usd',
        markets: uniqTags(['usd_pairs', 'sp500', 'dxy', 'gold', 'crypto']),
        cryptoRelevance: 2,
        equityRelevance: 2,
      };
    case 'nfp':
      return {
        category,
        severity,
        scope: 'usd',
        markets: uniqTags(['usd_pairs', 'gold', 'sp500', 'dxy', 'us10y', 'crypto']),
        cryptoRelevance: 3,
        equityRelevance: 3,
      };
    case 'cpi':
      return {
        category,
        severity,
        scope: isUsd ? 'usd' : 'regional',
        markets: uniqTags(isUsd ? ['usd_pairs', 'gold', 'us10y', 'sp500', 'dxy', 'crypto'] : [pt, 'gold', 'bonds', ...idx]),
        cryptoRelevance: isUsd ? 3 : lvl(2),
        equityRelevance: isUsd ? 3 : 1,
      };
    case 'ppi':
      return {
        category,
        severity,
        scope: isUsd ? 'usd' : 'regional',
        markets: uniqTags(isUsd ? ['usd_pairs', 'us10y', 'bonds', 'sp500'] : [pt, 'bonds']),
        cryptoRelevance: isUsd ? 2 : 1,
        equityRelevance: isUsd ? 2 : 1,
      };
    case 'gdp':
      return {
        category,
        severity,
        scope: isUsd ? 'usd' : 'regional',
        markets: uniqTags([pt, ...idx, ...(isUsd ? (['crypto'] as MarketTag[]) : [])]),
        cryptoRelevance: isUsd ? 2 : 1,
        equityRelevance: isUsd ? 2 : 1,
      };
    case 'unemployment':
      return {
        category,
        severity,
        scope: isUsd ? 'usd' : 'regional',
        markets: uniqTags([pt, ...idx]),
        cryptoRelevance: isUsd ? 2 : 1,
        equityRelevance: isUsd ? 2 : 1,
      };
    case 'jobless_claims':
      return {
        category,
        severity,
        scope: 'usd',
        markets: uniqTags(['usd_pairs', 'sp500', 'dxy']),
        cryptoRelevance: 2,
        equityRelevance: 2,
      };
    case 'retail':
      return {
        category,
        severity,
        scope: isUsd ? 'usd' : 'regional',
        markets: uniqTags([pt, ...idx, ...(isUsd ? (['crypto'] as MarketTag[]) : [])]),
        cryptoRelevance: isUsd ? 2 : 1,
        equityRelevance: isUsd ? 2 : 1,
      };
    case 'pmi':
      return {
        category,
        severity,
        scope: isUsd ? 'usd' : 'regional',
        markets: uniqTags([pt, ...idx]),
        cryptoRelevance: isUsd ? 2 : 1,
        equityRelevance: isUsd ? 2 : 1,
      };
    case 'consumer_sentiment':
      return {
        category,
        severity,
        scope: isUsd ? 'usd' : 'regional',
        markets: uniqTags([pt, ...idx]),
        cryptoRelevance: 1,
        equityRelevance: isUsd ? 2 : 1,
      };
    case 'housing':
      return {
        category,
        severity,
        scope: isUsd ? 'usd' : 'regional',
        markets: uniqTags([pt, ...idx]),
        cryptoRelevance: 1,
        equityRelevance: 1,
      };
    case 'trade_balance':
      return {
        category,
        severity,
        scope: 'regional',
        markets: uniqTags([pt]),
        cryptoRelevance: 1,
        equityRelevance: 1,
      };
    case 'ecb':
      return {
        category,
        severity,
        scope: 'eur',
        markets: uniqTags(['eur_pairs', 'dax', 'dxy', 'bonds', 'crypto']),
        cryptoRelevance: 2,
        equityRelevance: 1,
      };
    case 'boe':
      return {
        category,
        severity,
        scope: 'gbp',
        markets: uniqTags(['gbp_pairs', 'ftse', 'bonds']),
        cryptoRelevance: 1,
        equityRelevance: 1,
      };
    case 'boj':
      return {
        category,
        severity,
        scope: 'jpy',
        markets: uniqTags(['jpy_pairs', 'nikkei', 'bonds']),
        cryptoRelevance: 1,
        equityRelevance: 1,
      };
    case 'rate_decision':
      return {
        category,
        severity,
        scope: isUsd ? 'usd' : 'regional',
        markets: uniqTags([pt, ...idx, 'bonds', ...(isUsd ? (['crypto'] as MarketTag[]) : [])]),
        cryptoRelevance: isUsd ? 3 : ccy === 'EUR' ? 2 : 1,
        equityRelevance: 1,
      };
    case 'holiday':
      return {
        category,
        severity: 1,
        scope: 'regional',
        markets: [],
        cryptoRelevance: 1,
        equityRelevance: 0,
      };
    case 'other':
    default:
      return {
        category: 'other',
        severity,
        scope: isUsd ? 'usd' : 'regional',
        markets: uniqTags([pt]),
        cryptoRelevance: isUsd ? 2 : 1,
        equityRelevance: isUsd ? 1 : 0,
      };
  }
}
