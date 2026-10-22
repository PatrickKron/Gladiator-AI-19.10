import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { VIEW_PREFERENCE_KEYS } from '../lib/hotkeys.js';
import { changePassword, logout, trpc } from '../api.js';
import { Loading, PageHeader, Panel } from '../components/ui.js';
import { LANGUAGES, setLanguage, storedLanguage, type LanguageCode } from '../i18n/index.js';
import { appLocale } from '../lib/locale.js';
import { HotkeyHelpButton, UiModeToggle } from '../components/Shell.js';
import { getEffectPrefs, onEffectPrefs, requestRainBurst, setEffectPrefs, type EffectPrefs } from '../lib/effects.js';

/** Profil (09_ §3.11): Konto, Sprache, Sitzung — ein User-Typ, keine Rollen/Tiers. */

type Me = Awaited<ReturnType<typeof trpc.auth.me.query>>;

export function Profil() {
  const { t } = useTranslation();
  const [me, setMe] = useState<Me | null>(null);
  const [lang, setLang] = useState<LanguageCode>(storedLanguage());
  const [pw, setPw] = useState({ current: '', next: '', repeat: '' });
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submitPassword() {
    if (pw.next !== pw.repeat) {
      setPwMsg({ ok: false, text: t('profile.pwMismatch') });
      return;
    }
    setPwBusy(true);
    setPwMsg(null);
    try {
      await changePassword(pw.current, pw.next);
      setPw({ current: '', next: '', repeat: '' });
      setPwMsg({ ok: true, text: t('profile.pwChanged') });
    } catch (err) {
      setPwMsg({ ok: false, text: err instanceof Error ? err.message : t('common.error') });
    } finally {
      setPwBusy(false);
    }
  }

  useEffect(() => {
    void trpc.auth.me.query().then(setMe).catch(() => setMe(null));
  }, []);

  return (
    <div>
      <PageHeader title={t('profile.title')} subtitle={t('profile.subtitle')} />

      <section className="grid gap-5 lg:grid-cols-2">
        <Panel label={t('profile.account')} stagger={1}>
          {me === null ? (
            <Loading />
          ) : (
            <ul className="mt-4 space-y-2.5 text-sm">
              <li className="flex justify-between gap-3">
                <span style={{ color: 'var(--color-mut)' }}>{t('profile.email')}</span>
                <span className="num">{me.email}</span>
              </li>
              <li className="flex justify-between gap-3">
                <span style={{ color: 'var(--color-mut)' }}>{t('profile.name')}</span>
                <span>{me.name ?? '—'}</span>
              </li>
              {'createdAt' in me && me.createdAt != null && (
                <li className="flex justify-between gap-3">
                  <span style={{ color: 'var(--color-mut)' }}>{t('profile.memberSince')}</span>
                  <span className="num">{new Date(me.createdAt as string).toLocaleDateString(appLocale())}</span>
                </li>
              )}
            </ul>
          )}
          <p className="mt-5 rounded-[0.625rem] border border-dashed p-3 text-xs leading-relaxed" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
            {t('profile.oneUser')}
          </p>
        </Panel>

        <div className="space-y-5">
          <Panel label={t('profile.languageTitle')} stagger={2}>
            <div className="mt-4 flex flex-wrap gap-2">
              {LANGUAGES.map((l) => (
                <button
                  key={l.code}
                  onClick={() => {
                    setLang(l.code);
                    setLanguage(l.code);
                  }}
                  className="rounded-[0.625rem] border px-3.5 py-2 text-sm transition-all"
                  style={lang === l.code ? { borderColor: 'var(--color-blue)', color: 'var(--color-ink)', background: 'rgba(59,130,246,0.14)' } : { borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
                >
                  {l.label}
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs" style={{ color: 'var(--color-mut)' }}>
              {t('profile.languageHint')}
            </p>
          </Panel>

          <Panel label={t('profile.sessionTitle')} stagger={3}>
            <button
              onClick={() => void logout()}
              className="mt-4 rounded-[0.625rem] border px-4 py-2 text-sm transition-colors"
              style={{ borderColor: 'rgba(239,68,68,0.4)', color: 'var(--color-neg)' }}
            >
              {t('profile.logoutAll')}
            </button>
            <p className="mt-4 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
              {t('profile.apiKeys')}
            </p>
          </Panel>

          <Panel label={t('profile.pwTitle')} stagger={4}>
            <div className="mt-4 grid gap-3">
              {(['current', 'next', 'repeat'] as const).map((k) => (
                <label key={k} className="flex flex-col gap-1">
                  <span className="label">{t(`profile.pw_${k}`)}</span>
                  <input
                    className="field w-full px-3 py-2 text-sm"
                    type="password"
                    autoComplete={k === 'current' ? 'current-password' : 'new-password'}
                    value={pw[k]}
                    onChange={(e) => setPw((p) => ({ ...p, [k]: e.target.value }))}
                  />
                </label>
              ))}
            </div>
            <button
              className="btn mt-3"
              disabled={pwBusy || !pw.current || pw.next.length < 10 || !pw.repeat}
              onClick={() => void submitPassword()}
            >
              {t('profile.pwSave')}
            </button>
            {pwMsg && (
              <p className="mt-2 text-sm" style={{ color: pwMsg.ok ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                {pwMsg.text}
              </p>
            )}
            <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
              {t('profile.pwHint')}
            </p>
          </Panel>
          <Panel label={t('profile.viewTitle')} stagger={5}>
            <div className="mt-4">
              <UiModeToggle className="flex w-fit" />
            </div>
            <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
              {t('profile.viewHint')} {t('profile.viewSimpleHint')}
            </p>
            <div className="mt-4">
              <HotkeyHelpButton />
            </div>
          </Panel>
          <EffectsPanel />
          <ViewResetPanel />
          <AboutPanel />
        </div>
      </section>
    </div>
  );
}

/** Ansicht zurücksetzen (UI-Welle 5): nur Ansichts-Merker im Browser — Daten und Anmeldung bleiben. */
function ViewResetPanel() {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  return (
    <Panel label={t('profile.resetTitle')} stagger={7}>
      <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('profile.resetHint')}
      </p>
      <button
        className="btn mt-3"
        onClick={() => {
          for (const k of VIEW_PREFERENCE_KEYS) {
            try {
              localStorage.removeItem(k);
            } catch {
              // ohne localStorage gibt es nichts zurückzusetzen
            }
          }
          setDone(true);
          window.setTimeout(() => window.location.reload(), 600);
        }}
      >
        {t('profile.resetButton')}
      </button>
      {done && <p className="mt-2 text-sm" style={{ color: 'var(--color-pos)' }}>{t('profile.resetDone')}</p>}
    </Panel>
  );
}

/** Special-Effekte (Design-System v3): wo der Daten-Regen aus echten Kursen auftaucht. */
function EffectsPanel() {
  const { t } = useTranslation();
  const [prefs, setPrefs] = useState<EffectPrefs>(() => getEffectPrefs());
  useEffect(() => onEffectPrefs(setPrefs), []);
  const rows: { key: keyof EffectPrefs; label: string; hint: string }[] = [
    { key: 'loginRain', label: t('effects.loginRain'), hint: t('effects.loginRainHint') },
    { key: 'eventRain', label: t('effects.eventRain'), hint: t('effects.eventRainHint') },
    { key: 'screensaver', label: t('effects.screensaver'), hint: t('effects.screensaverHint') },
    { key: 'ambientRain', label: t('effects.ambientRain'), hint: t('effects.ambientRainHint') },
  ];
  return (
    <Panel label={t('effects.title')} stagger={6}>
      <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('effects.intro')}
      </p>
      <ul className="mt-4 space-y-3">
        {rows.map((r) => (
          <li key={r.key} className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm">{r.label}</p>
              <p className="mt-0.5 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
                {r.hint}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={prefs[r.key]}
              aria-label={r.label}
              onClick={() => setPrefs(setEffectPrefs({ [r.key]: !prefs[r.key] }))}
              className="relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors"
              style={{ background: prefs[r.key] ? 'var(--color-blue)' : 'var(--color-bg3)', border: '1px solid var(--color-line2)' }}
            >
              <span className="absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white transition-transform" style={{ left: 2, transform: prefs[r.key] ? 'translateX(20px)' : 'translateX(0)' }} />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn mt-4" onClick={() => requestRainBurst('accent', 'BTC/USDT')} disabled={!prefs.eventRain}>
        {t('effects.preview')}
      </button>
    </Panel>
  );
}

/** Lizenz-Nennung (Patrick 2026-10-22: kein Logo im Chart — die Nennung der Chart-Bibliothek steht hier). */
function AboutPanel() {
  const { t } = useTranslation();
  return (
    <Panel label={t('profile.aboutTitle')} stagger={8}>
      <p className="text-sm" style={{ color: 'var(--color-mut)' }}>{t('profile.aboutVersion')}</p>
      <p className="mt-2 text-sm" style={{ color: 'var(--color-mut)' }}>
        {t('profile.aboutCharts')}{' '}
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer" className="underline">
          TradingView Lightweight Charts™
        </a>{' '}
        (Apache 2.0) · {t('profile.aboutIndicators')}
      </p>
    </Panel>
  );
}
