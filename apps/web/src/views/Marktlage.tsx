import { useTranslation } from 'react-i18next';
import { PageHeader, TabBar } from '../components/ui.js';
import { MacroPanels } from '../components/MacroPanels.js';
import { RiskPanels } from '../components/RiskPanels.js';
import { Entscheidung } from './Entscheidung.js';
import { DataSourcesPanel } from '../components/DataSourcesPanel.js';
import { useHashTab } from '../lib/use-hash-tab.js';

/**
 * Marktlage: das große Bild an EINEM Ort. Makro (vorher Asset-Tab, zeigte aber
 * globale Daten), Risiko-Lage (vorher Asset-Tab „Risiko") und die
 * Entscheidungslogik CPI/COT/Bewertung (vorher im KI-Hub versteckt).
 * Inhalte unverändert — nur der Ort ist jetzt dort, wo man ihn sucht.
 */
const TABS = ['makro', 'risiko', 'entscheidung', 'daten'] as const;
type Tab = (typeof TABS)[number];

export function Marktlage() {
  const { t } = useTranslation();
  const [tab, setTab] = useHashTab<Tab>('#/marktlage', TABS, 'makro');
  const subtitle: Record<Tab, string> = {
    makro: t('oracle.subtitle'),
    risiko: t('aegis.subtitle'),
    entscheidung: t('intel.subtitle'),
    daten: t('data.subtitle'),
  };
  return (
    <div>
      <PageHeader title={t('ia.page_marketState')} subtitle={subtitle[tab]} />
      <TabBar
        label={t('ia.page_marketState')}
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'makro', label: t('asset.tab_makro') },
          { id: 'risiko', label: t('asset.tab_risiko') },
          { id: 'entscheidung', label: t('ia.tab_entscheidung') },
          { id: 'daten', label: t('ia.tab_daten') },
        ]}
      />
      {tab === 'makro' && <MacroPanels />}
      {tab === 'risiko' && <RiskPanels />}
      {tab === 'entscheidung' && <Entscheidung embedded />}
      {tab === 'daten' && <DataSourcesPanel />}
    </div>
  );
}
