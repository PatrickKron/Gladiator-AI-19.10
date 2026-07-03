import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, Loading, PageHeader, Panel } from '../components/ui.js';

/**
 * Makro-Kalender (09_ §3.7) — jetzt mit ECHTEM Feed (ForexFactory, Phase-1-
 * Rest): Events mit Impact-Rating, aktives No-Trade-Fenster (blockt die
 * Risk-Engine), plus die Session-Fenster der Engine (UTC).
 */

type Calendar = Awaited<ReturnType<typeof trpc.market.calendar.query>>;

const IMPACT_COLOR: Record<number, string> = { 3: 'var(--color-neg)', 2: 'var(--color-warn)', 1: 'var(--color-mut)' };

const SESSIONS = [
  { key: 'calendar.sessionAsia', from: 0, to: 7 },
  { key: 'calendar.sessionLondon', from: 7, to: 13 },
  { key: 'calendar.sessionOverlap', from: 13, to: 16 },
  { key: 'calendar.sessionNewyork', from: 16, to: 21 },
  { key: 'calendar.sessionOff', from: 21, to: 24 },
];

export function Kalender() {
  const { t } = useTranslation();
  const hourUtc = new Date().getUTCHours();
  const [calendar, setCalendar] = useState<Calendar | null>(null);

  useEffect(() => {
    void trpc.market.calendar.query({ days: 7 }).then(setCalendar).catch(() => setCalendar(null));
  }, []);

  return (
    <div>
      <PageHeader title={t('calendar.title')} subtitle={t('calendar.subtitle')} />

      {calendar?.noTrade && (
        <div
          className="glass reveal mb-5 p-4 text-sm leading-relaxed"
          style={{ borderColor: 'rgba(255,92,108,0.5)', color: 'var(--color-neg)', boxShadow: '0 0 24px rgba(255,92,108,0.15)' }}
        >
          ⚠ {t('calendar.noTradeActive', { reason: calendar.noTrade.reason })}
        </div>
      )}

      <Panel label={t('calendar.eventsTitle')} stagger={1}>
        {calendar === null ? (
          <Loading />
        ) : calendar.events.length === 0 ? (
          <Empty text={t('calendar.noEvents')} />
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="label text-left">
                  <th className="py-1.5 pr-3 font-normal">{t('common.date')}</th>
                  <th className="py-1.5 pr-3 font-normal">{t('calendar.impact')}</th>
                  <th className="py-1.5 pr-3 font-normal">Event</th>
                  <th className="py-1.5 pr-3 font-normal" />
                  <th className="py-1.5 pr-3 text-right font-normal">{t('calendar.forecast')}</th>
                  <th className="py-1.5 text-right font-normal">{t('calendar.previous')}</th>
                </tr>
              </thead>
              <tbody>
                {calendar.events.map((e) => (
                  <tr key={e.id} style={{ borderTop: '1px solid rgba(99,140,255,0.08)', opacity: (e.importance ?? 0) >= 3 ? 1 : 0.75 }}>
                    <td className="num py-1.5 pr-3 whitespace-nowrap">
                      {new Date(e.scheduledAt).toLocaleString(undefined, { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{
                          background: IMPACT_COLOR[e.importance ?? 1],
                          boxShadow: (e.importance ?? 0) >= 3 ? '0 0 8px rgba(255,92,108,0.8)' : 'none',
                        }}
                        title={String(e.importance ?? '—')}
                      />
                    </td>
                    <td className="py-1.5 pr-3">{e.title}</td>
                    <td className="label py-1.5 pr-3">{e.currency}</td>
                    <td className="num py-1.5 pr-3 text-right" style={{ color: 'var(--color-mut)' }}>
                      {e.forecast ?? '—'}
                    </td>
                    <td className="num py-1.5 text-right" style={{ color: 'var(--color-mut)' }}>
                      {e.previous ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
          {t('calendar.noTradeInfo')}
        </p>
      </Panel>

      <Panel label={t('calendar.sessionsTitle')} stagger={2} className="mt-5">
        <div className="mt-4 space-y-2">
          {SESSIONS.map((s) => {
            const active = hourUtc >= s.from && hourUtc < s.to;
            const width = ((s.to - s.from) / 24) * 100;
            const left = (s.from / 24) * 100;
            return (
              <div key={s.key} className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-sm" style={{ color: active ? 'var(--color-ink)' : 'var(--color-mut)' }}>
                  {t(s.key)}
                </span>
                <div className="relative h-6 flex-1 rounded" style={{ background: 'rgba(10,13,36,0.6)', border: '1px solid var(--color-line)' }}>
                  <div
                    className="absolute inset-y-0 rounded"
                    style={{
                      left: `${left}%`,
                      width: `${width}%`,
                      background: active
                        ? 'linear-gradient(92deg, rgba(46,124,246,0.5), rgba(139,92,246,0.4))'
                        : 'rgba(99,140,255,0.15)',
                      boxShadow: active ? '0 0 18px rgba(46,124,246,0.35)' : 'none',
                    }}
                  />
                  {/* Jetzt-Markierung */}
                  <div
                    className="absolute inset-y-0 w-px"
                    style={{ left: `${((hourUtc + new Date().getUTCMinutes() / 60) / 24) * 100}%`, background: 'var(--color-cyan)', boxShadow: '0 0 8px rgba(79,209,255,0.9)' }}
                  />
                </div>
                <span className="num w-28 shrink-0 text-right text-xs" style={{ color: 'var(--color-mut)' }}>
                  {String(s.from).padStart(2, '0')}:00–{String(s.to).padStart(2, '0')}:00
                  {active ? ` · ${t('calendar.nowActive')}` : ''}
                </span>
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}
