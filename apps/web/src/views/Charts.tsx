import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader, Panel } from '../components/ui.js';
import { AssetSelect, getSelectedAsset } from '../components/AssetSelect.js';
import { AssetChart } from '../components/AssetChart.js';
import { AssetContextBody, useAssetContext } from '../components/AssetContextPanel.js';

/**
 * Charts (Krypto-Charting): interaktiver Voll-Chart mit allen Indikatoren +
 * Smart-Money-Markern für das gewählte Asset, plus dessen echtem Kontext.
 * Asset-Selektor teilt sich localStorage mit Oracle/Aegis.
 */
export function Charts() {
  const { t } = useTranslation();
  const [asset, setAsset] = useState(getSelectedAsset());
  const ctx = useAssetContext(asset);

  return (
    <div>
      <PageHeader
        title={t('chart.title')}
        subtitle={t('chart.subtitle')}
        right={<AssetSelect value={asset} onChange={setAsset} />}
      />

      <Panel label={asset} stagger={1}>
        <AssetChart symbol={asset} initialTimeframe="1h" />
      </Panel>

      <Panel label={t('assetCtx.title', { symbol: asset })} stagger={2} className="mt-5">
        <AssetContextBody ctx={ctx} />
      </Panel>
    </div>
  );
}
