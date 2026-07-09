import { rankAssets, type SearchableAsset } from './asset-search.js';

/**
 * „Entdecken"-Logik (Redesign 2026-07-09 nach Patrick-Feedback: „unübersichtlich,
 * zu klein, unklar beschriftet"). Pure Helfer, bewusst OHNE React/DOM:
 * Suche, Klassen-Filter und Label-Mapping sind so ohne Browser testbar,
 * und die View (Pakete.tsx) bleibt reine Darstellung.
 */

/** Asset-Klassen, wie sie ECHT in der DB stehen (221 Assets, live verifiziert 2026-07-09). */
export const ASSET_CLASSES = ['CRYPTO', 'STOCK', 'ETF', 'INDEX', 'FUTURE', 'COMMODITY'] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];
export type ClassFilter = 'all' | AssetClass;

/**
 * i18n-Key der Klassen-Badge (Singular: „Krypto/Aktie/…"). Unbekannte Typen →
 * null: die View zeigt dann ehrlich den DB-Rohwert statt einer geratenen Übersetzung.
 */
export function assetClassKey(assetType: string): string | null {
  const upper = assetType.toUpperCase();
  return (ASSET_CLASSES as readonly string[]).includes(upper) ? `discover.class_${upper.toLowerCase()}` : null;
}

/** i18n-Key der Filter-Chips (Plural: „Aktien/Indizes/…"). */
export function classFilterKey(klass: AssetClass): string {
  return `discover.filter_${klass.toLowerCase()}`;
}

export type BadgeStyle = { color: string; borderColor: string; background: string };

/**
 * Badge-Farbwelt je Klasse (Neon-Dual-Palette aus styles.css): Textfarbe als
 * CSS-Variable, Rand/Fläche als abgestimmte rgba derselben Farbe — so bleibt
 * die Badge lesbar UND farblich eindeutig einer Klasse zuordenbar.
 */
const CLASS_STYLE: Record<string, BadgeStyle> = {
  CRYPTO: { color: 'var(--color-cyan)', borderColor: 'rgba(79,209,255,0.45)', background: 'rgba(79,209,255,0.08)' },
  STOCK: { color: 'var(--color-violet)', borderColor: 'rgba(139,92,246,0.5)', background: 'rgba(139,92,246,0.10)' },
  ETF: { color: 'var(--color-warn)', borderColor: 'rgba(232,184,75,0.45)', background: 'rgba(232,184,75,0.08)' },
  INDEX: { color: 'var(--color-blue)', borderColor: 'rgba(46,124,246,0.55)', background: 'rgba(46,124,246,0.10)' },
  FUTURE: { color: 'var(--color-magenta)', borderColor: 'rgba(225,78,207,0.45)', background: 'rgba(225,78,207,0.08)' },
  COMMODITY: { color: 'var(--color-pos)', borderColor: 'rgba(61,220,151,0.45)', background: 'rgba(61,220,151,0.08)' },
};

export function classStyle(assetType: string): BadgeStyle {
  return (
    CLASS_STYLE[assetType.toUpperCase()] ?? {
      color: 'var(--color-mut)',
      borderColor: 'var(--color-line)',
      background: 'transparent',
    }
  );
}

/**
 * Paket-Kategorie (roher DB-String wie CASHFLOW_INCOME) → i18n-Key.
 * Deckt die 11 echten Kategorien des v1-Bestands ab (Seed + Live-API
 * verifiziert); unbekannte Kategorien → null, die View zeigt dann den
 * Rohwert — ehrlich statt falsch übersetzt.
 */
const CATEGORY_KEYS: Record<string, string> = {
  MARKET_ENGINE: 'discover.cat_market_engine',
  EQUITY_CORE: 'discover.cat_equity_core',
  GROWTH_DISRUPTION: 'discover.cat_growth_disruption',
  CASHFLOW_INCOME: 'discover.cat_cashflow_income',
  GLOBAL_MARKETS: 'discover.cat_global_markets',
  HARD_ASSETS: 'discover.cat_hard_assets',
  FIXED_INCOME: 'discover.cat_fixed_income',
  DIGITAL_ASSETS: 'discover.cat_digital_assets',
  SENTIMENT_HEDGE: 'discover.cat_sentiment_hedge',
  LUXURY_NICHES: 'discover.cat_luxury_niches',
  FUTURE_FRONTIERS: 'discover.cat_future_frontiers',
};

export function categoryKey(category: string): string | null {
  return CATEGORY_KEYS[category.toUpperCase()] ?? null;
}

export type DiscoverFilter = { query: string; klass: ClassFilter; onlyFavorites: boolean };
export type FilterableAsset = SearchableAsset & { assetType: string; isFavorite: boolean };

/**
 * EINE Filter-Wahrheit für die flache Trefferliste: erst Klasse, dann
 * Favoriten, dann Suche. Die Suche nutzt rankAssets (Command-Palette)
 * wieder — bewusst keine zweite Such-Logik im Projekt.
 */
export function filterAssets<T extends FilterableAsset>(assets: T[], f: DiscoverFilter, limit = 250): T[] {
  let list = assets;
  if (f.klass !== 'all') list = list.filter((a) => a.assetType.toUpperCase() === f.klass);
  if (f.onlyFavorites) list = list.filter((a) => a.isFavorite);
  return rankAssets(list, f.query, limit);
}

/**
 * Kursanzeige mit echter Quell-Währung (aus der alten Pakete-Ansicht
 * übernommen, jetzt zentral + getestet): Auslandsbörsen liefern EUR/JPY/HKD/…,
 * USX = US-Cent; currency=null (Renditen/Indizes ohne Währung) → bewusst ohne
 * Suffix — kein erfundenes Dollarzeichen.
 */
export function fmtQuote(price: number, currency: string | null): string {
  const num = price.toLocaleString(undefined, { maximumFractionDigits: price >= 1000 ? 0 : price >= 1 ? 2 : 6 });
  if (currency === null) return num;
  const cur = currency.toUpperCase();
  if (cur === 'USD' || cur === 'USDT') return `${num} $`;
  if (cur === 'EUR') return `${num} €`;
  if (cur === 'JPY') return `${num} ¥`;
  if (cur === 'GBP') return `${num} £`;
  return `${num} ${cur}`;
}
