import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { logout, trpc } from '../api.js';
import { NotificationBell } from './NotificationBell.js';
import { ensurePriceStream, getFeedState, onFeedState, type FeedState } from '../lib/prices.js';
import { LANGUAGES, setLanguage, storedLanguage, type LanguageCode } from '../i18n/index.js';
import { isDemoMode, onDemoModeChange } from '../lib/demo-mode.js';
import { getUiMode, onUiModeChange, setUiMode, type UiMode } from '../lib/ui-mode.js';
import { currentSessionEnd, nextSessionStart, sessionAt, type MarketSession } from '../lib/market-session.js';
import { CommandPalette } from './CommandPalette.js';
import { AREAS, NAV_PAGES, pageForHash, tabForHash } from '../lib/navigation.js';
import { clearVisibleInterval, setVisibleInterval } from '../lib/visible-interval.js';

/**
 * App-Shell (09_ §2): Sidebar-Navigation in Gruppen, Topbar mit Wortmarke,
 * Live-Feed-Status, PAPER-Badge (deutlich sichtbar), Kill-Switch-Warnung,
 * Sprach-Switch, Abmelden. Neon-Dual-Designsprache aus DESIGN_SYSTEM.md.
 */

const ico = (d: string) => (
  <svg viewBox="0 0 24 24" className="h-[17px] w-[17px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

/**
 * Informationsarchitektur: GENAU 5 Bereiche (Patricks Vorgabe). Seiten,
 * Reihenfolge, Icons und Beschreibungen kommen aus der Funktions-Registry
 * (lib/navigation.ts) — eine neue Funktion wird dort eingetragen und
 * erscheint hier automatisch. Alle Seiten sind in beiden Modi sichtbar
 * (vorher waren 4 Seiten im Einfach-Modus versteckt und schwer zu finden);
 * Einfach/Profi steuert nur die Detailtiefe INNERHALB der Seiten.
 */
const NAV = AREAS.map((area) => ({ area, pages: NAV_PAGES.filter((p) => p.area === area.id) }));

/** Brotkrumen: Bereich › Seite › Tab — immer sichtbar, wo man gerade ist. */
function Breadcrumb({ route }: { route: string }) {
  const { t } = useTranslation();
  const page = pageForHash(route);
  if (!page || page.id === 'today') return null;
  const area = AREAS.find((a) => a.id === page.area)!;
  const tab = tabForHash(page, route);
  return (
    <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap items-center gap-1.5 text-xs" style={{ color: 'var(--color-mut)' }}>
      <a href="#/" className="hover:underline">{t('ia.page_today')}</a>
      <span aria-hidden="true">›</span>
      <span>{t(area.labelKey)}</span>
      <span aria-hidden="true">›</span>
      <a href={page.hash} className="hover:underline" style={{ color: tab ? undefined : 'var(--color-ink)' }}>
        {t(page.labelKey)}
      </a>
      {tab && (
        <>
          <span aria-hidden="true">›</span>
          <span style={{ color: 'var(--color-ink)' }}>{t(tab.labelKey)}</span>
        </>
      )}
    </nav>
  );
}

function FeedBadge() {
  const { t } = useTranslation();
  const [feed, setFeed] = useState<FeedState>(getFeedState());
  useEffect(() => {
    ensurePriceStream();
    return onFeedState(setFeed);
  }, []);
  const map: Record<FeedState, { text: string; color: string }> = {
    live: { text: `● ${t('common.live')}`, color: 'var(--color-pos)' },
    connecting: { text: '◌', color: 'var(--color-warn)' },
    disconnected: { text: '○', color: 'var(--color-neg)' },
  };
  return (
    <span className="num text-xs tracking-widest" style={{ color: map[feed].color }} title={feed}>
      {map[feed].text}
    </span>
  );
}

/**
 * Sessions-Übersicht (Patricks Wunsch): welche Handels-Session läuft gerade?
 * Badge in der Topbar + Tooltip mit Ende/nächstem Start. Minütlich aktualisiert.
 */
function SessionBadge() {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setVisibleInterval(() => setNow(new Date()), 60_000);
    return () => clearVisibleInterval(timer);
  }, []);
  const session: MarketSession = sessionAt(now);
  const end = currentSessionEnd(now);
  const next = nextSessionStart(now);
  const fmt = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const title =
    session === 'off'
      ? t('session.nextHint', { session: t(`session.${next.session}`), time: fmt(next.startsAt) })
      : t('session.endHint', { time: end ? fmt(end) : '—' });
  const active = session !== 'off';
  return (
    <span
      className="label hidden rounded border px-1.5 py-0.5 sm:inline"
      style={
        active
          ? { borderColor: 'rgba(60,220,130,0.45)', color: 'var(--color-pos)' }
          : { borderColor: 'var(--color-line)', color: 'var(--color-mut)' }
      }
      title={title}
    >
      {active ? '● ' : '○ '}
      {t(`session.${session}`)}
    </span>
  );
}

