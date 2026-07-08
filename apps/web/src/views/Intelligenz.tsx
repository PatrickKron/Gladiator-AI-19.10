import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/ui.js';
import { parseTab, buildTabHash } from '../lib/tab-hash.js';
import { MlModels } from './MlModels.js';
import { RlAgents } from './RlAgents.js';
import { Performance } from './Performance.js';
import { Entscheidung } from './Entscheidung.js';

/**
 * Intelligenz-Hub (P0-Workover): führt ML-Modelle, RL-Agenten und Performance
 * in EINER Seite mit Tabs zusammen — die Sidebar-Gruppe „Intelligenz" bleibt
 * überschaubar. Deep-Link: `#/intelligenz?tab=rl`. Die Alt-Routen `#/ml`,
 * `#/rl-agenten`, `#/performance` leiten hierher um (App.tsx).
 */

export const HUB_TABS = ['ml', 'rl', 'performance', 'intel'] as const;
export type HubTab = (typeof HUB_TABS)[number];

const BASE = '#/intelligenz';

export function Intelligenz() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<HubTab>(() => parseTab(window.location.hash, HUB_TABS, 'ml') as HubTab);

  // Auf Hash-Wechsel reagieren (Command-Palette, Redirects, Deep-Links).
  useEffect(() => {
    const onHash = () => setTab(parseTab(window.location.hash, HUB_TABS, 'ml') as HubTab);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function changeTab(tb: HubTab) {
    setTab(tb);
    window.history.replaceState(null, '', buildTabHash(BASE, tb));
  }

  const SUBTITLE: Record<HubTab, string> = {
    ml: t('ml.subtitle'),
    rl: t('rl.subtitle'),
    performance: t('perf.subtitle'),
    intel: t('intel.subtitle'),
  };

  return (
    <div>
      <PageHeader title={t('hub.title')} subtitle={SUBTITLE[tab]} />

      {/* Tab-Leiste (gleiches Muster wie Asset-Detailseite) */}
      <div className="mb-5 flex gap-1 overflow-x-auto border-b" style={{ borderColor: 'var(--color-line)' }}>
        {HUB_TABS.map((tb) => (
          <button
            key={tb}
            onClick={() => changeTab(tb)}
            className="shrink-0 border-b-2 px-4 py-2 text-sm transition-colors"
            style={tab === tb ? { borderColor: 'var(--color-cyan)', color: 'var(--color-ink)' } : { borderColor: 'transparent', color: 'var(--color-mut)' }}
          >
            {t(`hub.tab_${tb}`)}
          </button>
        ))}
      </div>

      {tab === 'ml' && <MlModels embedded />}
      {tab === 'rl' && <RlAgents embedded />}
      {tab === 'performance' && <Performance embedded />}
      {tab === 'intel' && <Entscheidung embedded />}
    </div>
  );
}
