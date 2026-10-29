import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { logout, trpc } from '../api.js';
import { NotificationBell } from './NotificationBell.js';
import { AssistantPanel } from './AssistantPanel.js';
import { ensurePriceStream, getFeedState, onFeedState, type FeedState } from '../lib/prices.js';
import { LANGUAGES, setLanguage, storedLanguage, type LanguageCode } from '../i18n/index.js';
import { isDemoMode, onDemoModeChange } from '../lib/demo-mode.js';
import { getUiMode, onUiModeChange, setUiMode, type UiMode } from '../lib/ui-mode.js';
import { currentSessionEnd, nextSessionStart, sessionAt, type MarketSession } from '../lib/market-session.js';
import { CommandPalette } from './CommandPalette.js';
import { AREAS, pageForHash, sidebarGroups, subnavPages, tabForHash, type AreaId } from '../lib/navigation.js';
import { GOTO_KEYS, MATRIX_KEY, resolveHotkey } from '../lib/hotkeys.js';
import { getEffectPrefs, setEffectPrefs } from '../lib/effects.js';
import { isTypingTarget } from '../lib/watchlist.js';
import { clearVisibleInterval, setVisibleInterval } from '../lib/visible-interval.js';

/**
 * App-Shell (Design-System v3): FÜNF Bereiche — Heute · Markt · Traden ·
 * Strategie · Mehr — als Seitenleiste (Desktop) und Tableiste (Handy). Die
 * Seiten eines Bereichs stehen als Segmente über dem Inhalt. Alles kommt aus
 * der Funktions-Registry (lib/navigation.ts); kein Link ändert sich.
 * Kopfzeile: Paper-/Demo-/Kill-Switch-Kennzeichen, Suche, Benachrichtigungen,
 * Feed-Status; Einfach/Profi, Session, Sprache und Abmelden direkt auf dem Desktop,
 * auf Handy/Tablet über das Kopfzeilen-Menü (⋮) — zusätzlich weiter im Profil.
 */

const ico = (d: string, cls = 'h-[17px] w-[17px]') => (
  <svg viewBox="0 0 24 24" className={`${cls} shrink-0`} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);


/** Brotkrumen (v2): Bereich › Seite › Tab — immer sichtbar, wo man gerade ist. */
function Breadcrumb({ route }: { route: string }) {
  const { t } = useTranslation();
  const page = pageForHash(route);
  if (!page || page.id === 'today') return null;
  const area = AREAS.find((a) => a.id === page.area);
  const tab = tabForHash(page, route);
  return (
    <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap items-center gap-1.5 text-xs" style={{ color: 'var(--color-mut)' }}>
      <a href="#/" className="hover:underline">{t('ia.page_today')}</a>
      <span aria-hidden="true">›</span>
      {area && <span>{t(area.labelKey)}</span>}
      {area && <span aria-hidden="true">›</span>}
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
    <span className="num text-xs" style={{ color: map[feed].color }} title={feed}>
      {map[feed].text}
    </span>
  );
}

/** Welche Handels-Session läuft gerade? Badge mit Ende/nächstem Start (minütlich). */
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
    <span className={`chip hidden md:inline-flex ${active ? 'chip--pos' : 'chip--mut'}`} title={title}>
      {t(`session.${session}`)}
    </span>
  );
}