function LanguageSwitch() {
  // Aktuelle Sprache aus i18n ableiten (useTranslation re-rendert bei Wechsel) —
  // so bleibt der Topbar-Switch synchron, auch wenn die Sprache im Profil geändert wird.
  const { i18n } = useTranslation();
  const lang: LanguageCode = LANGUAGES.some((l) => l.code === i18n.language)
    ? (i18n.language as LanguageCode)
    : storedLanguage();
  return (
    <select
      value={lang}
      onChange={(e) => {
        setLanguage(e.target.value as LanguageCode);
      }}
      className="field cursor-pointer px-2 py-1 text-xs uppercase"
      style={{ color: 'var(--color-mut)' }}
      aria-label="Language"
    >
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.code.toUpperCase()}
        </option>
      ))}
    </select>
  );
}

export function Shell({ route, children }: { route: string; children: ReactNode }) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [killSwitch, setKillSwitch] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [demoMode, setDemoModeState] = useState(() => isDemoMode());
  const [uiMode, setUiModeState] = useState<UiMode>(() => getUiMode());

  useEffect(() => onDemoModeChange(setDemoModeState), []);
  useEffect(() => onUiModeChange(() => setUiModeState(getUiMode())), []);

  // Command-Palette (P1.5): global per Cmd/Ctrl+K öffnen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const s = await trpc.settings.get.query();
        if (!cancelled) setKillSwitch(s.killSwitchActive);
      } catch {
        /* unkritisch — Anzeige-Only */
      }
    };
    void load();
    const timer = setVisibleInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearVisibleInterval(timer);
    };
  }, [route]);

  const activeHash = useMemo(() => {
    const clean = route.split('?')[0] || '#/';
    return clean === '' || clean === '#' ? '#/' : clean;
  }, [route]);

  const nav = (
    <nav className="flex flex-col gap-5" aria-label={t('nav.modeLabel')}>
      {NAV.map(({ area, pages }) => (
        <div key={area.id}>
          <p className="label mb-1.5 px-3">{t(area.labelKey)}</p>
          <ul className="space-y-0.5">
            {pages.map((item) => {
              const active = activeHash === item.hash;
              return (
                <li key={item.hash}>
                  <a
                    href={item.hash}
                    onClick={() => setMenuOpen(false)}
                    title={t(item.descKey)}
                    aria-current={active ? 'page' : undefined}
                    className="flex items-center gap-2.5 rounded-[0.625rem] px-3 py-[7px] text-sm transition-all"
                    style={
                      active
                        ? {
                            color: 'var(--color-ink)',
                            background: 'linear-gradient(92deg, rgba(46,124,246,0.18), rgba(139,92,246,0.12))',
                            border: '1px solid rgba(99,140,255,0.35)',
                            boxShadow: '0 0 18px rgba(46,124,246,0.15), inset 0 1px 0 rgba(255,255,255,0.06)',
                          }
                        : { color: 'var(--color-mut)', border: '1px solid transparent' }
                    }
                  >
                    <span style={{ color: active ? 'var(--color-cyan)' : 'var(--color-mut)' }}>{ico(item.icon)}</span>
                    {t(item.labelKey)}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="relative z-10 flex min-h-screen">
      {/* Sidebar (Desktop) */}
      <aside
        className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-8 overflow-y-auto border-r p-5 lg:flex"
        style={{ borderColor: 'var(--color-line)', background: 'rgba(5,7,22,0.55)', backdropFilter: 'blur(18px)' }}
      >
        <a href="#/" className="wordmark px-2 text-base font-semibold">
          GLADIATOR
        </a>
        {nav}
        <div className="mt-auto px-2">
          <p className="label">v2 · Neon-Dual</p>
        </div>
      </aside>

      {/* Mobile-Menü */}
      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setMenuOpen(false)}>
          <div className="absolute inset-0" style={{ background: 'rgba(3,4,14,0.75)', backdropFilter: 'blur(4px)' }} />
          <aside
            className="absolute inset-y-0 left-0 w-64 overflow-y-auto border-r p-5"
            style={{ borderColor: 'var(--color-line)', background: 'rgba(6,8,24,0.97)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <a href="#/" className="wordmark mb-8 block px-2 text-base font-semibold">
              GLADIATOR
            </a>
            {nav}
          </aside>
        </div>
      )}

      <div className="min-w-0 flex-1">
        {/* Topbar */}
        <header
          className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-5 py-3"
          style={{ borderColor: 'var(--color-line)', background: 'rgba(5,7,22,0.6)', backdropFilter: 'blur(18px)' }}
        >
          <div className="flex items-center gap-3">
            <button
              className="rounded border p-1.5 lg:hidden"
              style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
              onClick={() => setMenuOpen(true)}
              aria-label="Menu"
            >
              {ico('M4 6h16M4 12h16M4 18h16')}
            </button>
            <a href="#/" className="wordmark text-sm font-semibold lg:hidden">
              GLADIATOR
            </a>
            <span
              className="label rounded border px-1.5 py-0.5"
              style={{ borderColor: 'rgba(79,209,255,0.4)', color: 'var(--color-cyan)' }}
            >
              {t('common.paper')}
            </span>
            {demoMode && (
              <a
                href="#/traden?tab=demo"
                className="label rounded border px-1.5 py-0.5"
                style={{ borderColor: 'rgba(225,78,207,0.55)', color: 'var(--color-magenta)', boxShadow: '0 0 14px rgba(225,78,207,0.2)' }}
                title={t('demo.badgeHint')}
              >
                {t('demo.badge')}
              </a>
            )}
            {killSwitch && (
              <a
                href="#/traden?tab=positionen"
                className="label rounded border px-1.5 py-0.5"
                style={{ borderColor: 'rgba(255,92,108,0.5)', color: 'var(--color-neg)', boxShadow: '0 0 14px rgba(255,92,108,0.25)' }}
              >
                KILL-SWITCH
              </a>
            )}
          </div>
          <div className="flex items-center gap-4">
            {/* Einfach/Profi (Binance-Lite/Pro-Muster): verlustfrei, sofort reversibel */}
            <div
              className="flex overflow-hidden rounded-[0.625rem] border text-xs"
              style={{ borderColor: 'var(--color-line)' }}
              role="group"
              aria-label={t('nav.modeLabel')}
            >
              {(['einfach', 'profi'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setUiMode(m)}
                  className="px-2.5 py-1.5 transition-colors"
                  style={
                    uiMode === m
                      ? { background: 'linear-gradient(92deg, rgba(46,124,246,0.25), rgba(139,92,246,0.2))', color: 'var(--color-ink)' }
                      : { color: 'var(--color-mut)' }
                  }
                  title={t(m === 'einfach' ? 'nav.modeSimpleHint' : 'nav.modeProHint')}
                >
                  {t(m === 'einfach' ? 'nav.modeSimple' : 'nav.modePro')}
                </button>
              ))}
            </div>
            <button
              onClick={() => setPaletteOpen(true)}
              className="flex items-center gap-1.5 rounded-[0.625rem] border px-2.5 py-1.5 text-xs transition-colors"
              style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
              title={t('palette.button')}
              aria-label={t('palette.button')}
            >
              {ico('M21 21l-4.3-4.3M11 18a7 7 0 100-14 7 7 0 000 14z')}
              <span className="hidden sm:inline">{t('palette.button')}</span>
              <span className="num label hidden md:inline">⌘K</span>
            </button>
            <NotificationBell />
            <SessionBadge />
            <FeedBadge />
            <LanguageSwitch />
            <button
              onClick={() => void logout()}
              className="text-sm transition-colors hover:text-[color:var(--color-ink)]"
              style={{ color: 'var(--color-mut)' }}
            >
              {t('common.logout')}
            </button>
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-5 pt-6 pb-6 md:px-8">
          <Breadcrumb route={route} />
          {children}
        </main>
        {/* Disclaimer (10_ §7 Abnahme): auf jeder Seite sichtbar */}
        <footer className="mx-auto max-w-6xl px-5 pb-8 text-center text-[11px] leading-relaxed md:px-8" style={{ color: 'var(--color-mut)' }}>
          {t('common.disclaimer')}
        </footer>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
