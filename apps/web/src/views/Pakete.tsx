import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader } from '../components/ui.js';
import { FavStar } from '../components/FavStar.js';
import { getLatest, onTick } from '../lib/prices.js';
import { feedSymbol } from '../lib/pairs.js';
import { setPendingTradeSymbol } from '../lib/trade-symbol.js';
import {
  ASSET_CLASSES,
  assetClassKey,
  categoryKey,
  classFilterKey,
  classStyle,
  filterAssets,
  fmtQuote,
  type ClassFilter,
} from '../lib/discover.js';
import { clearVisibleInterval, setVisibleInterval } from '../lib/visible-interval.js';

/**
 * „Entdecken" (Trading-Universum, 09_ §3.3) — Komplett-Redesign 2026-07-09.
 * Patricks Kritik an der alten Ansicht: „unübersichtlich, zu klein, unklar
 * beschriftet" → deshalb:
 *  - GROSSE Asset-Zeilen (Ticker groß, voller Name, farbige Klassen-Badge,
 *    Kurs groß, Änderung farbig) statt Mini-Text in Mini-Karten,
 *  - Suchfeld über alle 221 Assets + Klassen-Filter-Chips + Nur-Favoriten,
 *  - „★ Meine Auswahl": Patricks Favoriten als eigener, immer oben
 *    angepinnter Block — seine individuelle Zusammenstellung,
 *  - Pakete bleiben als Gruppierung, aber nach Kategorie geordnet mit
 *    deutschen Labels statt roher DB-Strings (CASHFLOW_INCOME → „Cashflow…").
 * Alle Kurse echt: Krypto per Live-Feed (SSE) + Binance, andere Klassen per
 * TradingView/CBOE über market.assetQuotes — ohne Quelle steht ehrlich
 * „kein Live-Kurs".
 */

type Pkg = Awaited<ReturnType<typeof trpc.product.packages.query>>[number];
type CatalogAsset = Awaited<ReturnType<typeof trpc.product.allAssets.query>>[number];
type PkgAsset = Awaited<ReturnType<typeof trpc.product.assets.query>>[number];

type Quote = { price: number; changePct: number | null; currency: string | null } | null;
type LiveTick = { price: number; changePct: number | null };
type RowAsset = { id: number; ticker: string; name: string; assetType: string; pair: string | null };

/**
 * „Traden"-Sprung (gleiche Konvention wie im Heute-Bereich, geteilter Helfer
 * lib/trade-symbol.ts): Symbol für das Demo-Ticket in der Session vormerken,
 * zum Demo-Konto (#/demo) springen. Das Ticket konsumiert
 * die Vorbelegung genau einmal — Ende-zu-Ende im Browser verifiziert.
 * Die Sicherheit hängt NICHT daran: der Demo-Pfad ist serverseitig ein
 * eigener Router auf eigene Tabellen.
 */
function startDemoTrade(pair: string): void {
  setPendingTradeSymbol(pair);
  window.location.hash = '#/traden?tab=demo';
}

/**
 * EINE große Asset-Zeile — überall dieselbe (Suche, „Meine Auswahl", Pakete),
 * damit Patrick nie zwei Darstellungen desselben Instruments lernen muss.
 */
