import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { logout, trpc } from '../api.js';
import { Loading, PageHeader, Panel } from '../components/ui.js';
import { LANGUAGES, setLanguage, storedLanguage, type LanguageCode } from '../i18n/index.js';

/** Profil (09_ §3.11): Konto, Sprache, Sitzung — ein User-Typ, keine Rollen/Tiers. */

type Me = Awaited<ReturnType<typeof trpc.auth.me.query>>;

export function Profil() {
  const { t } = useTranslation();
  const [me, setMe] = useState<Me | null>(null);
  const [lang, setLang] = useState<LanguageCode>(storedLanguage());

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
                  <span className="num">{new Date(me.createdAt as string).toLocaleDateString()}</span>
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
                  style={
                    lang === l.code
                      ? {
                          borderColor: 'rgba(79,209,255,0.5)',
                          color: 'var(--color-ink)',
                          background: 'linear-gradient(92deg, rgba(46,124,246,0.2), rgba(139,92,246,0.14))',
                          boxShadow: '0 0 16px rgba(46,124,246,0.2)',
                        }
                      : { borderColor: 'var(--color-line)', color: 'var(--color-mut)' }
                  }
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
              style={{ borderColor: 'rgba(255,92,108,0.4)', color: 'var(--color-neg)' }}
            >
              {t('profile.logoutAll')}
            </button>
            <p className="mt-4 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
              {t('profile.apiKeys')}
            </p>
          </Panel>
        </div>
      </section>
    </div>
  );
}
