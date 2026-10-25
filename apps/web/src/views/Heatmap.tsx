import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { EmptyState, ErrorBox, Loading, NotConnected, PageHeader, TabBar } from '../components/ui.js';
import { ASSET_CLASSES, classFilterKey, fmtQuote, type AssetClass } from '../lib/discover.js';
import {
  CORR_NEG,
  CORR_POS,
  HEAT_MAX_ABS,
  HEAT_NEG,
  HEAT_POS,
  NO_DATA_COLOR,
  NO_PACKAGE,
  TILE_TEXT,
  buildHeatmapGroups,
  changeColor,
  chartTargetFor,
  corrColor,
  legendGradient,
  matrixLabels,
  meanChange,
  sanitizeSelection,
  shortSymbol,
  sizingVolumes,
  squarify,
  strongestPairs,
  tileFontPx,
  tileLabelMode,
  tileWeights,
  treemapHeight,
  type HeatFilter,
  type HeatGroup,
  type HeatLive,
  type HeatTile,
  type SymbolRef,
} from '../lib/heatmap.js';
import { appLocale } from '../lib/locale.js';
import { ensurePriceStream, getLatest, onTick } from '../lib/prices.js';
import { useHashTab } from '../lib/use-hash-tab.js';
import { clearVisibleInterval, setVisibleInterval } from '../lib/visible-interval.js';

/**
 * Heatmap (Markt › Heatmap) — Patrick 2026-10-25: „Heatmaps und so weiter sollen benutzbar
 * sein — die Übersicht." Zwei Tabs, nur echte Daten ohne neue API-Keys:
 *  - Performance: Treemap aller Katalog-Assets je Klasse oder Paket, Farbe = Änderung 24 h /
 *    Handelstag (market.assetQuotes: Binance, TradingView-Scanner, CBOE), Krypto live über den
 *    SSE-Kurs-Stream, Größe nur aus echtem 24h-Volumen (Binance), sonst gleich groß.
 *  - Korrelation: Matrix der Tagesrenditen aus 1d-Kerzen der DB (market.correlation), paarweise
 *    vollständig ausgerichtet; zu wenig gemeinsame Daten → keine Zahl.
 * Rechnen/Gruppieren/Färben liegt rein und getestet in lib/heatmap.ts.
 */

const TABS = ['performance', 'korrelation'] as const;
type Tab = (typeof TABS)[number];

type Universe = Awaited<ReturnType<typeof trpc.market.heatmapUniverse.query>>;
type CatalogAsset = Awaited<ReturnType<typeof trpc.product.allAssets.query>>[number];
type Quotes = Awaited<ReturnType<typeof trpc.market.assetQuotes.query>>;
type Correlation = Awaited<ReturnType<typeof trpc.market.correlation.query>>;
type Days = 30 | 90 | 180;

const DAYS: Days[] = [30, 90, 180];
const SEL_KEY = 'gladiator.heatmap.corrSymbols';
const DAYS_KEY = 'gladiator.heatmap.corrDays';