function AssetRow({
  a,
  isFavorite,
  quote,
  quotesReady,
  live,
  onFavToggled,
}: {
  a: RowAsset;
  isFavorite: boolean;
  /** REST-Quote (alle Klassen) — undefined solange die Sammelabfrage noch läuft. */
  quote: Quote | undefined;
  quotesReady: boolean;
  /** Echtzeit-Tick (nur Krypto, SSE) — übersteuert den REST-Quote. */
  live: LiveTick | undefined;
  onFavToggled: (assetId: number, fav: boolean) => void;
}) {
  const { t } = useTranslation();
  const badge = classStyle(a.assetType);
  const classKey = assetClassKey(a.assetType);
  const price = live?.price ?? quote?.price;
  // Live-Ticks sind Binance-USDT-Paare → $-Anzeige; sonst echte Quell-Währung des Quotes
  const currency = live !== undefined ? 'USD' : (quote?.currency ?? null);
  const changePct = live?.changePct ?? quote?.changePct ?? null;
  const pair = a.pair;
  const canTrade = a.assetType.toUpperCase() === 'CRYPTO' && pair !== null;

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t py-3.5 first:border-t-0" style={{ borderColor: 'rgba(99,140,255,0.12)' }}>
      <FavStar assetId={a.id} isFavorite={isFavorite} onToggled={onFavToggled} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="num text-lg leading-tight font-semibold">{a.ticker}</span>
          <span className="rounded-full border px-2 py-0.5 text-[11px] font-medium" style={badge}>
            {classKey ? t(classKey) : a.assetType}
          </span>
        </p>
        <p className="mt-0.5 truncate text-sm" style={{ color: 'var(--color-mut)' }}>
          {a.name}
        </p>
      </div>
      <div className="shrink-0 text-right">
        {price !== undefined ? (
          <>
            <p className="num text-lg leading-tight font-semibold sm:text-xl">{fmtQuote(price, currency)}</p>
            <p
              className="num mt-0.5 text-sm"
              style={{ color: changePct === null ? 'var(--color-mut)' : changePct >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}
            >
              {changePct === null ? '—' : `${changePct >= 0 ? '▲' : '▼'} ${Math.abs(changePct).toFixed(2)} %`}
            </p>
          </>
        ) : quotesReady ? (
          <p className="text-sm" style={{ color: 'var(--color-mut)' }}>
            {t('packages.noPrice')}
          </p>
        ) : (
          <p className="num animate-pulse text-lg" style={{ color: 'var(--color-mut)' }}>
            …
          </p>
        )}
      </div>
      {canTrade && pair !== null ? (
        <button onClick={() => startDemoTrade(pair)} title={t('discover.tradeHint')} className="btn-primary shrink-0 px-3.5 py-1.5 text-xs">
          {t('discover.trade')}
        </button>
      ) : (
        // disabled-Buttons feuern keine Hover-Events → ehrlicher Tooltip auf dem Wrapper
        <span title={t('discover.tradeUnavailable')} className="shrink-0 cursor-not-allowed">
          <button
            disabled
            className="pointer-events-none rounded-[0.625rem] border px-3.5 py-1.5 text-xs opacity-45"
            style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
          >
            {t('discover.trade')}
          </button>
        </span>
      )}
    </li>
  );
}

/** Filter-Chip der oberen Leiste (Klassen + Favoriten) — groß genug zum Treffen (Mobile). */
function Chip({ active, gold = false, onClick, children }: { active: boolean; gold?: boolean; onClick: () => void; children: React.ReactNode }) {
  const activeStyle = gold
    ? { borderColor: 'rgba(232,184,75,0.55)', color: 'var(--color-warn)', background: 'rgba(232,184,75,0.10)' }
    : { borderColor: 'rgba(79,209,255,0.55)', color: 'var(--color-cyan)', background: 'rgba(79,209,255,0.10)' };
  return (
    <button
      onClick={onClick}
      className="rounded-full border px-3 py-1.5 text-xs font-medium transition-colors"
      style={active ? activeStyle : { borderColor: 'var(--color-line)', color: 'var(--color-mut)', background: 'transparent' }}
    >
      {children}
    </button>
  );
}

/**
 * Paket als aufklappbare Zeile in voller Breite (statt Mini-Karte im Grid):
 * Name groß, Unterkategorie als Label, Instrument-Anzahl als Badge — beim
 * Aufklappen dieselben großen Asset-Zeilen wie überall.
 */
