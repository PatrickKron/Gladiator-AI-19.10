import { useTranslation } from 'react-i18next';
import { NotConnected, PageHeader, Panel } from '../components/ui.js';

/**
 * Makro-Kalender (09_ §3.7): der Kalender-Feed ist noch nicht angebunden —
 * ehrlich „nicht verbunden", KEINE erfundenen Termine (Regel 1).
 * Echt heute: die Session-Fenster der Engine (UTC), inkl. Live-Markierung.
 */

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

  return (
    <div>
      <PageHeader title={t('calendar.title')} subtitle={t('calendar.subtitle')} />

      <Panel stagger={1}>
        <NotConnected detail={t('calendar.disconnected')} />
        <p className="mt-4 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
          {t('calendar.planned')}
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
