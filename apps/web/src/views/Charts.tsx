import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader, Panel } from '../components/ui.js';
import { AssetSelect, getSelectedAsset, setSelectedAsset } from '../components/AssetSelect.js';
import { AssetChart } from '../components/AssetChart.js';
import { AssetContextBody, useAssetContext } from '../components/AssetContextPanel.js';
import { FavStarSymbol } from '../components/FavStar.js';
import { parseChartHash } from '../lib/chart-url.js';

/**
 * Charts (Krypto-Charting): interaktiver Voll-Chart mit allen Indikatoren +
 * Smart-Money-Markern für das gewählte Asset, plus dessen echtem Kontext.
 * Deep-Link (P0.1): `#/charts?symbol=ETH/USDT&tf=4h` öffnet direkt Asset+Timeframe.
 * Asset-Selektor teilt sich localStorage mit Oracle/Aegis.
 */
export function Charts() {
  const { t } = useTranslation();
  // Deep-Link beim ersten Mount auswerten (einmalig).
  const linked = useMemo(() => parseChartHash(window.location.hash), []);
  const [asset, setAsset] = useState(() => {
    if (linked.symbol) {
      setSelectedAsset(linked.symbol); // mit Oracle/Aegis-Dropdown synchronisieren
      return linked.symbol;
    }
    return getSelectedAsset();
  });
  const ctx = useAssetContext(asset);

  return (
    <div>
      <PageHeader
        title={t('chart.title')}
        subtitle={t('chart.subtitle')}
        right={
          <div className="flex items-center gap-2">
            <FavStarSymbol symbol={asset} />
            <AssetSelect value={asset} onChange={setAsset} />
          </div>
        }
      />

      <Panel label={asset} stagger={1}>
        <AssetChart symbol={asset} timeframeOverride={linked.tf ?? undefined} />
      </Panel>

      <Panel label={t('assetCtx.title', { symbol: asset })} stagger={2} className="mt-5">
        <AssetContextBody ctx={ctx} />
      </Panel>
    </div>
  );
}
