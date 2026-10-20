import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, ErrorBox, Loading, fmtNum } from './ui.js';

/**
 * „Was wäre passiert?" (Signale-Seite): abgelaufene Signale, mit derselben
 * Backtest-Engine auf den echten Kerzen danach nachgerechnet — netto, aber
 * HYPOTHETISCH (ehrlich so beschriftet). Lädt erst beim Aufklappen, weil die
 * Rechnung je Signal Kerzen liest.
 */

type Hindsight = Awaited<ReturnType<typeof trpc.signals.hindsight.query>>;

const fmtR = (r: number) => `${r >= 0 ? '+' : ''}${fmtNum(r, 2)} R`;

export function HindsightPanel() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Hindsight | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && data === null) {
      try {
        setData(await trpc.signals.hindsight.query({ limit: 200 }));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('common.error'));
      }
    }
  }

  const s = data?.summary;
  const reason = (r: string | null) => (r ? t(`hindsight.reason_${r}`) : t('hindsight.stillOpen'));

  return (
    <div className="glass mb-5 p-4">
      <button type="button" className="flex w-full items-center justify-between gap-3 text-left" onClick={() => void toggle()} aria-expanded={open}>
        <span>
          <span className="label block">{t('hindsight.title')}</span>
          <span className="text-sm" style={{ color: 'var(--color-mut)' }}>
            {t('hindsight.teaser')}
          </span>
        </span>
        <span className="text-xs" style={{ color: 'var(--color-mut)' }}>
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div className="mt-4">
          {error && <ErrorBox message={error} />}
          {!error && data === null && <Loading />}
          {s && s.total === 0 && <Empty text={t('hindsight.none')} />}
          {s && s.total > 0 && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label={t('hindsight.evaluated')} value={`${s.closed} / ${s.total}`} />
                <Stat label={t('hindsight.winRate')} value={s.winRate === null ? '—' : `${fmtNum(s.winRate * 100, 0)} %`} />
                <Stat
                  label={t('hindsight.expectancy')}
                  value={s.expectancyR === null ? '—' : fmtR(s.expectancyR)}
                  tone={s.expectancyR === null ? undefined : s.expectancyR >= 0 ? 'pos' : 'neg'}
                />
                <Stat
                  label={t('hindsight.sumR')}
                  value={s.closed === 0 ? '—' : fmtR(s.sumR)}
                  tone={s.closed === 0 ? undefined : s.sumR >= 0 ? 'pos' : 'neg'}
                />
              </div>
              <p className="mt-2 text-xs" style={{ color: 'var(--color-mut)' }}>
                {t('hindsight.counts', { wins: s.wins, losses: s.losses, open: s.open, noData: s.noData })}
                {s.profitFactor !== null && <> · PF {fmtNum(s.profitFactor, 2)}</>}
              </p>
              <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto pr-1 text-sm">
                {data!.items
                  .filter((i) => i.status !== 'no_data')
                  .slice(0, 50)
                  .map((i) => (
                    <li key={i.signalId} className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-1.5" style={{ borderColor: 'var(--color-line)' }}>
                      <span>
                        <span className="num font-medium">{i.symbol}</span>{' '}
                        <span style={{ color: 'var(--color-mut)' }}>
                          {i.timeframe} · {i.direction === 'long' ? 'Long' : 'Short'} · {new Date(i.createdAt).toLocaleDateString(i18n.language)}
                        </span>
                      </span>
                      <span className="num text-xs" style={{ color: i.rMultiple === null ? 'var(--color-mut)' : i.rMultiple >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                        {i.rMultiple === null ? '—' : fmtR(i.rMultiple)} · {reason(i.exitReason)}
                      </span>
                    </li>
                  ))}
              </ul>
            </>
          )}
          <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
            {t('hindsight.method')}
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' }) {
  return (
    <div className="rounded border px-3 py-2" style={{ borderColor: 'var(--color-line)' }}>
      <p className="label">{label}</p>
      <p className="num text-lg" style={tone ? { color: tone === 'pos' ? 'var(--color-pos)' : 'var(--color-neg)' } : undefined}>
        {value}
      </p>
    </div>
  );
}
