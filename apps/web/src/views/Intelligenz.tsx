import { useTranslation } from 'react-i18next';
import { PageHeader, TabBar } from '../components/ui.js';
import { useHashTab } from '../lib/use-hash-tab.js';
import { MlModels } from './MlModels.js';
import { RlAgents } from './RlAgents.js';
import { Performance } from './Performance.js';
import { PostTrade } from './PostTrade.js';

/**
 * KI-Modelle (vorher „Intelligenz-Hub"): ML-Modelle, RL-Agenten, Performance
 * und Post-Trade-Learning in EINER Seite mit Tabs. Die Entscheidungslogik
 * (CPI/COT/Bewertung) ist Marktlage und liegt jetzt dort. Deep-Link:
 * `#/intelligenz?tab=rl`; Alt-Routen leitet lib/navigation.ts hierher um.
 */

export const HUB_TABS = ['ml', 'rl', 'performance', 'posttrade'] as const;
export type HubTab = (typeof HUB_TABS)[number];

const BASE = '#/intelligenz';

export function Intelligenz() {
  const { t } = useTranslation();
  const [tab, changeTab] = useHashTab<HubTab>(BASE, HUB_TABS, 'ml');

  const SUBTITLE: Record<HubTab, string> = {
    ml: t('ml.subtitle'),
    rl: t('rl.subtitle'),
    performance: t('perf.subtitle'),
    posttrade: t('posttrade.subtitle'),
  };

  return (
    <div>
      <PageHeader title={t('ia.page_aiModels')} subtitle={SUBTITLE[tab]} />

      <TabBar label={t('hub.title')} active={tab} onChange={changeTab} tabs={HUB_TABS.map((tb) => ({ id: tb, label: t(`hub.tab_${tb}`) }))} />

      {tab === 'ml' && <MlModels embedded />}
      {tab === 'rl' && <RlAgents embedded />}
      {tab === 'performance' && <Performance embedded />}
      {tab === 'posttrade' && <PostTrade embedded />}
    </div>
  );
}
