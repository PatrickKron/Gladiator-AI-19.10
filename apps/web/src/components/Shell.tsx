import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { logout, trpc } from '../api.js';
import { ensurePriceStream, getFeedState, onFeedState, type FeedState } from '../lib/prices.js';
import { LANGUAGES, setLanguage, storedLanguage, type LanguageCode } from '../i18n/index.js';
import { isDemoMode, onDemoModeChange } from '../lib/demo-mode.js';
import { getUiMode, onUiModeChange, setUiMode, type UiMode } from '../lib/ui-mode.js';
import { currentSessionEnd, nextSessionStart, sessionAt, type MarketSession } from '../lib/market-session.js';
import { CommandPalette } from './CommandPalette.js';

/**
 * App-Shell (09_ §2): Sidebar-Navigation in Gruppen, Topbar mit Wortmarke,
 * Live-Feed-Status, PAPER-Badge (deutlich sichtbar), Kill-Switch-Warnung,
 * Sprach-Switch, Abmelden. Neon-Dual-Designsprache aus DESIGN_SYSTEM.md.
 */

type NavItem = { hash: string; key: string; icon: ReactNode; pro?: boolean };
type NavGroup = { key: string; items: NavItem[] };

const ico = (d: string) => (
  <svg viewBox="0 0 24 24" className="h-[17px] w-[17px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

/**
 * Informationsarchitektur (Umbau 2026-07-10, Patricks Vorgabe): GENAU
 * 5 Bereiche — Heute · Markt · Vermögen · Agenten · System. EINE Navigation,
 * eine Wahrheit (die klassische Ansicht ist gelöscht, Patrick-Freigabe).
 * `pro: true` = nur im Profi-Modus sichtbar (Progressive Disclosure —
 * alles bleibt über den Toggle und die ⌘K-Palette erreichbar).
 */
export const AREA_GROUPS: NavGroup[] = [
  {
    key: 'nav.areaToday',
    items: [{ hash: '#/', key: 'nav.today', icon: ico('M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10') }],
  },
  {
    key: 'nav.areaMarket',
    items: [
      { hash: '#/charts', key: 'nav.chart', icon: ico('M4 19V5m0 14h16M8 14l3-3 2 2 4-5') },
      { hash: '#/trading', key: 'nav.trade', icon: ico('M4 19V5m0 14h16M8 15l3-4 3 2 5-7') },
      { hash: '#/signals', key: 'nav.signals', icon: ico('M3 12h4l3-8 4 16 3-8h4') },
      { hash: '#/pakete', key: 'nav.discover', icon: ico('M21 8l-9-5-9 5 9 5 9-5zm-18 0v8l9 5 9-5V8M12 13v8') },
      { hash: '#/kalender', key: 'nav.calendar', icon: ico('M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2zm3-3v4m8-4v4M3 10h18') },
      { hash: '#/magazine', key: 'nav.news', icon: ico('M4 4h11a3 3 0 013 3v13H7a3 3 0 01-3-3V4zm14 4h2v12a2 2 0 01-2 2M8 8h6M8 12h6') },
    ],
  },
  {
    key: 'nav.areaWealth',
    items: [{ hash: '#/vermoegen', key: 'nav.wealth', icon: ico('M3 7h18v12H3zM3 11h18M7 15h4m5-11l2 3h-4l2-3z') }],
  },
  {
    key: 'nav.areaAgents',
    items: [
      { hash: '#/agenten', key: 'nav.myAgents', icon: ico('M12 8a4 4 0 100-8 4 4 0 000 8zm-7 13a7 7 0 0114 0M2 21h20') },
      { hash: '#/strategien', key: 'nav.builder', icon: ico('M4 6h16M4 12h10M4 18h7m5-3l4 4m0-4l-4 4') },
      { hash: '#/werkstatt', key: 'nav.workshop', icon: ico('M14.7 6.3a4 4 0 00-5.4 5.3L3 18v3h3l6.9-6.9a4 4 0 005.3-5.4l-2.6 2.6-2.3-.6-.6-2.3z'), pro: true },
      { hash: '#/strategie-workshop', key: 'nav.strategyWorkshop', icon: ico('M8 9h8m-8 4h5m-7 7l-3-3V5a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H8z'), pro: true },
      { hash: '#/labor', key: 'nav.lab', icon: ico('M9 3v6l-5 9a2 2 0 002 3h12a2 2 0 002-3l-5-9V3M7 3h10'), pro: true },
      { hash: '#/intelligenz', key: 'nav.intelligence', icon: ico('M4 20V10l4-6h8l4 6v10M9 20v-6h6v6M2 10h20M12 4v6'), pro: true },
    ],
  },
  {
    key: 'nav.areaSystem',
    items: [
      { hash: '#/einstellungen', key: 'nav.settings', icon: ico('M12 15a3 3 0 100-6 3 3 0 000 6zm8-3l2-1-2-4-2.2.7a8 8 0 00-1.5-.9L16 4h-4l-.3 2.8a8 8 0 00-1.5.9L8 7 6 11l2 1v0l-2 1 2 4 2.2-.7c.5.4 1 .7 1.5.9L12 20h4l.3-2.8c.5-.2 1-.5 1.5-.9L20 17l2-4z') },
      { hash: '#/profil', key: 'nav.profile', icon: ico('M12 12a4 4 0 100-8 4 4 0 000 8zm-8 9a8 8 0 0116 0') },
    ],
  },
];

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
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
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
  const [lang, setLang] = useState<LanguageCode>(storedLanguage());
  return (
    <select
      value={lang}
      onChange={(e) => {
        const code = e.target.value as LanguageCode;
        setLang(code);
        setLanguage(code);
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
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [route]);

  const activeHash = useMemo(() => {
    const clean = route.split('?')[0] || '#/';
    return clean === '' || clean === '#' ? '#/' : clean;
  }, [route]);

  // EINE Navigation, eine Wahrheit: 5 Bereiche, gefiltert nach Einfach/Profi.
  const groups = AREA_GROUPS;
  const hiddenProCount = uiMode === 'profi' ? 0 : AREA_GROUPS.reduce((n, g) => n + g.items.filter((i) => i.pro).length, 0);

  const nav = (
    <nav className="flex flex-col gap-6">
      {groups.map((group) => (
        <div key={group.key}>
          <p className="label mb-2 px-3">{t(group.key)}</p>
          <ul className="space-y-0.5">
            {group.items.filter((item) => uiMode === 'profi' || !item.pro).map((item) => {
              const active = activeHash === item.hash;
              return (
                <li key={item.hash}>
                  <a
                    href={item.hash}
                    onClick={() => setMenuOpen(false)}
                    className="flex items-center gap-2.5 rounded-[0.625rem] px-3 py-2 text-sm transition-all"
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
                    <span style={{ color: active ? 'var(--color-cyan)' : 'var(--color-mut)' }}>{item.icon}</span>
                    {t(item.key)}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {hiddenProCount > 0 && (
        <button
          onClick={() => setUiMode('profi')}
          className="mx-3 rounded-[0.625rem] border border-dashed px-3 py-2 text-left text-xs transition-colors"
          style={{ borderColor: 'rgba(139,92,246,0.4)', color: 'var(--color-violet)' }}
        >
          ▸ {t('nav.proHint', { n: hiddenProCount })}
        </button>
      )}
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
                href="#/trading"
                className="label rounded border px-1.5 py-0.5"
                style={{ borderColor: 'rgba(225,78,207,0.55)', color: 'var(--color-magenta)', boxShadow: '0 0 14px rgba(225,78,207,0.2)' }}
                title={t('demo.badgeHint')}
              >
                {t('demo.badge')}
              </a>
            )}
            {killSwitch && (
              <a
                href="#/trading"
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

        <main className="mx-auto max-w-6xl px-5 pt-8 pb-6 md:px-8">{children}</main>
        {/* Disclaimer (10_ §7 Abnahme): auf jeder Seite sichtbar */}
        <footer className="mx-auto max-w-6xl px-5 pb-8 text-center text-[11px] leading-relaxed md:px-8" style={{ color: 'var(--color-mut)' }}>
          {t('common.disclaimer')}
        </footer>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