function PackageCard({
  pkg,
  stagger,
  quotes,
  quotesReady,
  live,
  favIds,
  catalogReady,
  onFavToggled,
}: {
  pkg: Pkg;
  stagger: number;
  quotes: Record<string, Quote> | null;
  quotesReady: boolean;
  live: Map<string, LiveTick>;
  favIds: Set<number>;
  catalogReady: boolean;
  onFavToggled: (assetId: number, fav: boolean) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<PkgAsset[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && assets === null) {
      try {
        setAssets(await trpc.product.assets.query({ packageId: pkg.id }));
      } catch {
        setLoadError(true);
        setAssets([]); // ehrlicher Fehlerhinweis statt ewigem Laden
      }
    }
  }

  const catKey = categoryKey(pkg.category);

  return (
    <div
      className="glass glass-hover reveal"
      style={{ '--stagger': Math.min(stagger, 10), borderLeft: pkg.color ? `3px solid ${pkg.color}` : undefined } as React.CSSProperties}
    >
      <button onClick={() => void toggle()} className="flex w-full cursor-pointer items-center gap-3 p-5 text-left">
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-base font-semibold sm:text-lg">{pkg.name}</h4>
          {/* Unterkategorie ist ein sprechender Eigenname (z. B. „US Tech"); fehlt sie, steht das deutsche Kategorie-Label */}
          <p className="label mt-1">{pkg.subcategory ?? (catKey ? t(catKey) : pkg.category)}</p>
          {pkg.description && (
            <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>
              {pkg.description}
            </p>
          )}
        </div>
        <span className="num shrink-0 rounded-full border px-2.5 py-1 text-xs" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
          {t('discover.assetCount', { n: pkg.assetCount })}
        </span>
        <span className="shrink-0 text-lg leading-none" style={{ color: 'var(--color-cyan)' }} aria-hidden>
          {open ? '−' : '+'}
        </span>
      </button>
      {open && (
        <div className="border-t px-5 pb-2" style={{ borderColor: 'var(--color-line)' }}>
          {assets === null ? (
            <Loading />
          ) : loadError ? (
            <Empty text={t('common.error')} />
          ) : assets.length === 0 ? (
            <Empty text={t('common.empty')} />
          ) : (
            <ul>
              {assets.map((a) => {
                const pair = feedSymbol(a.tradingPair);
                return (
                  <AssetRow
                    key={a.id}
                    a={{ id: a.id, ticker: a.ticker, name: a.name, assetType: a.assetType, pair }}
                    // Favoriten-Wahrheit ist der globale Katalog (eine Quelle); solange er lädt, gilt der Server-Wert der Paket-Abfrage
                    isFavorite={catalogReady ? favIds.has(a.id) : a.isFavorite}
                    quote={quotes?.[a.ticker]}
                    quotesReady={quotesReady}
                    live={pair !== null ? live.get(pair) : undefined}
                    onFavToggled={onFavToggled}
                  />
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function Pakete() {
  const { t } = useTranslation();
  const [pkgs, setPkgs] = useState<Pkg[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogAsset[] | null>(null);
  const [quotes, setQuotes] = useState<Record<string, Quote> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Map<string, LiveTick>>(
    () => new Map(getLatest().map((x) => [x.symbol, { price: x.price, changePct: x.changePct24h }])),
  );
  const [query, setQuery] = useState('');
  const [klass, setKlass] = useState<ClassFilter>('all');
  const [onlyFavs, setOnlyFavs] = useState(false);

  // Grunddaten: Pakete + ALLE 221 Assets (eine Quelle für Suche, Favoriten und „Meine Auswahl")
  useEffect(() => {
    trpc.product.packages
      .query()
      .then(setPkgs)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t('common.error')));
    trpc.product.allAssets
      .query()
      .then(setCatalog)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t('common.error')));
    // Krypto-Echtzeit: Live-Feed übersteuert REST-Quotes (Preis UND 24h-Änderung)
    return onTick((x) => setLive((prev) => new Map(prev).set(x.symbol, { price: x.price, changePct: x.changePct24h })));
  }, []);

  // Kurse für ALLE Assets in EINEM Call (Server bündelt Binance/TradingView/CBOE).
  // Abhängigkeit bewusst `catalog === null`: Favoriten-Toggles erzeugen neue
  // Katalog-Referenzen, sollen aber KEINE neue Kurs-Abfrage auslösen.
  const catalogLoaded = catalog !== null;
  useEffect(() => {
    if (catalog === null || catalog.length === 0) return;
    let cancelled = false;
    const ids = catalog.map((a) => a.id);
    const load = () => {
      trpc.market.assetQuotes
        .query({ assetIds: ids })
        .then((q) => {
          if (!cancelled) setQuotes(q);
        })
        .catch(() => {
          // Quelle nicht erreichbar → ehrlich „kein Live-Kurs" statt ewigem Lade-Puls
          if (!cancelled) setQuotes((prev) => prev ?? {});
        });
    };
    load();
    const timer = setVisibleInterval(load, 120_000); // Nicht-Krypto-Quotes frisch halten (Server-Cache 60 s)
    return () => {
      cancelled = true;
      clearVisibleInterval(timer);
    };
  }, [catalogLoaded]);

  /** Ein Stern-Klick aktualisiert NUR den globalen Katalog — daraus leitet sich alles ab. */
  const onFavToggled = (assetId: number, fav: boolean) =>
    setCatalog((prev) => (prev === null ? prev : prev.map((a) => (a.id === assetId ? { ...a, isFavorite: fav } : a))));

  const favorites = useMemo(() => (catalog ?? []).filter((a) => a.isFavorite), [catalog]);
  const favIds = useMemo(() => new Set(favorites.map((a) => a.id)), [favorites]);

  // Filter aktiv? → flache Trefferliste statt Paket-Gruppen (Suche geht über ALLE 221 Assets)
  const filtering = query.trim() !== '' || klass !== 'all' || onlyFavs;
  const results = useMemo(
    () => filterAssets(catalog ?? [], { query, klass, onlyFavorites: onlyFavs }),
    [catalog, query, klass, onlyFavs],
  );

  // Pakete nach Kategorie gruppiert (Server liefert bereits Kategorie·Name-sortiert)
  const groups = useMemo(() => {
    const map = new Map<string, Pkg[]>();
    for (const p of pkgs ?? []) {
      const arr = map.get(p.category) ?? [];
      arr.push(p);
      map.set(p.category, arr);
    }
    return [...map.entries()];
  }, [pkgs]);

  const totalAssets = useMemo(() => (pkgs ?? []).reduce((a, p) => a + p.assetCount, 0), [pkgs]);
  const quotesReady = quotes !== null;

  const rowFor = (a: CatalogAsset): RowAsset => ({ id: a.id, ticker: a.ticker, name: a.name, assetType: a.assetType, pair: a.symbol });

  return (
    <div>
      <PageHeader
        title={t('discover.title')}
        subtitle={t('discover.subtitle', { packages: pkgs?.length ?? '…', assets: totalAssets || '…' })}
      />
      {error && <ErrorBox message={error} />}
      <p className="mb-5 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('packages.livePrice')}
      </p>

      {/* Obere Leiste: großes Suchfeld + Klassen-Chips + Nur-Favoriten */}
      <div className="glass reveal mb-6 p-4 sm:p-5" style={{ '--stagger': 1 } as React.CSSProperties}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('discover.searchPlaceholder')}
          className="field w-full px-4 py-3 text-base"
          style={{ color: 'var(--color-ink)' }}
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Chip active={klass === 'all' && !onlyFavs} onClick={() => { setKlass('all'); setOnlyFavs(false); }}>
            {t('common.all')}
          </Chip>
          {ASSET_CLASSES.map((c) => (
            <Chip key={c} active={klass === c} onClick={() => setKlass((prev) => (prev === c ? 'all' : c))}>
              {t(classFilterKey(c))}
            </Chip>
          ))}
          <Chip active={onlyFavs} gold onClick={() => setOnlyFavs((v) => !v)}>
            {onlyFavs ? '★' : '☆'} {t('packages.onlyFavorites')}
          </Chip>
        </div>
      </div>

      {filtering ? (
        /* Flache Trefferliste: große Zeilen über das GESAMTE Universum */
        <section className="glass reveal p-4 sm:p-6" style={{ '--stagger': 2 } as React.CSSProperties}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">{t('discover.resultsTitle')}</h2>
            <span className="label">{t('discover.resultCount', { n: results.length })}</span>
          </div>
          {catalog === null ? (
            <Loading />
          ) : results.length === 0 ? (
            <Empty text={onlyFavs && query.trim() === '' ? t('discover.myEmpty') : t('discover.noResults')} />
          ) : (
            <ul className="mt-2">
              {results.map((a) => (
                <AssetRow
                  key={a.id}
                  a={rowFor(a)}
                  isFavorite={a.isFavorite}
                  quote={quotes?.[a.ticker]}
                  quotesReady={quotesReady}
                  live={a.symbol !== null ? live.get(a.symbol) : undefined}
                  onFavToggled={onFavToggled}
                />
              ))}
            </ul>
          )}
        </section>
      ) : (
        <>
          {/* „★ Meine Auswahl": Patricks individuelle Zusammenstellung — IMMER oben angepinnt */}
          <section
            className="glass reveal mb-8 p-4 sm:p-6"
            style={{ '--stagger': 2, borderColor: 'rgba(232,184,75,0.4)' } as React.CSSProperties}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <span style={{ color: 'var(--color-warn)' }}>★</span> {t('discover.myTitle')}
              </h2>
              <span className="label">{t('discover.resultCount', { n: favorites.length })}</span>
            </div>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
              {t('discover.myHint')}
            </p>
            {catalog === null ? (
              <Loading />
            ) : favorites.length === 0 ? (
              <Empty text={t('discover.myEmpty')} />
            ) : (
              <ul className="mt-2">
                {favorites.map((a) => (
                  <AssetRow
                    key={a.id}
                    a={rowFor(a)}
                    isFavorite
                    quote={quotes?.[a.ticker]}
                    quotesReady={quotesReady}
                    live={a.symbol !== null ? live.get(a.symbol) : undefined}
                    onFavToggled={onFavToggled}
                  />
                ))}
              </ul>
            )}
          </section>

          {/* Kuratierte Pakete, nach Kategorie gruppiert — deutsche Labels statt DB-Strings */}
          {pkgs === null ? (
            <div className="glass p-6">
              <Loading />
            </div>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">{t('discover.packagesTitle')}</h2>
                <span className="label">{t('discover.packageCount', { n: pkgs.length })}</span>
              </div>
              {groups.map(([cat, list], gi) => {
                const catKey = categoryKey(cat);
                return (
                  <section key={cat} className="mb-8">
                    <h3 className="reveal mb-3 flex flex-wrap items-baseline gap-x-3" style={{ '--stagger': Math.min(3 + gi, 10) } as React.CSSProperties}>
                      <span className="text-base font-semibold">{catKey ? t(catKey) : cat}</span>
                      <span className="label">{t('discover.packageCount', { n: list.length })}</span>
                    </h3>
                    <div className="space-y-3">
                      {list.map((p, i) => (
                        <PackageCard
                          key={p.id}
                          pkg={p}
                          stagger={Math.min(3 + gi + i, 10)}
                          quotes={quotes}
                          quotesReady={quotesReady}
                          live={live}
                          favIds={favIds}
                          catalogReady={catalog !== null}
                          onFavToggled={onFavToggled}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </>
          )}
        </>
      )}
    </div>
  );
}