function LanguageSwitch({ className = 'hidden lg:block' }: { className?: string }) {
  const { i18n } = useTranslation();
  const lang: LanguageCode = LANGUAGES.some((l) => l.code === i18n.language) ? (i18n.language as LanguageCode) : storedLanguage();
  return (
    <select
      value={lang}
      onChange={(e) => setLanguage(e.target.value as LanguageCode)}
      className={`field cursor-pointer px-2 py-1 text-xs uppercase ${className}`}
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

/**
 * Kopfzeilen-Menü für Handy/Tablet (unter lg): Einfach/Profi, Sprache, Profil, Abmelden —
 * auf dem Desktop stehen diese direkt in der Kopfzeile. Ein Knopf breit, damit 390 px nicht überlaufen.
 * Schließt bei Seitenwechsel, Klick daneben und Esc.
 */
function HeaderMenu({ route }: { route: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setOpen(false), [route]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative lg:hidden">
      <button
        id="header-menu-button"
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center rounded-[0.625rem] border px-2 py-1.5 text-xs transition-colors"
        style={{ borderColor: open ? 'var(--color-blue)' : 'var(--color-line)', color: open ? 'var(--color-ink)' : 'var(--color-mut)' }}
        title={t('nav.headerMenu')}
        aria-label={t('nav.headerMenu')}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="header-menu"
      >
        {ico('M12 5.5h.01M12 12h.01M12 18.5h.01', 'h-[17px] w-[17px]')}
      </button>
      {open && (
        <div id="header-menu" className="glass absolute top-full right-0 z-40 mt-2 flex w-60 max-w-[calc(100vw-2rem)] flex-col gap-3 p-3" aria-label={t('nav.headerMenu')}>
          <div className="flex flex-col gap-1.5">
            <span className="label">{t('nav.modeLabel')}</span>
            <UiModeToggle className="flex w-fit" />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="label">{t('profile.languageTitle')}</span>
            <LanguageSwitch className="block w-full" />
          </div>
          <div className="flex items-center justify-between gap-3 border-t pt-3" style={{ borderColor: 'var(--color-line)' }}>
            <a href="#/profil" className="text-sm hover:underline" style={{ color: 'var(--color-ink)' }}>
              {t('ia.page_profile')}
            </a>
            <button id="header-menu-logout" type="button" onClick={() => void logout()} className="text-sm transition-colors" style={{ color: 'var(--color-neg)' }}>
              {t('common.logout')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Einfach/Profi: verlustfrei, sofort reversibel — steuert nur die Detailtiefe innerhalb der Seiten. */
export function UiModeToggle({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  const [uiMode, setUiModeState] = useState<UiMode>(() => getUiMode());
  useEffect(() => onUiModeChange(() => setUiModeState(getUiMode())), []);
  return (
    <div className={`overflow-hidden rounded-[0.625rem] border text-xs ${className}`} style={{ borderColor: 'var(--color-line)' }} role="group" aria-label={t('nav.modeLabel')}>
      {(['einfach', 'profi'] as const).map((m) => (
        <button
          key={m}
          onClick={() => setUiMode(m)}
          className="px-2.5 py-1.5 transition-colors"
          style={uiMode === m ? { background: 'rgba(59,130,246,0.18)', color: 'var(--color-ink)' } : { color: 'var(--color-mut)' }}
          title={t(m === 'einfach' ? 'nav.modeSimpleHint' : 'nav.modeProHint')}
          aria-pressed={uiMode === m}
        >
          {t(m === 'einfach' ? 'nav.modeSimple' : 'nav.modePro')}
        </button>
      ))}
    </div>
  );
}

export function Shell({ route, children }: { route: string; children: ReactNode }) {
  const { t } = useTranslation();
  const [killSwitch, setKillSwitch] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatPrefill, setChatPrefill] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [demoMode, setDemoModeState] = useState(() => isDemoMode());
  const [uiMode, setUiModeState] = useState<UiMode>(() => getUiMode());
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => onDemoModeChange(setDemoModeState), []);
  useEffect(() => onUiModeChange(() => setUiModeState(getUiMode())), []);
  useEffect(() => setMoreOpen(false), [route]);

  // Command-Palette: global per Cmd/Ctrl+K öffnen.
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

  // Tastenkürzel: g + Buchstabe springt, g m schaltet den Matrix-Modus, ? zeigt die Hilfe, / öffnet die Suche.
  // Chat von überall öffnen (z. B. Leer-Zustand im Workshop): window.dispatchEvent(new CustomEvent('gladiator:chat', { detail: { prefill } }))
  useEffect(() => {
    const onOpen = (e: Event) => {
      setChatPrefill((e as CustomEvent<{ prefill?: string }>).detail?.prefill ?? null);
      setChatOpen(true);
    };
    window.addEventListener('gladiator:chat', onOpen);
    return () => window.removeEventListener('gladiator:chat', onOpen);
  }, []);

  useEffect(() => {
    let pendingSince: number | null = null;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target as HTMLElement | null)) return;
      if (e.key === 'Escape') {
        setHelpOpen(false);
        return;
      }
      const action = resolveHotkey(e.key, pendingSince, Date.now());
      pendingSince = action?.type === 'pending' ? Date.now() : null;
      if (!action || action.type === 'pending') return;
      e.preventDefault();
      if (action.type === 'goto') window.location.hash = action.hash;
      else if (action.type === 'help') setHelpOpen((o) => !o);
      else if (action.type === 'matrix') setEffectPrefs({ ambientRain: !getEffectPrefs().ambientRain });
      else setPaletteOpen(true);
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
  const activePage = pageForHash(activeHash);
  const activeArea: AreaId = activePage?.area ?? 'today';
  // Einfach-Modus (Welle F): Profi-Seiten des Bereichs stehen hinter „Mehr" — nichts fehlt, kein Link ändert sich.
  const { shown: areaPages, more: morePages } = useMemo(() => subnavPages(activeArea, uiMode, activeHash), [activeArea, uiMode, activeHash]);
  // Seitenleiste wie v2: jede Seite direkt (Patrick 2026-10-24), gruppiert nach den fünf Bereichen.
  const sideGroups = useMemo(() => sidebarGroups(uiMode, activeHash), [uiMode, activeHash]);

  const areaLinks = (variant: 'side' | 'tab') =>
    AREAS.map((area) => {
      const current = area.id === activeArea;
      return (
        <a key={area.id} href={area.hash} aria-current={current ? 'page' : undefined} title={t(area.labelKey)}>
          {ico(area.icon, variant === 'tab' ? 'h-[22px] w-[22px]' : 'h-[18px] w-[18px]')}
          <span>{t(area.labelKey)}</span>
        </a>
      );
    });

  return (
    <div className="relative z-10 flex min-h-screen">
      {/* Seitenleiste (Desktop) wie v2: Bereiche als Gruppen, jede Seite ein Klick */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col gap-5 overflow-y-auto border-r px-3 py-5 lg:flex" style={{ borderColor: 'var(--color-line)', background: 'var(--color-bg)' }}>
        <a href="#/" className="wordmark px-3 text-sm">
          GLADIATOR
        </a>
        <nav className="areanav flex flex-col gap-4" aria-label={t('nav.sidebarLabel')}>
          {sideGroups.map(({ area, pages, hidden }) => (
            <div key={area.id} className="flex flex-col gap-0.5">
              <p className="label px-3 pb-1">{t(area.labelKey)}</p>
              {pages.map((p) => (
                <a key={p.hash} href={p.hash} aria-current={activeHash === p.hash ? 'page' : undefined} title={t(p.descKey)}>
                  {ico(p.icon, 'h-[16px] w-[16px]')}
                  <span>{t(p.labelKey)}</span>
                </a>
              ))}
              {hidden > 0 && (
                <button type="button" onClick={() => setUiMode('profi')} className="px-3 py-1 text-left text-[11px] transition-colors hover:text-[color:var(--color-ink)]" style={{ color: 'var(--color-mut)' }} title={t('nav.modeProHint')}>
                  ▸ {t('nav.proHint', { n: hidden })}
                </button>
              )}
            </div>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-3 px-3">
          <span className="chip chip--acc w-fit">{t('common.paper')}</span>
          <p className="label">v2 · {t('nav.calm')}</p>
        </div>
      </aside>

      <div className="min-w-0 flex-1 pb-20 lg:pb-0">
        {/* Kopfzeile: eine Zeile, auch auf dem Handy */}
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b px-4 py-2.5 md:px-6" style={{ borderColor: 'var(--color-line)', background: 'rgba(11,13,18,0.92)', backdropFilter: 'blur(10px)' }}>
          <div className="flex min-w-0 items-center gap-2">
            <a href="#/" className="wordmark text-sm lg:hidden">
              GLADIATOR
            </a>
            <span className="chip chip--acc lg:hidden">{t('common.paper')}</span>
            {demoMode && (
              <a href="#/traden?tab=demo" className="chip chip--warn" title={t('demo.badgeHint')}>
                {t('demo.badge')}
              </a>
            )}
            {killSwitch && (
              <a href="#/traden?tab=positionen" className="chip chip--neg">
                KILL-SWITCH
              </a>
            )}
            {activePage && activePage.id !== 'today' && (
              <span className="hidden text-sm font-medium lg:inline" style={{ color: 'var(--color-mut)' }}>
                {t(AREAS.find((a) => a.id === activeArea)!.labelKey)} · <span style={{ color: 'var(--color-ink)' }}>{t(activePage.labelKey)}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 sm:gap-3">
            <UiModeToggle className="hidden sm:flex" />
            <button
              onClick={() => setChatOpen((o) => !o)}
              className="flex items-center gap-1.5 rounded-[0.625rem] border px-2.5 py-1.5 text-xs transition-colors"
              style={{ borderColor: chatOpen ? 'var(--color-blue)' : 'var(--color-line)', color: chatOpen ? 'var(--color-ink)' : 'var(--color-mut)' }}
              title={t('assistant.button')}
              aria-label={t('assistant.button')}
              aria-pressed={chatOpen}
            >
              {ico('M21 12a8 8 0 01-8 8H8l-4 3v-3.5A8 8 0 1121 12z')}
              <span className="hidden md:inline">{t('assistant.button')}</span>
            </button>
            <button
              onClick={() => setPaletteOpen(true)}
              className="flex items-center gap-1.5 rounded-[0.625rem] border px-2.5 py-1.5 text-xs transition-colors"
              style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
              title={t('palette.button')}
              aria-label={t('palette.button')}
            >
              {ico('M21 21l-4.3-4.3M11 18a7 7 0 100-14 7 7 0 000 14z')}
              <span className="hidden md:inline">{t('palette.button')}</span>
              <span className="num label hidden lg:inline">⌘K</span>
            </button>
            <NotificationBell />
            <SessionBadge />
            <FeedBadge />
            <LanguageSwitch />
            <button onClick={() => void logout()} className="hidden text-sm transition-colors hover:text-[color:var(--color-ink)] lg:inline" style={{ color: 'var(--color-mut)' }}>
              {t('common.logout')}
            </button>
            <HeaderMenu route={route} />
          </div>
        </header>

        {/* Seiten des Bereichs als Segmente — nur ohne Seitenleiste (Handy/Tablet); am Desktop steht jede Seite links */}
        {areaPages.length + morePages.length > 1 && (
          <div className="mx-auto max-w-6xl px-4 pt-3 md:px-6 lg:hidden">
            <nav className="subnav" aria-label={t(AREAS.find((a) => a.id === activeArea)!.labelKey)}>
              {areaPages.map((p) => (
                <a key={p.hash} href={p.hash} aria-current={activeHash === p.hash ? 'page' : undefined} title={t(p.descKey)}>
                  {t(p.labelKey)}
                </a>
              ))}
              {morePages.length > 0 && (
                <button type="button" className="subnav-more" aria-expanded={moreOpen} aria-controls="subnav-more" onClick={() => setMoreOpen((o) => !o)}>
                  {t('nav.more')} <span aria-hidden="true">{moreOpen ? '▴' : '▾'}</span>
                </button>
              )}
            </nav>
            {morePages.length > 0 && moreOpen && (
              <nav id="subnav-more" className="subnav subnav--more mt-1.5" aria-label={t('nav.more')}>
                {morePages.map((p) => (
                  <a key={p.hash} href={p.hash} title={t(p.descKey)}>
                    {t(p.labelKey)}
                  </a>
                ))}
              </nav>
            )}
          </div>
        )}

        <main className="mx-auto max-w-6xl px-4 pt-5 pb-6 md:px-6">
          <Breadcrumb route={activeHash} />
          {children}
        </main>
        {/* Disclaimer (10_ §7 Abnahme): auf jeder Seite sichtbar */}
        <footer className="mx-auto max-w-6xl px-4 pb-8 text-center text-[11px] leading-relaxed md:px-6" style={{ color: 'var(--color-mut)' }}>
          {t('common.disclaimer')}
        </footer>
      </div>

      {/* Tableiste (Handy): fünf Bereiche in Daumen-Reichweite */}
      <nav className="tabbar lg:hidden" aria-label={t('nav.modeLabel')}>
        {areaLinks('tab')}
      </nav>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <AssistantPanel open={chatOpen} onClose={() => setChatOpen(false)} prefill={chatPrefill} />
      {helpOpen && <HotkeyHelp onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

/** Tastenkürzel-Hilfe als Knopf (Profil → Ansicht): auch ohne „?"-Taste und auf dem Handy erreichbar. */
export function HotkeyHelpButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn inline-flex items-center gap-2 px-3 py-1.5 text-sm" onClick={() => setOpen(true)}>
        {t('hotkeys.title')}
        <kbd className="mono rounded border px-1.5 py-0.5 text-[11px]" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
          ?
        </kbd>
      </button>
      {open && <HotkeyHelp onClose={() => setOpen(false)} />}
    </>
  );
}

/** Übersicht der Tastenkürzel („?“). */
function HotkeyHelp({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const rows: [string, string][] = [
    ...GOTO_KEYS.map((g) => [`g ${g.key}`, t(g.labelKey)] as [string, string]),
    [`g ${MATRIX_KEY}`, t('hotkeys.matrix')],
    ['/', t('hotkeys.search')],
    ['⌘K', t('hotkeys.search')],
    ['↑ ↓ · k j', t('hotkeys.watchlist')],
    ['?', t('hotkeys.help')],
    ['Esc', t('hotkeys.close')],
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(11,13,18,0.7)' }} onClick={onClose} role="dialog" aria-label={t('hotkeys.title')}>
      <div className="glass w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <p className="label">{t('hotkeys.title')}</p>
          <button type="button" className="text-xs" style={{ color: 'var(--color-mut)' }} onClick={onClose}>
            ✕
          </button>
        </div>
        <ul className="mt-3 space-y-1.5 text-sm">
          {rows.map(([k, label]) => (
            <li key={k} className="flex items-center justify-between gap-3">
              <span style={{ color: 'var(--color-mut)' }}>{label}</span>
              <kbd className="mono rounded border px-1.5 py-0.5 text-xs" style={{ borderColor: 'var(--color-line)' }}>
                {k}
              </kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
