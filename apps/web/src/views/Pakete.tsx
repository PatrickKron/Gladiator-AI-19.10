import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { ErrorBox, Loading, PageHeader } from '../components/ui.js';
import { FavStar } from '../components/FavStar.js';
import { getLatest, onTick } from '../lib/prices.js';
import { feedSymbol } from '../lib/pairs.js';

/**
 * Pakete / Trading-Universum (09_ §3.3): echte v1-Bestände (35 Pakete,
 * 221 Assets). Live-Kurse für ALLE Klassen: Krypto per Binance-Feed/REST,
 * Aktien/ETF/Index/Future/Rohstoff per TradingView-Scanner, VVIX/GVZ per
 * CBOE — Assets ohne funktionierende Quelle ehrlich „kein Kurs".
 */

type Pkg = Awaited<ReturnType<typeof trpc.product.packages.query>>[number];
type Asset = Awaited<ReturnType<typeof trpc.product.assets.query>>[number];

type Quote = { price: number; changePct: number | null; currency: string | null } | null;

/**
 * Kursanzeige mit echter Quell-Währung (Auslandsbörsen: EUR/JPY/HKD/…, USX =
 * US-Cent). currency=null (Renditen/Indizes ohne Währung) → bewusst ohne Suffix.
 */
function fmtQuote(price: number, currency: string | null): string {
  const num = price.toLocaleString(undefined, { maximumFractionDigits: price >= 1000 ? 0 : price >= 1 ? 2 : 6 });
  if (currency === null) return num;
  const cur = currency.toUpperCase();
  if (cur === 'USD' || cur === 'USDT') return `${num} $`;
  if (cur === 'EUR') return `${num} €`;
  if (cur === 'JPY') return `${num} ¥`;
  if (cur === 'GBP') return `${num} £`;
  return `${num} ${cur}`;
}

