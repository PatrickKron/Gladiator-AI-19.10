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
import { FavStarSymbol } from '../components/FavStar.js';
import { ASSET_TABS, buildAssetUrl, parseChartHash, type AssetTab, type ChartVenue } from '../lib/chart-url.js';
import { parseTab } from '../lib/tab-hash.js';
import { Watchlist } from '../components/Watchlist.js';
import { CHART_LAYOUTS, layoutGridClass, loadChartLayout, normalizeCells, saveChartLayout, type ChartCell, type ChartLayout } from '../lib/chart-layout.js';
import { appLocale } from '../lib/locale.js';

const DOCK_KEY = 'gladiator.chartBookDock';
function bookDockOpen(): boolean {
  try {
    return localStorage.getItem(DOCK_KEY) !== '0';
  } catch {
    return true;
  }
}

/**
 * Asset-Detailseite (P2.9): Chart + Kontext eines Assets. Makro und Risiko
 * zeigen globale Daten und liegen deshalb in der Marktlage (#/marktlage);
 * alte Links mit tab=makro/risiko leitet lib/navigation.ts dorthin um.
 * Deep-Link: `#/charts?symbol=ETH/USDT&tf=4h&tab=kontext`. Asset-Wahl teilt localStorage mit
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
  const ctx = useAssetContext(asset);

  const changeAsset = useCallback(
    (sym: string, v: ChartVenue = 'binance') => {
      setSelectedAsset(sym);
      setSelectedVenue(v);
      setAsset(sym);
      setVenue(v);
      window.history.replaceState(null, '', buildAssetUrl(sym, tab, null, v));
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
  // Mängelliste 12: Schnell-Ticket direkt im Chart — dasselbe Demo-Ticket, Symbol/Quelle vom Chart.
  const [ticketOpen, setTicketOpen] = useState(false);
  const ticketRef = useRef<HTMLDivElement>(null);
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
    window.history.replaceState(null, '', buildAssetUrl(asset, tb, null, venue));
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

  return (
    <div>
      {/* Kompakter Kopf (Welle C): Asset · Kurs · Ansicht 1/2/4 · Kontext — der Chart bekommt die Fläche */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 max-w-full items-center gap-2">
          <AssetSelect value={asset} venue={venue} onChange={changeAsset} />
          <FavStarSymbol symbol={asset} />
        </div>
        {price != null && (
          <span className="num flex items-center gap-2 text-sm font-semibold">
            {price.toLocaleString(appLocale(), { maximumFractionDigits: price >= 1000 ? 0 : 4 })} $
            {change != null && <span className={`chip ${change >= 0 ? 'chip--pos' : 'chip--neg'}`}>{change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(2)} %</span>}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
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
          <button type="button" className="tbtn" aria-pressed={tab === 'kontext'} onClick={() => changeTab(tab === 'kontext' ? 'chart' : 'kontext')}>
            {t('chart.context')}
          </button>
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

      {tab === 'chart' && (
        // Markt-Bühne (UI-Welle 4): Watchlist links, Chart mittig, Orderbuch als ein-/ausblendbares Dock
        <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
          <div className="hidden xl:block">
            <Watchlist value={asset} onSelect={changeAsset} />
          </div>
          <div className="min-w-0">
            <div className={`grid gap-4 ${layoutGridClass(layout)}`}>
              <section className="glass reveal p-3" style={{ '--stagger': 1 } as React.CSSProperties}>
                {venue !== 'binance' && <p className="label mb-1 px-1">{`${asset} · ${venue === 'twelvedata' ? 'Twelve Data' : 'Yahoo'}`}</p>}
                <AssetChart symbol={asset} venue={venue} timeframeOverride={linked.tf ?? undefined} mainHeight={layout === 1 ? 460 : 340} syncGroup={layout === 1 ? undefined : 'chart-cells'} />
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
            {ticketOpen && (
              <div ref={ticketRef} className="mt-3">
                <OrderTicket symbol={asset} venue={venue} embedded onPlaced={() => undefined} />
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
        </div>
      )}
      {tab === 'kontext' && (
        <AssetAnalysis symbol={asset} ctx={ctx} />
      )}
      {tab === 'kontext' && (
        <Panel label={t('assetCtx.title', { symbol: asset })} stagger={1}>
          <AssetContextBody ctx={ctx} />
          <MlInsights symbol={asset} />
        </Panel>
      )}
    </div>
  );
}
