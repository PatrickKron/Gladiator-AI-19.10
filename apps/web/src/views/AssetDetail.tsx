import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader, Panel } from '../components/ui.js';
import { AssetSelect, getSelectedAsset, setSelectedAsset } from '../components/AssetSelect.js';
import { AssetChart } from '../components/AssetChart.js';
import { AssetContextBody, useAssetContext } from '../components/AssetContextPanel.js';
import { MlInsights } from '../components/MlInsights.js';
import { FavStarSymbol } from '../components/FavStar.js';
import { ASSET_TABS, buildAssetUrl, parseChartHash, type AssetTab } from '../lib/chart-url.js';
import { parseTab } from '../lib/tab-hash.js';

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
      return linked.symbol;
    }
    return getSelectedAsset();
  });
  const [tab, setTab] = useState<AssetTab>(() => parseTab(window.location.hash, ASSET_TABS, 'chart') as AssetTab);
  const ctx = useAssetContext(asset);

  function changeAsset(sym: string) {
    setSelectedAsset(sym);
    setAsset(sym);
    window.history.replaceState(null, '', buildAssetUrl(sym, tab));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }
  function changeTab(tb: AssetTab) {
    setTab(tb);
    window.history.replaceState(null, '', buildAssetUrl(asset, tb));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }

  // Auf Hash-Wechsel reagieren (Command-Palette, Redirects, Deep-Links).
  useEffect(() => {
    const onHash = () => {
      const p = parseChartHash(window.location.hash);
      const tb = parseTab(window.location.hash, ASSET_TABS, 'chart') as AssetTab;
      setTab(tb);
      if (p.symbol && p.symbol !== asset) {
        setSelectedAsset(p.symbol);
        setAsset(p.symbol);
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [asset]);

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
            <AssetSelect value={asset} onChange={changeAsset} />
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
        <Panel label={asset} stagger={1}>
          <AssetChart symbol={asset} timeframeOverride={linked.tf ?? undefined} />
        </Panel>
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