function PackageCard({ pkg, stagger, prices }: { pkg: Pkg; stagger: number; prices: Map<string, number> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && assets === null) {
      try {
        const loaded = await trpc.product.assets.query({ packageId: pkg.id });
        setAssets(loaded);
        // Quotes für ALLE Assets des Pakets (jede Klasse; Server bündelt die Quellen)
        const q = await trpc.market.assetQuotes.query({ packageId: pkg.id });
        setQuotes(q as Record<string, Quote>);
      } catch {
        setAssets((prev) => prev ?? []);
      }
    }
  }

  return (
    <div
      className="glass glass-hover reveal p-5"
      style={{ '--stagger': Math.min(stagger, 10), borderTop: pkg.color ? `2px solid ${pkg.color}` : undefined } as React.CSSProperties}
    >
      <button onClick={() => void toggle()} className="flex w-full cursor-pointer items-start justify-between gap-3 text-left">
        <div>
          <p className="label">{pkg.category}{pkg.subcategory ? ` · ${pkg.subcategory}` : ''}</p>
          <h2 className="mt-1 text-[15px] font-medium">
            {pkg.icon ? `${pkg.icon} ` : ''}
            {pkg.name}
          </h2>
        </div>
        <span className="num flex shrink-0 items-center gap-1.5 rounded border px-1.5 py-0.5 text-xs" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
          {pkg.assetCount} {t('packages.assets')} {open ? '\u2212' : '+'}
        </span>
      </button>
      {pkg.description && (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
          {pkg.description}
        </p>
      )}
      <button onClick={() => void toggle()} className="mt-3 text-xs" style={{ color: 'var(--color-cyan)' }}>
        {open ? `− ${t('packages.hide')}` : `+ ${t('packages.show')}`}
      </button>
      {open && (
        <div className="mt-3 max-h-56 overflow-y-auto rounded border p-2" style={{ borderColor: 'var(--color-line)' }}>
          {assets === null ? (
            <Loading />
          ) : (
            <ul className="space-y-1 text-xs">
              {assets.map((a) => {
                // Krypto: Echtzeit-Tick vom Live-Feed übersteuert den REST-Quote
                const feedKey = feedSymbol(a.tradingPair);
                const liveTick = feedKey ? prices.get(feedKey) : undefined;
                const quote = quotes[a.ticker];
                const price = liveTick ?? quote?.price;
                const currency = liveTick !== undefined ? 'USD' : (quote?.currency ?? null);
                const changePct = quote?.changePct ?? null;
                return (
                  <li key={a.id} className="flex items-center justify-between gap-2 py-0.5">
                    <span className="flex items-center gap-1">
                      <FavStar assetId={a.id} isFavorite={a.isFavorite} onToggled={(assetId, fav) => setAssets((prev) => (prev ?? []).map((x) => (x.id === assetId ? { ...x, isFavorite: fav } : x)))} />
                      <span className="num font-medium">{a.ticker}</span>{' '}
                      <span style={{ color: 'var(--color-mut)' }}>{a.name}</span>
                    </span>
                    <span className="num shrink-0" style={{ color: price !== undefined ? 'var(--color-cyan)' : 'var(--color-mut)' }}>
                      {price !== undefined && price !== null ? fmtQuote(price, currency) : t('packages.noPrice')}
                      {changePct !== null && (
                        <span className="ml-1.5 text-[11px]" style={{ color: changePct >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                          {changePct >= 0 ? '+' : ''}{changePct.toFixed(1)} %
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

type SortBy = 'default' | 'name' | 'assets';

export function Pakete() {
  const { t } = useTranslation();
  const [pkgs, setPkgs] = useState<Pkg[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prices, setPrices] = useState<Map<string, number>>(new Map(getLatest().map((x) => [x.symbol, x.price])));
  // Feature E: Paketnamen mit mindestens einem favorisierten Asset (Set) + Filter/Sortierung.
  const [favPackages, setFavPackages] = useState<Set<string>>(new Set());
  const [onlyFavs, setOnlyFavs] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>('default');

  useEffect(() => {
    trpc.product.packages
      .query()
      .then(setPkgs)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t('common.error')));
    // Favoriten laden → welche Pakete enthalten mindestens einen Stern-Favoriten?
    void trpc.product.favorites
      .query()
      .then((favs) => setFavPackages(new Set(favs.map((f) => f.packageName))))
      .catch(() => setFavPackages(new Set()));
    return onTick((x) => setPrices((prev) => new Map(prev).set(x.symbol, x.price)));
  }, []);

  const totalAssets = useMemo(() => (pkgs ?? []).reduce((a, p) => a + p.assetCount, 0), [pkgs]);

  /** Sichtbare Pakete: optional auf Favoriten-Pakete gefiltert, dann sortiert. */
  const visiblePkgs = useMemo(() => {
    let list = pkgs ?? [];
    if (onlyFavs) list = list.filter((p) => favPackages.has(p.name));
    const sorted = [...list];
    if (sortBy === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === 'assets') sorted.sort((a, b) => b.assetCount - a.assetCount);
    return sorted; // 'default' = Server-Reihenfolge (Kategorie · Name)
  }, [pkgs, onlyFavs, favPackages, sortBy]);

  return (
    <div>
      <PageHeader
        title={t('packages.title')}
        subtitle={t('packages.subtitle', { packages: pkgs?.length ?? '…', assets: totalAssets || '…' })}
      />
      {error && <ErrorBox message={error} />}
      <p className="mb-2 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('packages.livePrice')}
      </p>
      <p className="mb-5 text-xs leading-relaxed" style={{ color: 'var(--color-warn)' }}>
        {t('packages.favInfo')}
      </p>

      {/* Feature E: Nur-Favoriten-Filter + Sortierung */}
      {pkgs !== null && (
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <button
            onClick={() => setOnlyFavs((v) => !v)}
            className="rounded border px-3 py-1.5 text-xs transition-colors"
            style={{
              borderColor: onlyFavs ? 'rgba(232,184,75,0.5)' : 'var(--color-line)',
              color: onlyFavs ? 'var(--color-warn)' : 'var(--color-mut)',
              background: onlyFavs ? 'rgba(232,184,75,0.08)' : 'transparent',
            }}
          >
            {onlyFavs ? '★' : '☆'} {t('packages.onlyFavorites')}
          </button>
          <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-mut)' }}>
            {t('packages.sortBy')}
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
              className="field px-2 py-1 text-xs"
            >
              <option value="default">{t('packages.sortDefault')}</option>
              <option value="name">{t('packages.sortName')}</option>
              <option value="assets">{t('packages.sortAssets')}</option>
            </select>
          </label>
          <span className="label">{t('packages.shownCount', { shown: visiblePkgs.length, total: pkgs.length })}</span>
        </div>
      )}

      {pkgs === null ? (
        <div className="glass p-6">
          <Loading />
        </div>
      ) : visiblePkgs.length === 0 ? (
        <div className="glass p-6 text-sm" style={{ color: 'var(--color-mut)' }}>
          {t('packages.noneFavorites')}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visiblePkgs.map((p, i) => (
            <PackageCard key={p.id} pkg={p} stagger={i + 1} prices={prices} />
          ))}
        </div>
      )}
    </div>
  );
}
