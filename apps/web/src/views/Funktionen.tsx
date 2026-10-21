import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/ui.js';
import { AREAS, NAV_PAGES, type NavPage } from '../lib/navigation.js';

/**
 * „Alle Funktionen": die komplette App als Karte — erzeugt aus der
 * Funktions-Registry. Neue Seiten/Tabs erscheinen hier automatisch.
 */
export function Funktionen() {
  const { t } = useTranslation();
  return (
    <div>
      <PageHeader title={t('ia.sitemapTitle')} subtitle={t('ia.sitemapSubtitle')} />
      <div className="space-y-8">
        {AREAS.map((area, ai) => (
          <section key={area.id} className="reveal" style={{ '--stagger': ai + 1 } as React.CSSProperties}>
            <h2 className="label mb-3">{t(area.labelKey)}</h2>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {NAV_PAGES
                .filter((p) => p.area === area.id)
                .map((p) => (
                  <FeatureCard key={p.id} page={p} />
                ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/** Karte einer Seite: Icon, Name, Beschreibung, Direkt-Links in jeden Tab. Auch von „Meine Agenten" genutzt. */
export function FeatureCard({ page }: { page: NavPage }) {
  const { t } = useTranslation();
  return (
    <div className="glass glass-hover flex flex-col p-5">
      <a href={page.hash} className="group flex items-start gap-3">
        <span
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[0.625rem] border"
          style={{ borderColor: 'rgba(148,163,184,0.35)', color: 'var(--color-cyan)', background: 'rgba(59,130,246,0.08)' }}
        >
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={page.icon} />
          </svg>
        </span>
        <span className="min-w-0">
          <span className="block font-medium group-hover:underline">{t(page.labelKey)}</span>
          <span className="mt-1 block text-sm leading-relaxed" style={{ color: 'var(--color-mut)' }}>
            {t(page.descKey)}
          </span>
        </span>
      </a>
      {page.tabs && page.tabs.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5 pl-12">
          {page.tabs.map((tab) => (
            <a
              key={tab.id}
              href={`${page.hash}?tab=${tab.id}`}
              className="rounded border px-2 py-0.5 text-xs transition-colors hover:text-[color:var(--color-ink)]"
              style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
            >
              {t(tab.labelKey)}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
