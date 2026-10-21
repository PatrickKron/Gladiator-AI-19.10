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
import { AREAS, pageForHash, subnavPages, type AreaId } from '../lib/navigation.js';
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
 * Feed-Status; Einfach/Profi, Session, Sprache und Abmelden nur auf dem Desktop
 * (auf dem Handy im Profil).
 */

const ico = (d: string, cls = 'h-[17px] w-[17px]') => (
  <svg viewBox="0 0 24 24" className={`${cls} shrink-0`} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

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

function LanguageSwitch() {
  const { i18n } = useTranslation();
  const lang: LanguageCode = LANGUAGES.some((l) => l.code === i18n.language) ? (i18n.language as LanguageCode) : storedLanguage();
  return (
    <select
      value={lang}
      onChange={(e) => setLanguage(e.target.value as LanguageCode)}
      className="field hidden cursor-pointer px-2 py-1 text-xs uppercase lg:block"
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
      {/* Seitenleiste (Desktop): fünf Bereiche */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col gap-6 overflow-y-auto border-r px-3 py-5 lg:flex" style={{ borderColor: 'var(--color-line)', background: 'var(--color-bg)' }}>
        <a href="#/" className="wordmark px-3 text-sm">
          GLADIATOR
        </a>
        <nav className="areanav flex flex-col gap-0.5" aria-label={t('nav.modeLabel')}>
          {areaLinks('side')}
        </nav>
        <div className="mt-auto flex flex-col gap-3 px-3">
          <span className="chip chip--acc w-fit">{t('common.paper')}</span>
          <p className="label">v3 · {t('nav.calm')}</p>
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
          </div>
        </header>

        {/* Seiten des Bereichs als Segmente */}
        {areaPages.length + morePages.length > 1 && (
          <div className="mx-auto max-w-6xl px-4 pt-3 md:px-6">
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

        <main className="mx-auto max-w-6xl px-4 pt-5 pb-6 md:px-6">{children}</main>
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
