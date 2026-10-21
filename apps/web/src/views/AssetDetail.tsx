import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader, Panel } from '../components/ui.js';
import { AssetSelect, getSelectedAsset, getSelectedVenue, setSelectedAsset, setSelectedVenue } from '../components/AssetSelect.js';
import { AssetChart } from '../components/AssetChart.js';
import { OrderBookPanel } from '../components/OrderBookPanel.js';
import { AssetContextBody, useAssetContext } from '../components/AssetContextPanel.js';
import { MlInsights } from '../components/MlInsights.js';
import { FavStarSymbol } from '../components/FavStar.js';
import { ASSET_TABS, buildAssetUrl, parseChartHash, type AssetTab, type ChartVenue } from '../lib/chart-url.js';
import { parseTab } from '../lib/tab-hash.js';
import { Watchlist } from '../components/Watchlist.js';
import { CHART_LAYOUTS, layoutGridClass, loadChartLayout, normalizeCells, saveChartLayout, type ChartCell, type ChartLayout } from '../lib/chart-layout.js';

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
      <PageHeader
        title={t('ia.page_chart')}
        subtitle={t('asset.subtitle')}
        right={
          <div className="flex items-center gap-3">
            {price != null && (
              <span className="num text-sm">
                {price.toLocaleString(undefined, { maximumFractionDigits: price >= 1000 ? 0 : 4 })} $
                {change != null && (
                  <span className="ml-1.5 text-xs" style={{ color: change >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                    {change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(2)} %
                  </span>
                )}
              </span>
            )}
            <FavStarSymbol symbol={asset} />
            <AssetSelect value={asset} venue={venue} onChange={changeAsset} />
          </div>
        }
      />

      {/* Tab-Leiste */}
      <div className="mb-5 flex gap-1 overflow-x-auto border-b" style={{ borderColor: 'var(--color-line)' }}>
        {ASSET_TABS.map((tb) => (
          <button
            key={tb}
            onClick={() => changeTab(tb)}
            className="shrink-0 border-b-2 px-4 py-2 text-sm transition-colors"
            style={tab === tb ? { borderColor: 'var(--color-cyan)', color: 'var(--color-ink)' } : { borderColor: 'transparent', color: 'var(--color-mut)' }}
          >
            {t(`asset.tab_${tb}`)}
          </button>
        ))}
      </div>

      {tab === 'chart' && (
        // Markt-Bühne (UI-Welle 4): Watchlist links, Chart mittig, Orderbuch als ein-/ausblendbares Dock
        <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
          <div className="hidden xl:block">
            <Watchlist value={asset} onSelect={changeAsset} />
          </div>
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-1.5" role="group" aria-label={t('asset.layout')}>
              <span className="label mr-1">{t('asset.layout')}</span>
              {CHART_LAYOUTS.map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => changeLayout(l)}
                  aria-pressed={layout === l}
                  className="rounded border px-2 py-0.5 text-[11px] transition-colors"
                  style={{
                    borderColor: layout === l ? 'rgba(79,209,255,0.5)' : 'var(--color-line)',
                    color: layout === l ? 'var(--color-cyan)' : 'var(--color-mut)',
                    background: layout === l ? 'rgba(79,209,255,0.08)' : 'transparent',
                  }}
                >
                  {l === 1 ? '▭' : l === 2 ? '▯▯' : '⊞'} {t(`asset.layout_${l}`)}
                </button>
              ))}
              {layout > 1 && <span className="label ml-2">{t('asset.layoutHint')}</span>}
            </div>
            <div className={`grid gap-4 ${layoutGridClass(layout)}`}>
              <Panel label={venue === 'binance' ? asset : `${asset} · ${venue === 'twelvedata' ? 'Twelve Data' : 'Yahoo'}`} stagger={1}>
                <AssetChart symbol={asset} venue={venue} timeframeOverride={linked.tf ?? undefined} />
              </Panel>
              {cells.map((cell, i) => (
                <Panel key={i} label={`${cell.symbol} · ${cell.tf}`} stagger={1}>
                  <div className="mb-2 flex justify-end">
                    <AssetSelect value={cell.symbol} venue={cell.venue} onChange={(sym, v) => updateCell(i, { symbol: sym, venue: v })} persist={false} label={t('asset.cellSymbol', { n: i + 2 })} />
                  </div>
                  <AssetChart key={`${cell.venue}:${cell.symbol}:${i}`} symbol={cell.symbol} venue={cell.venue} timeframeOverride={cell.tf} rememberTf={false} onTimeframeChange={(tf) => updateCell(i, { tf })} />
                </Panel>
              ))}
            </div>
            {venue === 'binance' ? (
              <>
                <button type="button" onClick={toggleBook} className="label mt-3 rounded border px-2 py-1" style={{ borderColor: 'var(--color-line)' }}>
                  {bookOpen ? t('market.hideBook') : t('market.showBook')}
                </button>
                {bookOpen && <OrderBookPanel symbol={asset} />}
              </>
            ) : (
              <p className="label mt-3">{t('market.bookCryptoOnly')}</p>
            )}
          </div>
        </div>
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
