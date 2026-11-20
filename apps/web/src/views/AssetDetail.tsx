import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Panel } from '../components/ui.js';
import { AssetSelect, getSelectedAsset, getSelectedVenue, setSelectedAsset, setSelectedVenue } from '../components/AssetSelect.js';
import { AssetAnalysis } from '../components/AssetAnalysis.js';
import { openAssistant } from '../components/AssistantPanel.js';
import { OrderTicket } from './DemoTrading.js';
import { AssetChart } from '../components/AssetChart.js';
import { OrderBookPanel } from '../components/OrderBookPanel.js';
import { AssetContextBody, useAssetContext } from '../components/AssetContextPanel.js';
import { MlInsights } from '../components/MlInsights.js';
import { MacroPanels } from '../components/MacroPanels.js';
import { RiskPanels } from '../components/RiskPanels.js';
import { FavStarSymbol } from '../components/FavStar.js';
import { AddMarketPicker } from '../components/AddMarketPicker.js';
import { ASSET_TABS, buildAssetUrl, parseChartHash, type AssetTab, type ChartVenue } from '../lib/chart-url.js';
import { loadTf } from '../lib/chart-tf.js';
import { parseTab } from '../lib/tab-hash.js';
import { Watchlist } from '../components/Watchlist.js';
import { isTypingTarget } from '../lib/watchlist.js';
import { CHART_LAYOUTS, layoutGridClass, loadChartLayout, normalizeCells, saveChartLayout, type ChartCell, type ChartLayout } from '../lib/chart-layout.js';
import { appLocale } from '../lib/locale.js';
import { priceUnit } from '../lib/asset-tabs.js';

const TAB_ICONS: Record<AssetTab, string> = {
  chart: '📈',
  kontext: '🧭',
  makro: '🌐',
  risiko: '🛡️',
};

const DOCK_KEY = 'gladiator.chartBookDock';
const WATCHLIST_KEY = 'gladiator.chartWatchlist';
const SIZE_KEY = 'gladiator.chartSize';
type ChartSize = 'm' | 'l' | 'xl';

function bookDockOpen(): boolean {
  try {
    return localStorage.getItem(DOCK_KEY) !== '0';
  } catch {
    return true;
  }
}

function loadWatchlistOpen(): boolean {
  try {
    return localStorage.getItem(WATCHLIST_KEY) !== '0';
  } catch {
    return true;
  }
}

function loadChartSize(): ChartSize {
  try {
    const v = localStorage.getItem(SIZE_KEY);
    return v === 'm' || v === 'l' || v === 'xl' ? v : 'l';
  } catch {
    return 'l';
  }
}

/**
 * Asset-Detailseite (P2.9): Tabs wie in v2 — Chart · Analyse · Makro · Risiko
 * (Patrick 2026-10-24: „v2 war näher dran"). Makro und Risiko rendern DIESELBEN
 * Komponenten wie die Marktlage (MacroPanels/RiskPanels) — keine zweite
 * Umsetzung; die Marktlage behält ihre Tabs. Hier bekommen sie `symbol` + `venue`
 * und zeigen nur, was zum gewählten Asset gehört (Patrick 2026-10-25).
 * Deep-Link: `#/charts?symbol=ETH/USDT&tf=4h&tab=makro`. Asset-Wahl teilt localStorage mit
 * den (umgeleiteten) Alt-Routen; aktiver Tab + Symbol liegen im URL-Hash.
 */
