import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';

/**
 * Lagebild (Welle C): EIN Streifen über der Marktlage — Globaler Regime-Score
 * als Ampel-Chip mit Wort und einem Satz. Nur echte Werte; ohne synchronisierte
 * Serien ehrlich „nicht verbunden".
 */
type Macro = Awaited<ReturnType<typeof trpc.market.macro.query>>;

export function RegimeStrip() {
  const { t } = useTranslation();
  const [macro, setMacro] = useState<Macro | null | undefined>(undefined);
  useEffect(() => {
    void trpc.market.macro.query().then(setMacro).catch(() => setMacro(null));
  }, []);
  const grs = macro?.grs ?? null;
  const tone = grs ? (grs.label === 'risk-on' ? 'pos' : grs.label === 'risk-off' ? 'neg' : 'warn') : 'mut';
  const color = tone === 'pos' ? 'var(--color-pos)' : tone === 'neg' ? 'var(--color-neg)' : tone === 'warn' ? 'var(--color-warn)' : 'var(--color-mut)';
  return (
    <div className="glass mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <span className="num text-3xl font-bold tracking-tight" style={{ color }}>
        {macro === undefined ? '…' : grs ? Math.round(grs.score) : '—'}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {t('oracle.grs')}{' '}
          {grs ? <span className={`chip chip--${tone} ml-1`}>{t(`regimeStrip.${grs.label}`)}</span> : macro !== undefined ? <span className="chip chip--mut ml-1">{t('common.notConnected')}</span> : null}
        </p>
        <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
          {grs ? t(`regimeStrip.hint_${grs.label}`) : macro === undefined ? t('common.loading') : t('oracle.syncPending')}
        </p>
      </div>
    </div>
  );
}