function fmtPct(p: number): string {
  const sign = p > 0 ? '+' : p < 0 ? '−' : '±';
  return `${sign}${Math.abs(p).toLocaleString(appLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(appLocale(), { dateStyle: 'short', timeStyle: 'medium' });
}

function fmtDate(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return key;
  return d.toLocaleDateString(appLocale(), { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
}

function fmtR(r: number): string {
  return r.toLocaleString(appLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Privater Modus / gesperrter Speicher: Auswahl gilt dann nur für diese Sitzung.
  }
}

function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** Auswahl-Pille (Filter, Fenster, Gruppierung) — groß genug zum Treffen auf dem Handy. */
function Pill({ active, onClick, children, gold = false, title }: { active: boolean; onClick?: () => void; children: ReactNode; gold?: boolean; title?: string }) {
  const on = gold
    ? { borderColor: 'rgba(232,184,75,0.55)', color: 'var(--color-warn)', background: 'rgba(232,184,75,0.10)' }
    : { borderColor: 'rgba(79,209,255,0.5)', color: 'var(--color-cyan)', background: 'rgba(61,134,247,0.12)' };
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className="rounded-full border px-3 py-1.5 text-xs font-medium transition-colors"
      style={active ? on : { borderColor: 'var(--color-line)', color: 'var(--color-mut)', background: 'transparent' }}
    >
      {children}
    </button>
  );
}

/** Legende einer divergierenden Skala mit Beschriftung links/Mitte/rechts. */
function Legend({ title, neg, pos, left, mid, right, extra }: { title: string; neg: string; pos: string; left: string; mid: string; right: string; extra?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
      <span className="label">{title}</span>
      <div className="min-w-0 flex-1" style={{ maxWidth: 320, minWidth: 160 }}>
        <div className="h-2.5 w-full rounded-full" style={{ background: legendGradient(neg, pos) }} aria-hidden="true" />
        <div className="num mt-1 flex justify-between text-[11px]" style={{ color: 'var(--color-mut)' }}>
          <span>{left}</span>
          <span>{mid}</span>
          <span>{right}</span>
        </div>
      </div>
      {extra}
    </div>
  );
}

function NoDataSwatch({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-mut)' }}>
      <span
        aria-hidden="true"
        className="inline-block h-3 w-4 rounded-sm"
        style={{ backgroundColor: NO_DATA_COLOR, backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.14) 0 3px, transparent 3px 6px)' }}
      />
      {label}
    </span>
  );
}

export function Heatmap() {
  const { t } = useTranslation();
  const [tab, setTab] = useHashTab<Tab>('#/heatmap', TABS, 'performance');
  const [universe, setUniverse] = useState<Universe | null>(null);
  const [universeError, setUniverseError] = useState<string | null>(null);

  // Symbole mit echten Tageskerzen — Chart-Sprung der Aktien-Kacheln UND Auswahl der Matrix
  useEffect(() => {
    let cancelled = false;
    trpc.market.heatmapUniverse
      .query()
      .then((u) => {
        if (!cancelled) setUniverse(u);
      })
      .catch((err: unknown) => {
        if (!cancelled) setUniverseError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-w-0">
      <PageHeader title={t('ia.page_heatmap')} subtitle={tab === 'performance' ? t('heatmap.subtitle_performance') : t('heatmap.subtitle_korrelation')} />
      <TabBar
        label={t('ia.page_heatmap')}
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'performance', label: t('ia.tab_heatmapPerformance') },
          { id: 'korrelation', label: t('ia.tab_heatmapKorrelation') },
        ]}
      />
      {tab === 'performance' ? <PerformanceTab universe={universe} /> : <CorrelationTab universe={universe} universeError={universeError} />}
    </div>
  );
}

// ── Performance ──────────────────────────────────────────────────────────

type Tip = { tile: HeatTile; target: string | null; x: number; y: number };

function PerformanceTab({ universe }: { universe: Universe | null }) {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<CatalogAsset[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<Quotes | null>(null);
  const [quotesFailed, setQuotesFailed] = useState(false);
  const [live, setLive] = useState<Map<string, HeatLive>>(() => new Map(getLatest().map((x) => [x.symbol, { price: x.price, changePct: x.changePct24h, ts: x.ts }])));
  const [filter, setFilter] = useState<HeatFilter>('all');
  const [groupBy, setGroupBy] = useState<'class' | 'package'>('class');
  const [pkgInfo, setPkgInfo] = useState<{ packages: { id: number; name: string }[]; packageOf: Map<number, number> } | null>(null);
  const [pkgState, setPkgState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    trpc.product.allAssets
      .query()
      .then(setCatalog)
      .catch((err: unknown) => setCatalogError(err instanceof Error ? err.message : String(err)));
    // Krypto-Echtzeit: Ticks sammeln und einmal je Sekunde übernehmen (die Treemap muss nicht 50× pro Sekunde neu zeichnen)
    ensurePriceStream();
    let pending = new Map<string, HeatLive>();
    const off = onTick((x) => {
      pending.set(x.symbol, { price: x.price, changePct: x.changePct24h, ts: x.ts });
    });
    const flush = window.setInterval(() => {
      if (pending.size === 0) return;
      const batch = pending;
      pending = new Map();
      setLive((prev) => {
        const next = new Map(prev);
        for (const [k, v] of batch) next.set(k, v);
        return next;
      });
    }, 1000);
    return () => {
      off();
      window.clearInterval(flush);
    };
  }, []);

  // Kurse für ALLE Katalog-Assets in einem Call, alle 60 s (nur bei sichtbarem Tab)
  const catalogLoaded = catalog !== null;
  useEffect(() => {
    if (catalog === null) return;
    if (catalog.length === 0) {
      setQuotes({}); // leerer Katalog → ehrlich „nichts da“ statt ewigem Laden
      return;
    }
    let cancelled = false;
    // assetQuotes nimmt bis 250 IDs je Aufruf — größere Kataloge in Stücken, damit kein Asset fälschlich „ohne Kurs“ steht
    const chunks: number[][] = [];
    for (let i = 0; i < catalog.length; i += 250) chunks.push(catalog.slice(i, i + 250).map((a) => a.id));
    const load = () => {
      Promise.all(chunks.map((assetIds) => trpc.market.assetQuotes.query({ assetIds })))
        .then((parts) => Object.assign({}, ...parts) as Quotes)
        .then((q) => {
          if (cancelled) return;
          setQuotes(q);
          setQuotesFailed(false);
        })
        .catch(() => {
          if (cancelled) return;
          setQuotesFailed(true);
          setQuotes((prev) => prev ?? {});
        });
    };
    load();
    const timer = setVisibleInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearVisibleInterval(timer);
    };
  }, [catalogLoaded]);

  // Paket-Zuordnung erst bei Bedarf laden (ein Abruf je Paket, gebündelt)
  useEffect(() => {
    if (groupBy !== 'package' || pkgInfo !== null || pkgState !== 'idle') return;
    setPkgState('loading');
    void (async () => {
      try {
        const pkgs = await trpc.product.packages.query();
        const lists = await Promise.all(pkgs.map(async (p) => [p.id, await trpc.product.assets.query({ packageId: p.id })] as const));
        const packageOf = new Map<number, number>();
        for (const [pid, rows] of lists) for (const a of rows) packageOf.set(a.id, pid);
        setPkgInfo({ packages: pkgs.map((p) => ({ id: p.id, name: p.name })), packageOf });
        setPkgState('idle');
      } catch {
        setPkgState('failed');
      }
    })();
  }, [groupBy, pkgInfo, pkgState]);

  const stockVenues = useMemo(() => {
    const best = new Map<string, { venue: string; candles: number }>();
    for (const s of universe?.symbols ?? []) {
      if (s.venue === 'binance') continue;
      const key = s.symbol.toUpperCase();
      const prev = best.get(key);
      if (!prev || s.candles > prev.candles) best.set(key, { venue: s.venue, candles: s.candles });
    }
    return new Map([...best.entries()].map(([k, v]) => [k, v.venue]));
  }, [universe]);

  const usePackages = groupBy === 'package' && pkgInfo !== null;
  const { groups, missing } = useMemo(
    () =>
      buildHeatmapGroups(
        (catalog ?? []).map((a) => ({ id: a.id, ticker: a.ticker, name: a.name, assetType: a.assetType, symbol: a.symbol, isFavorite: a.isFavorite })),
        quotes,
        live,
        usePackages ? { filter, groupBy: 'package', packages: pkgInfo.packages, packageOf: pkgInfo.packageOf } : { filter, groupBy: 'class' },
      ),
    [catalog, quotes, live, filter, usePackages, pkgInfo],
  );

  const latestTs = useMemo(() => {
    let best = 0;
    for (const g of groups) for (const tile of g.tiles) best = Math.max(best, Date.parse(tile.ts) || 0);
    return best > 0 ? new Date(best).toISOString() : null;
  }, [groups]);
  // Tooltip zeigt immer den frischen Stand der Kachel (Live-Ticks), nicht den beim Hovern
  const tileById = useMemo(() => new Map(groups.flatMap((g) => g.tiles.map((tile) => [tile.id, tile] as const))), [groups]);
  const anyWeighted = groups.some((g) => sizingVolumes(g.tiles).some((v) => v !== null && v > 0));
  const quotesReady = quotes !== null;

  const groupLabel = (g: HeatGroup): string => {
    if (g.label !== undefined) return g.label;
    if (g.key === NO_PACKAGE) return t('heatmap.noPackage');
    return (ASSET_CLASSES as readonly string[]).includes(g.key) ? t(classFilterKey(g.key as AssetClass)) : g.key;
  };

  return (
    <div className="min-w-0">
      {catalogError && <ErrorBox message={catalogError} />}

      {/* Bedienleiste: Filter · Gruppierung · Zeitraum · Legende */}
      <section className="glass reveal mb-5 space-y-4 p-4 sm:p-5" style={{ '--stagger': 1 } as CSSProperties}>
        <div className="flex flex-wrap items-center gap-2">
          <Pill active={filter === 'all'} onClick={() => setFilter('all')}>
            {t('common.all')}
          </Pill>
          {ASSET_CLASSES.map((c) => (
            <Pill key={c} active={filter === c} onClick={() => setFilter((prev) => (prev === c ? 'all' : c))}>
              {t(classFilterKey(c))}
            </Pill>
          ))}
          <Pill active={filter === 'favorites'} gold onClick={() => setFilter((prev) => (prev === 'favorites' ? 'all' : 'favorites'))}>
            {filter === 'favorites' ? '★' : '☆'} {t('heatmap.favorites')}
          </Pill>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="label">{t('heatmap.groupBy')}</span>
            <Pill active={groupBy === 'class'} onClick={() => setGroupBy('class')}>
              {t('heatmap.groupClass')}
            </Pill>
            <Pill active={groupBy === 'package'} onClick={() => setGroupBy('package')}>
              {t('heatmap.groupPackage')}
            </Pill>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="label">{t('heatmap.period')}</span>
            {/* Ehrlich: die Quellen liefern genau einen Zeitraum — kein Schalter für Erfundenes */}
            <Pill active title={t('heatmap.periodHint')}>
              {t('heatmap.period24h')}
            </Pill>
          </div>
        </div>
        <Legend
          title={t('heatmap.legendChange')}
          neg={HEAT_NEG}
          pos={HEAT_POS}
          left={`≤ ${fmtPct(-HEAT_MAX_ABS)}`}
          mid={fmtPct(0)}
          right={`≥ ${fmtPct(HEAT_MAX_ABS)}`}
          extra={<NoDataSwatch label={t('heatmap.legendNoChange')} />}
        />
        <p className="text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
          {t('heatmap.periodHint')} {anyWeighted ? t('heatmap.sizeWeighted') : t('heatmap.sizeEqual')}
        </p>
        {groupBy === 'package' && pkgState === 'loading' && <p className="label animate-pulse">{t('heatmap.packagesLoading')}</p>}
        {groupBy === 'package' && pkgState === 'failed' && (
          <p className="text-xs" style={{ color: 'var(--color-warn)' }}>
            {t('heatmap.packagesFailed')}
          </p>
        )}
      </section>

      {quotesFailed && <NotConnected detail={t('heatmap.quotesFailed')} />}

      {catalogError ? null : catalog === null || !quotesReady ? (
        <div className="glass p-6">
          <Loading />
        </div>
      ) : groups.length === 0 ? (
        <div className="glass p-6">
          {filter === 'favorites' && !catalog.some((a) => a.isFavorite) ? (
            <EmptyState text={t('heatmap.emptyFavorites')} actionLabel={t('heatmap.emptyFavoritesCta')} href="#/pakete" />
          ) : (
            <EmptyState text={t('heatmap.emptyFilter')} actionLabel={t('common.all')} onAction={() => setFilter('all')} />
          )}
        </div>
      ) : (
        groups.map((g, gi) => {
          const avg = meanChange(g.tiles);
          return (
            <section key={g.key} className="glass reveal mb-5 min-w-0 p-3 sm:p-5" style={{ '--stagger': Math.min(2 + gi, 10) } as CSSProperties}>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-1">
                <h2 className="text-base font-semibold">{groupLabel(g)}</h2>
                <span className="num text-xs" style={{ color: 'var(--color-mut)' }}>
                  {avg === null ? t('heatmap.groupStatsNoAvg', { n: g.tiles.length }) : t('heatmap.groupStats', { n: g.tiles.length, avg: fmtPct(avg) })}
                </span>
              </div>
              <Treemap tiles={g.tiles} stockVenues={stockVenues} onTip={setTip} />
            </section>
          );
        })
      )}

      {catalog !== null && quotesReady && missing.length > 0 && (
        <details className="glass mb-5 p-4 text-sm">
          <summary className="cursor-pointer select-none" style={{ color: 'var(--color-mut)' }}>
            {t('heatmap.missingTitle', { n: missing.length })}
          </summary>
          <p className="mt-2 text-xs" style={{ color: 'var(--color-mut)' }}>
            {t('heatmap.missingHint')}
          </p>
          <p className="num mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {missing.map((m) => (
              <span key={m.id} title={m.name}>
                {m.ticker}
              </span>
            ))}
          </p>
        </details>
      )}

      <p className="text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('heatmap.sources')}
        {latestTs && ` · ${t('heatmap.asOf', { time: fmtTime(latestTs) })}`}
      </p>

      {tip && createPortal(<TileTooltip tip={{ ...tip, tile: tileById.get(tip.tile.id) ?? tip.tile }} />, document.body)}
    </div>
  );
}

function Treemap({ tiles, stockVenues, onTip }: { tiles: HeatTile[]; stockVenues: Map<string, string>; onTip: (tip: Tip | null) => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const height = treemapHeight(width, tiles.length);
  const volumes = sizingVolumes(tiles);
  // Layout hängt nur an Reihenfolge + Volumen — Live-Ticks färben um, ohne neu aufzuteilen
  const sizeKey = tiles.map((tile, i) => `${tile.id}:${volumes[i] ?? ''}`).join('|');
  // Abhängigkeit bewusst sizeKey (fasst Kacheln + Volumen zusammen) statt der Kachel-Objekte selbst
  const rects = useMemo(() => squarify(tileWeights(volumes).weights, width, height), [sizeKey, width, height]);

  const showAt = (tile: HeatTile, target: string | null, x: number, y: number) => onTip({ tile, target, x, y });

  return (
    <div ref={ref} className="relative w-full overflow-hidden rounded-lg" style={{ height }}>
      {width > 0 &&
        tiles.map((tile, i) => {
          const r = rects[i];
          if (!r || r.w <= 0 || r.h <= 0) return null;
          const w = Math.max(r.w - 2, 0);
          const h = Math.max(r.h - 2, 0);
          const mode = tileLabelMode(w, h);
          const fs = tileFontPx(w, h);
          const target = chartTargetFor(tile, stockVenues);
          const change = tile.changePct === null ? t('heatmap.tipNoChange') : fmtPct(tile.changePct);
          const label = `${tile.ticker} · ${tile.name}: ${change} · ${t('heatmap.tipPrice')} ${fmtQuote(tile.price, tile.currency)}`;
          const style: CSSProperties = {
            left: r.x + 1,
            top: r.y + 1,
            width: w,
            height: h,
            backgroundColor: changeColor(tile.changePct),
            backgroundImage: tile.changePct === null ? 'repeating-linear-gradient(45deg, rgba(255,255,255,0.10) 0 4px, transparent 4px 8px)' : undefined,
            color: TILE_TEXT,
          };
          const content =
            mode === 'none' ? null : (
              <>
                <span className="num block max-w-full truncate leading-tight font-semibold" style={{ fontSize: fs }}>
                  {tile.ticker}
                </span>
                {mode === 'full' && (
                  <span className="num block max-w-full truncate leading-tight" style={{ fontSize: Math.max(10, Math.round(fs * 0.72)) }}>
                    {tile.changePct === null ? '—' : fmtPct(tile.changePct)}
                  </span>
                )}
              </>
            );
          const common = {
            style,
            'aria-label': label,
            className: 'absolute flex flex-col items-center justify-center overflow-hidden rounded-[5px] px-0.5 text-center transition-[filter] hover:brightness-125 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-white',
            onMouseEnter: (e: React.MouseEvent) => showAt(tile, target, e.clientX, e.clientY),
            onMouseMove: (e: React.MouseEvent) => showAt(tile, target, e.clientX, e.clientY),
            onMouseLeave: () => onTip(null),
            onFocus: (e: React.FocusEvent<HTMLElement>) => {
              const b = e.currentTarget.getBoundingClientRect();
              showAt(tile, target, b.left + b.width / 2, b.bottom);
            },
            onBlur: () => onTip(null),
          };
          return target ? (
            <a key={tile.id} href={target} {...common}>
              {content}
            </a>
          ) : (
            <div key={tile.id} role="img" tabIndex={0} {...common} style={{ ...style, cursor: 'default' }}>
              {content}
            </div>
          );
        })}
    </div>
  );
}

function TileTooltip({ tip }: { tip: Tip }) {
  const { t } = useTranslation();
  const { tile } = tip;
  const W = 272;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(8, Math.min(tip.x + 14, vw - W - 8));
  const top = tip.y + 18 + 190 > vh ? Math.max(8, tip.y - 200) : tip.y + 18;
  const row = (k: string, v: ReactNode) => (
    <div className="flex justify-between gap-3">
      <span style={{ color: 'var(--color-mut)' }}>{k}</span>
      <span className="num text-right">{v}</span>
    </div>
  );
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 rounded-xl border p-3 text-xs shadow-xl"
      style={{ left, top, width: W, maxWidth: 'calc(100vw - 16px)', background: 'rgba(8,11,30,0.96)', borderColor: 'var(--color-line2)', color: 'var(--color-ink)' }}
    >
      <p className="num text-sm font-semibold">{tile.ticker}</p>
      <p className="mb-2 truncate" style={{ color: 'var(--color-mut)' }}>
        {tile.name}
      </p>
      <div className="space-y-1">
        {row(t('heatmap.tipPrice'), fmtQuote(tile.price, tile.currency))}
        {row(
          t('heatmap.tipChange'),
          <span style={{ color: tile.changePct === null ? 'var(--color-mut)' : tile.changePct >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
            {tile.changePct === null ? t('heatmap.tipNoChange') : fmtPct(tile.changePct)}
          </span>,
        )}
        {tile.assetType.toUpperCase() === 'CRYPTO' &&
          row(t('heatmap.tipVolume'), tile.volume === null ? t('heatmap.tipNoChange') : `${new Intl.NumberFormat(appLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(tile.volume)} $`)}
        {row(t('heatmap.tipSource'), t(`heatmap.source_${tile.source}`))}
        {row(t('heatmap.tipTime'), fmtTime(tile.ts))}
      </div>
      <p className="mt-2 border-t pt-2" style={{ borderColor: 'var(--color-line)', color: tip.target ? 'var(--color-cyan)' : 'var(--color-mut)' }}>
        {tip.target ? t('heatmap.tipChart') : t('heatmap.tipNoChart')}
      </p>
    </div>
  );
}

// ── Korrelation ──────────────────────────────────────────────────────────

const refKey = (s: SymbolRef) => `${s.venue}:${s.symbol}`;

function CorrelationTab({ universe, universeError }: { universe: Universe | null; universeError: string | null }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<SymbolRef[] | null>(null);
  const [days, setDays] = useState<Days>(() => {
    const raw = Number(readStore(DAYS_KEY));
    return (DAYS as number[]).includes(raw) ? (raw as Days) : 90;
  });
  const [result, setResult] = useState<Correlation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const max = universe?.maxSymbols ?? 20;

  // Startauswahl: gespeicherte Wahl (nur Symbole mit Kerzen), sonst Favoriten → Scan-Universum
  useEffect(() => {
    if (universe === null || selected !== null) return;
    const stored = sanitizeSelection(readStore(SEL_KEY), universe.symbols, max);
    setSelected(stored && stored.length >= 2 ? stored : universe.defaults);
  }, [universe, selected, max]);

  const selKey = (selected ?? []).map(refKey).join('|');
  useEffect(() => {
    if (selected === null) return;
    writeStore(SEL_KEY, JSON.stringify(selected));
    if (selected.length < 2) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    trpc.market.correlation
      .query({ symbols: selected.map((s) => ({ symbol: s.symbol, venue: s.venue as 'binance' | 'yahoo' | 'twelvedata' })), days })
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Abhängigkeit bewusst selKey (Auswahl als Text) — ein neues Array mit gleichem Inhalt rechnet nicht neu
  }, [selKey, days]);

  const changeDays = (d: Days) => {
    setDays(d);
    writeStore(DAYS_KEY, String(d));
  };

  if (universeError) return <ErrorBox message={t('heatmap.universeFailed', { error: universeError })} />;
  if (universe === null || selected === null) {
    return (
      <div className="glass p-6">
        <Loading />
      </div>
    );
  }
  if (universe.symbols.length < 2) {
    return (
      <div className="glass p-6">
        <EmptyState text={t('heatmap.noUniverse')} actionLabel={t('heatmap.noUniverseCta')} href="#/einstellungen?tab=daten" />
      </div>
    );
  }

  const selectedSet = new Set(selected.map(refKey));
  const addable = universe.symbols.filter((s) => !selectedSet.has(refKey(s)));
  const venues = ['binance', 'yahoo', 'twelvedata'].filter((v) => addable.some((s) => s.venue === v));
  // Ergebnis passt nur, wenn es zur aktuellen Auswahl gehört (sonst zeigt die Matrix kurz Altes)
  const current = result && result.days === days && result.symbols.map(refKey).join('|') === selKey ? result : null;
  const labels = current ? matrixLabels(current.symbols) : [];
  const pairs = current ? strongestPairs(labels, current.matrix, 3) : null;
  const notes = current
    ? current.symbols.flatMap((s, i) => {
        if (s.lastDate === null) return [t('heatmap.noCandlesInWindow', { symbol: labels[i] })];
        // > 4 Tage: Wochenende + Feiertag + noch nicht abgeschlossene Börsenkerze sind normal, mehr nicht
        if (current.asOf && Date.parse(current.asOf) - Date.parse(s.lastDate) > 4 * 86_400_000) return [t('heatmap.stale', { symbol: labels[i], date: fmtDate(s.lastDate) })];
        return [];
      })
    : [];

  return (
    <div className="min-w-0">
      <section className="glass reveal mb-5 space-y-4 p-4 sm:p-5" style={{ '--stagger': 1 } as CSSProperties}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="label">{t('heatmap.window')}</span>
          {DAYS.map((d) => (
            <Pill key={d} active={days === d} onClick={() => changeDays(d)}>
              {t('heatmap.days', { n: d })}
            </Pill>
          ))}
        </div>
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <span className="label">{t('heatmap.symbolsTitle', { n: selected.length, max })}</span>
            <button type="button" className="text-xs underline decoration-dotted" style={{ color: 'var(--color-mut)' }} onClick={() => setSelected(universe.defaults)}>
              {t('heatmap.resetDefaults')}
            </button>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {selected.map((s) => (
              <span key={refKey(s)} className="chip chip--acc num" title={`${s.symbol} · ${t(`heatmap.venue_${s.venue}`)}`}>
                {shortSymbol(s.symbol, s.venue)}
                <button
                  type="button"
                  aria-label={t('heatmap.removeSymbol', { symbol: s.symbol })}
                  className="ml-0.5 leading-none opacity-80 hover:opacity-100"
                  onClick={() => setSelected(selected.filter((x) => refKey(x) !== refKey(s)))}
                >
                  ×
                </button>
              </span>
            ))}
            {selected.length < max ? (
              addable.length > 0 && (
                <select
                  className="field min-w-0 max-w-full px-2 py-1.5 text-xs"
                  value=""
                  aria-label={t('heatmap.addSymbol')}
                  onChange={(e) => {
                    const hit = addable.find((s) => refKey(s) === e.target.value);
                    if (hit) setSelected([...selected, { symbol: hit.symbol, venue: hit.venue }]);
                  }}
                >
                  <option value="">{t('heatmap.addSymbol')}</option>
                  {venues.map((v) => (
                    <optgroup key={v} label={t(`heatmap.venue_${v}`)}>
                      {addable
                        .filter((s) => s.venue === v)
                        .map((s) => (
                          <option key={refKey(s)} value={refKey(s)}>
                            {s.symbol}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
              )
            ) : (
              <span className="text-xs" style={{ color: 'var(--color-mut)' }}>
                {t('heatmap.maxReached', { max })}
              </span>
            )}
          </div>
        </div>
        <Legend
          title={t('heatmap.legendCorr')}
          neg={CORR_NEG}
          pos={CORR_POS}
          left={`−1 ${t('heatmap.legendNeg')}`}
          mid="0"
          right={`+1 ${t('heatmap.legendPos')}`}
          extra={<NoDataSwatch label={t('heatmap.tooFew', { min: universe.minReturns })} />}
        />
      </section>

      {error && <ErrorBox message={t('heatmap.matrixFailed', { error })} />}

      {selected.length < 2 ? (
        <div className="glass p-6">
          <EmptyState text={t('heatmap.needTwo')} actionLabel={t('heatmap.resetDefaults')} onAction={() => setSelected(universe.defaults)} />
        </div>
      ) : !current ? (
        !error && (
          <div className="glass p-6">
            <p className="label animate-pulse">{t('heatmap.computing')}</p>
          </div>
        )
      ) : (
        <>
          <section className="glass reveal mb-5 min-w-0 p-3 sm:p-5" style={{ '--stagger': 2 } as CSSProperties}>
            <p className="num mb-3 px-1 text-xs" style={{ color: 'var(--color-mut)' }}>
              {t('heatmap.windowRange', { from: fmtDate(current.fromDate), to: current.asOf ? fmtDate(current.asOf) : '—' })}
              {loading && <span className="ml-2 animate-pulse">· {t('heatmap.computing')}</span>}
            </p>
            <div className="max-w-full overflow-x-auto pb-1">
              <table className="border-separate" style={{ borderSpacing: 2 }}>
                <thead>
                  <tr>
                    <th />
                    {labels.map((l, j) => (
                      <th key={j} scope="col" className="num max-w-[3.25rem] truncate px-0.5 pb-1 text-[11px] font-medium" style={{ color: 'var(--color-mut)' }} title={current.symbols[j]!.symbol}>
                        {l}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {current.matrix.map((row, i) => (
                    <tr key={i}>
                      <th scope="row" className="num whitespace-nowrap pr-2 text-right text-[11px] font-medium" style={{ color: 'var(--color-mut)' }} title={current.symbols[i]!.symbol}>
                        {labels[i]}
                      </th>
                      {row.map((r, j) => {
                        const n = current.counts[i]![j]!;
                        const title =
                          r === null
                            ? t('heatmap.cellTitleTooFew', { a: labels[i], b: labels[j], n, min: current.minReturns })
                            : t('heatmap.cellTitle', { a: labels[i], b: labels[j], r: fmtR(r), n });
                        return (
                          <td
                            key={j}
                            title={title}
                            aria-label={title}
                            className="num rounded-[4px] text-center text-[11px]"
                            style={{
                              minWidth: 46,
                              height: 32,
                              backgroundColor: corrColor(r),
                              backgroundImage: r === null ? 'repeating-linear-gradient(45deg, rgba(255,255,255,0.14) 0 3px, transparent 3px 6px)' : undefined,
                              color: TILE_TEXT,
                              fontWeight: i === j ? 400 : 600,
                              opacity: i === j ? 0.7 : 1,
                            }}
                          >
                            {r === null ? '–' : fmtR(r)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {notes.length > 0 && (
              <ul className="mt-3 space-y-0.5 px-1 text-xs" style={{ color: 'var(--color-warn)' }}>
                {notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
          </section>

          {pairs && (
            <section className="mb-5 grid gap-4 sm:grid-cols-2">
              {(
                [
                  ['topPairs', pairs.top, 'noPositive'],
                  ['bottomPairs', pairs.bottom, 'noNegative'],
                ] as const
              ).map(([titleKey, list, emptyKey]) => (
                <div key={titleKey} className="glass min-w-0 p-4">
                  <h3 className="label mb-2">{t(`heatmap.${titleKey}`)}</h3>
                  {list.length === 0 ? (
                    <p className="text-sm" style={{ color: 'var(--color-mut)' }}>
                      {t(`heatmap.${emptyKey}`)}
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {list.map((p, k) => (
                        <li key={k} className="flex items-center justify-between gap-3 text-sm">
                          <span className="num min-w-0 truncate">
                            {p.a} × {p.b}
                          </span>
                          <span className="num shrink-0 rounded px-2 py-0.5 text-xs font-semibold" style={{ background: corrColor(p.r), color: TILE_TEXT }}>
                            {fmtR(p.r)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </section>
          )}
        </>
      )}

      <p className="text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('heatmap.method', { min: universe.minReturns })}
      </p>
    </div>
  );
}