export function AssetDetail() {
  const { t } = useTranslation();
  const linked = useMemo(() => parseChartHash(window.location.hash), []);
  const [asset, setAsset] = useState<string>(() => {
    if (linked.symbol) {
      setSelectedAsset(linked.symbol);
      setSelectedVenue(linked.venue ?? 'binance');
      return linked.symbol;
    }
    return getSelectedAsset();
  });
  // Kerzenquelle (Repo-Masterliste, Phase 5): Krypto (Binance) oder Aktien/ETF/Forex (Twelve Data, Yahoo).
  const [venue, setVenue] = useState<ChartVenue>(() => (linked.symbol ? (linked.venue ?? 'binance') : getSelectedVenue()));
  const [tab, setTab] = useState<AssetTab>(() => parseTab(window.location.hash, ASSET_TABS, 'chart') as AssetTab);
  // Kontext aus den Kerzen der GEWÄHLTEN Quelle (Aktien/Forex über Yahoo/Twelve Data, nicht still Binance).
  const ctx = useAssetContext(asset, 60_000, venue);

  const changeAsset = useCallback(
    (sym: string, v: ChartVenue = 'binance') => {
      setSelectedAsset(sym);
      setSelectedVenue(v);
      setAsset(sym);
      setVenue(v);
      const activeTf = parseChartHash(window.location.hash).tf ?? loadTf(sym);
      window.history.replaceState(null, '', buildAssetUrl(sym, tab, activeTf, v));
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    },
    [tab],
  );
  // Mehrfach-Charts (Repo-Masterliste, Phase 3b): Zelle 0 = Haupt-Asset, weitere Zellen eigenes Symbol + TF (Browser-Vorliebe).
  // Fadenkreuz und Zeitbereich laufen über alle Zellen mit (syncGroup), sobald mehr als eine zu sehen ist.
  const [layout, setLayout] = useState<ChartLayout>(() => loadChartLayout().layout);
  const [cells, setCells] = useState<ChartCell[]>(() => normalizeCells(loadChartLayout().cells, loadChartLayout().layout, getSelectedAsset()));
  const changeLayout = (next: ChartLayout) => {
    const nextCells = normalizeCells(cells, next, asset);
    setLayout(next);
    setCells(nextCells);
    saveChartLayout(next, nextCells);
  };
  const updateCell = (i: number, patch: Partial<ChartCell>) => {
    setCells((prev) => {
      const next = prev.map((c, j) => (j === i ? { ...c, ...patch } : c));
      saveChartLayout(layout, next);
      return next;
    });
  };
  const [bookOpen, setBookOpen] = useState(bookDockOpen);
  const [watchlistOpen, setWatchlistOpen] = useState(loadWatchlistOpen);
  const [chartSize, setChartSize] = useState<ChartSize>(loadChartSize);
  const [fullscreen, setFullscreen] = useState(false);
  const [viewportH, setViewportH] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 900));
  // Mängelliste 12: Schnell-Ticket direkt im Chart — dasselbe Demo-Ticket, Symbol/Quelle vom Chart.
  const [ticketOpen, setTicketOpen] = useState(false);
  const [ticketPrefill, setTicketPrefill] = useState<{ price: number; kind: 'limit' | 'sl'; seq: number } | null>(null);
  const [addMarketOpen, setAddMarketOpen] = useState(false);
  const ticketRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Chart-Tastenkürzel: F = Vollbild, W = Watchlist ein/aus (respektiert Eingabefelder und g+w).
  useEffect(() => {
    if (tab !== 'chart') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target as HTMLElement | null)) return;
      const k = e.key.toLowerCase();
      if (k === 'f') {
        e.preventDefault();
        setFullscreen((f) => !f);
      } else if (k === 'w') {
        e.preventDefault();
        setWatchlistOpen((o) => {
          try {
            localStorage.setItem(WATCHLIST_KEY, o ? '0' : '1');
          } catch {
            /* ignore */
          }
          return !o;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab]);

  useEffect(() => {
    if (!fullscreen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [fullscreen]);

  function toggleWatchlist() {
    setWatchlistOpen((o) => {
      try {
        localStorage.setItem(WATCHLIST_KEY, o ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !o;
    });
  }

  function changeChartSize(next: ChartSize) {
    setChartSize(next);
    try {
      localStorage.setItem(SIZE_KEY, next);
    } catch {
      /* ignore */
    }
  }

  const singleChartHeight = fullscreen
    ? Math.max(460, viewportH - 180)
    : chartSize === 'm'
      ? 540
      : chartSize === 'l'
        ? 700
        : Math.max(760, Math.round(viewportH * 0.78));
  function openTicket() {
    if (tab !== 'chart') changeTab('chart');
    setTicketOpen(true);
    setTimeout(() => ticketRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
  }
  function toggleBook() {
    setBookOpen((o) => {
      try {
        localStorage.setItem(DOCK_KEY, o ? '0' : '1');
      } catch {
        // ohne localStorage gilt die Wahl nur für diese Sitzung
      }
      return !o;
    });
  }
  function changeTab(tb: AssetTab) {
    setTab(tb);
    const activeTf = parseChartHash(window.location.hash).tf ?? loadTf(asset);
    window.history.replaceState(null, '', buildAssetUrl(asset, tb, activeTf, venue));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }

  // Auf Hash-Wechsel reagieren (Command-Palette, Redirects, Deep-Links).
  useEffect(() => {
    const onHash = () => {
      const p = parseChartHash(window.location.hash);
      const tb = parseTab(window.location.hash, ASSET_TABS, 'chart') as AssetTab;
      setTab(tb);
      if (p.symbol && (p.symbol !== asset || (p.venue ?? 'binance') !== venue)) {
        setSelectedAsset(p.symbol);
        setSelectedVenue(p.venue ?? 'binance');
        setAsset(p.symbol);
        setVenue(p.venue ?? 'binance');
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [asset, venue]);

  const price = ctx && ctx.available ? ctx.price : null;
  const change = ctx && ctx.available ? ctx.change24hPct : null;
  // Kurswährung aus dem Asset-Profil (SAP.DE → €); unbekannt (London in Pence) → kein Zeichen statt falschem „$".
  const unit = ctx && ctx.available ? priceUnit(ctx.quoteCurrency) : '';

  return (
    <div>
      {/* Kompakter Cockpit-Kopf: Asset · Kurs · Modus-Wahl (Chart · Analyse · Makro · Risiko) · Layout · Aktionen */}
      <div className="glass mb-4 flex flex-wrap items-center gap-x-3 gap-y-2.5 p-3">
        <div className="flex min-w-0 max-w-full items-center gap-2">
          <AssetSelect value={asset} venue={venue} onChange={changeAsset} />
          <FavStarSymbol symbol={asset} venue={venue} />
          <button
            type="button"
            onClick={() => setAddMarketOpen((o) => !o)}
            className="tbtn shrink-0"
            title={t('dashboard.addMarket')}
          >
            {t('dashboard.addMarket')}
          </button>
        </div>
        {price != null && (
          <span className="num flex items-center gap-2 text-sm font-semibold">
            {price.toLocaleString(appLocale(), { maximumFractionDigits: price >= 1000 ? 0 : 4 })}
            {unit ? ` ${unit}` : ''}
            {change != null && <span className={`chip ${change >= 0 ? 'chip--pos' : 'chip--neg'}`}>{change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(2)} %</span>}
          </span>
        )}

        {/* Segmented Cockpit-Tabs: Chart · Analyse · Makro · Risiko */}
        <div
          role="tablist"
          aria-label={t('ia.page_chart')}
          className="flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border p-1"
          style={{ background: 'var(--color-bg3)', borderColor: 'var(--color-line)' }}
        >
          {ASSET_TABS.map((id) => {
            const isActive = tab === id;
            return (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={isActive}
                onClick={() => changeTab(id)}
                className="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all"
                style={
                  isActive
                    ? {
                      background: 'rgba(59, 130, 246, 0.22)',
                      color: 'var(--color-ink)',
                      boxShadow: 'inset 0 0 0 1px rgba(59, 130, 246, 0.45)',
                    }
                    : { color: 'var(--color-mut)' }
                }
              >
                <span aria-hidden="true">{TAB_ICONS[id]}</span>
                <span>{t(`asset.tab_${id}`)}</span>
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {tab === 'chart' && (
            <>
              <button
                type="button"
                onClick={toggleWatchlist}
                aria-pressed={watchlistOpen}
                title="Watchlist links ein-/ausblenden (Taste W)"
                className="tbtn hidden xl:inline-flex"
              >
                {watchlistOpen ? '◧ Watchlist' : '▭ Vollbreite'}
              </button>
              {layout === 1 && (
                <div className="flex gap-0.5 rounded-lg p-0.5" style={{ background: 'var(--color-bg3)' }} role="group" aria-label="Chart-Größe">
                  {(['m', 'l', 'xl'] as const).map((sz) => (
                    <button
                      key={sz}
                      type="button"
                      onClick={() => changeChartSize(sz)}
                      aria-pressed={chartSize === sz}
                      title={sz === 'm' ? 'Standard-Höhe (540 px)' : sz === 'l' ? 'Groß (700 px)' : 'Extra Groß (Viewport)'}
                      className="rounded-md px-2 py-0.5 text-[11px] font-medium uppercase transition-colors"
                      style={chartSize === sz ? { background: 'rgba(59,130,246,0.22)', color: 'var(--color-ink)' } : { color: 'var(--color-mut)' }}
                    >
                      {sz}
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => setFullscreen((f) => !f)}
                aria-pressed={fullscreen}
                title="Chart im Vollbild darstellen (Taste F, Esc beendet)"
                className="tbtn"
              >
                ⛶ Vollbild
              </button>
            </>
          )}
          <div className="flex gap-0.5 rounded-lg p-0.5" style={{ background: 'var(--color-bg3)' }} role="group" aria-label={t('asset.layout')}>
            {CHART_LAYOUTS.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => {
                  changeLayout(l);
                  if (tab !== 'chart') changeTab('chart');
                }}
                aria-pressed={layout === l && tab === 'chart'}
                title={t(`asset.layout_${l}`)}
                className="rounded-md px-2 py-0.5 text-[12px] transition-colors"
                style={layout === l && tab === 'chart' ? { background: 'rgba(59,130,246,0.2)', color: 'var(--color-ink)' } : { color: 'var(--color-mut)' }}
              >
                {l === 1 ? '▭' : l === 2 ? '▯▯' : '⊞'}
              </button>
            ))}
          </div>
          {/* Patricks Mängelliste Punkt 12: aus dem Chart in einem Klick ins Ticket — ohne Seitenwechsel. */}
          <button type="button" className="btn-primary px-3 py-1.5 text-xs" aria-expanded={ticketOpen} onClick={() => (ticketOpen ? setTicketOpen(false) : openTicket())}>
            {t('chart.trade')}
          </button>
          {/* Chat-Einstieg aus dem Chart: Frage mit dem gewählten Asset vorbelegt. */}
          <button type="button" className="tbtn" onClick={() => openAssistant(t('chart.chatPrompt', { symbol: asset }))}>
            {t('chart.chat')}
          </button>
        </div>
      </div>
      {addMarketOpen && (
        <AddMarketPicker
          onClose={() => setAddMarketOpen(false)}
          onChanged={() => undefined}
          onAdded={({ symbol: sym, venue: v }) => {
            changeAsset(sym, v);
            setAddMarketOpen(false);
          }}
        />
      )}

      {tab === 'chart' && (
        // Markt-Bühne (UI-Welle 4 + Welle 12 Groß-/Vollbild): Watchlist links (ausblendbar), Chart mittig, Schnell-Ticket rechts gedockt
        <div className={watchlistOpen ? 'grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)]' : 'block'}>
          {watchlistOpen && (
            <div className="hidden xl:block">
              <Watchlist value={asset} venue={venue} onSelect={changeAsset} />
            </div>
          )}
          <div className={`min-w-0 ${ticketOpen && layout === 1 ? 'grid gap-4 lg:grid-cols-[minmax(0,1fr)_350px] lg:items-start' : ''}`}>
            <div className="min-w-0">
              <div className={`grid gap-4 ${layoutGridClass(layout)}`}>
                <section
                  className={
                    fullscreen
                      ? 'fixed inset-0 z-50 flex flex-col overflow-y-auto p-3 sm:p-4'
                      : 'glass reveal p-3'
                  }
                  style={
                    fullscreen
                      ? { background: 'var(--color-bg)' }
                      : ({ '--stagger': 1 } as React.CSSProperties)
                  }
                >
                  {fullscreen && (
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b pb-2" style={{ borderColor: 'var(--color-line)' }}>
                      <div className="flex items-center gap-3">
                        <span className="num text-base font-semibold" style={{ color: 'var(--color-cyan)' }}>
                          {asset}{venue !== 'binance' ? ` · ${venue === 'twelvedata' ? 'Twelve Data' : 'Yahoo'}` : ''}
                        </span>
                        {price != null && (
                          <span className="num flex items-center gap-2 text-sm font-semibold">
                            {price.toLocaleString(appLocale(), { maximumFractionDigits: price >= 1000 ? 0 : 4 })}
                            {unit ? ` ${unit}` : ''}
                            {change != null && <span className={`chip ${change >= 0 ? 'chip--pos' : 'chip--neg'}`}>{change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(2)} %</span>}
                          </span>
                        )}
                      </div>
                      <button type="button" onClick={() => setFullscreen(false)} className="btn px-3 py-1 text-xs">
                        ✕ Vollbild beenden (Esc)
                      </button>
                    </div>
                  )}
                  {!fullscreen && (venue !== 'binance' || layout > 1) && (
                    <p className="label mb-1 px-1">
                      {`${asset}${venue !== 'binance' ? ` · ${venue === 'twelvedata' ? 'Twelve Data' : 'Yahoo'}` : ''}`}
                    </p>
                  )}
                  <AssetChart
                    symbol={asset}
                    venue={venue}
                    timeframeOverride={linked.tf ?? undefined}
                    mainHeight={layout === 1 ? singleChartHeight : Math.max(360, Math.round(viewportH * 0.42))}
                    syncGroup={layout === 1 ? undefined : 'chart-cells'}
                    enableHotkeys
                    onPickPrice={({ price: p, kind }) => {
                      setTicketPrefill((prev) => ({ price: p, kind, seq: (prev?.seq ?? 0) + 1 }));
                      if (fullscreen) setFullscreen(false);
                      openTicket();
                    }}
                  />
                </section>
                {cells.map((cell, i) => (
                  <Panel key={i} label={`${cell.symbol} · ${cell.tf}`} stagger={1}>
                    <div className="mb-2 flex justify-end">
                      <AssetSelect value={cell.symbol} venue={cell.venue} onChange={(sym, v) => updateCell(i, { symbol: sym, venue: v })} persist={false} label={t('asset.cellSymbol', { n: i + 2 })} />
                    </div>
                    <AssetChart key={`${cell.venue}:${cell.symbol}:${i}`} symbol={cell.symbol} venue={cell.venue} timeframeOverride={cell.tf} rememberTf={false} onTimeframeChange={(tf) => updateCell(i, { tf })} syncGroup="chart-cells" />
                  </Panel>
                ))}
              </div>
              {ticketOpen && layout > 1 && (
                <div ref={ticketRef} className="mt-3">
                  <OrderTicket symbol={asset} venue={venue} embedded prefill={ticketPrefill} onPlaced={() => undefined} />
                </div>
              )}
              {venue === 'binance' ? (
                <div className="mt-3">
                  <button type="button" onClick={toggleBook} className="tbtn" aria-expanded={bookOpen}>
                    {t('chart.orderbook')} {bookOpen ? '▴' : '▾'}
                  </button>
                  {bookOpen && <OrderBookPanel symbol={asset} />}
                </div>
              ) : (
                <p className="label mt-3">{t('market.bookCryptoOnly')}</p>
              )}
            </div>
            {ticketOpen && layout === 1 && (
              <div ref={ticketRef} className="min-w-0">
                <OrderTicket symbol={asset} venue={venue} embedded prefill={ticketPrefill} onPlaced={() => undefined} />
              </div>
            )}
          </div>
        </div>
      )}
      {tab === 'kontext' && (
        <div>
          <AssetAnalysis symbol={asset} venue={venue} ctx={ctx} />
          <div className="grid gap-4 lg:grid-cols-2">
            <MlInsights symbol={asset} />
            <Panel label={t('assetCtx.title', { symbol: asset })} stagger={2}>
              <AssetContextBody ctx={ctx} sections="supplement" />
            </Panel>
          </div>
        </div>
      )}
      {/* Patrick 2026-10-25: Makro/Risiko zeigen hier NUR, was zum gewählten Asset passt (Marktlage bleibt global). */}
      {tab === 'makro' && <MacroPanels symbol={asset} venue={venue} />}
      {tab === 'risiko' && <RiskPanels symbol={asset} venue={venue} />}
    </div>
  );
}
