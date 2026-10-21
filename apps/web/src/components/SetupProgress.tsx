import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { requestRainBurst } from '../lib/effects.js';
import { hideSetup, isSetupHidden, nextStep, progressMoment, readLastDone, SETUP_STEP_LINKS, writeLastDone } from '../lib/setup-progress.js';

type Progress = Awaited<ReturnType<typeof trpc.setup.progress.query>>;

/**
 * „Dein Start — n von 5" (Welle F): Einrichtungs-Fortschritt aus echten Zuständen
 * (Server: setup.progress). Der erste offene Schritt ist die Aktion, erledigte
 * Schritte bekommen einen Haken; ein neu erledigter Schritt löst den Regen-Impuls
 * aus (Erfolgsmoment). „Ausblenden" ist eine Ansichts-Wahl im Browser.
 * Ohne Antwort vom Server gibt es keine Karte — nichts wird geraten.
 */
export function SetupProgress() {
  const { t } = useTranslation();
  const [hidden, setHidden] = useState(isSetupHidden);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [barWidth, setBarWidth] = useState(0);

  useEffect(() => {
    if (hidden) return;
    let cancelled = false;
    (async () => {
      try {
        const p = await trpc.setup.progress.query();
        if (cancelled) return;
        if (progressMoment(readLastDone(), p.done)) requestRainBurst('pos');
        writeLastDone(p.done);
        setProgress(p);
      } catch {
        if (!cancelled) setProgress(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hidden]);

  // Balken füllt sich nach dem Einblenden (Moment, nicht Effekt) — reduced-motion: CSS ohne Übergang.
  useEffect(() => {
    if (!progress) return;
    const id = requestAnimationFrame(() => setBarWidth(progress.total === 0 ? 0 : progress.done / progress.total));
    return () => cancelAnimationFrame(id);
  }, [progress]);

  if (hidden || !progress) return null;
  const next = nextStep(progress.steps);
  const complete = next === null;

  return (
    <section className="glass reveal mt-6 p-4 sm:p-5" style={{ '--stagger': 1 } as React.CSSProperties} aria-label={t('setup.title')}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">{complete ? t('setup.doneTitle') : t('setup.title')}</h2>
        <span className="num text-xs" style={{ color: complete ? 'var(--color-pos)' : 'var(--color-mut)' }}>
          {t('setup.count', { n: progress.done, total: progress.total })}
        </span>
      </div>
      <div className="setup-bar mt-2.5" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
        <span style={{ width: `${barWidth * 100}%` }} />
      </div>
      <ol className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {progress.steps.map((s) => (
          <li key={s.id} className="flex min-h-8 items-center gap-2.5 text-sm">
            <span className={`setup-dot${s.done ? ' setup-dot--done' : ''}`} aria-hidden="true">
              {s.done ? '✓' : ''}
            </span>
            {s.done ? (
              <span style={{ color: 'var(--color-mut)' }}>{t(`setup.step_${s.id}`)}</span>
            ) : s.id === next ? (
              <a href={SETUP_STEP_LINKS[s.id]} className="btn px-3 py-1 text-[13px]">
                {t(`setup.step_${s.id}`)} <span aria-hidden="true">→</span>
              </a>
            ) : (
              <a href={SETUP_STEP_LINKS[s.id]} className="hover:underline">
                {t(`setup.step_${s.id}`)}
              </a>
            )}
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
          {next ? t(`setup.hint_${next}`) : t('setup.doneHint')}
        </p>
        <button
          type="button"
          className="text-xs"
          style={{ color: 'var(--color-mut)' }}
          onClick={() => {
            hideSetup();
            setHidden(true);
          }}
        >
          {t('setup.hide')}
        </button>
      </div>
    </section>
  );
}
