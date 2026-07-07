import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, Loading, PageHeader, Panel } from '../components/ui.js';

/**
 * Makro-Kalender (09_ §3.7) — echte Kalender-Optik: Monats-/Wochen-Gitter aus
 * dem ForexFactory-Feed. Jedes Event ist SERVERSEITIG regelbasiert angereichert
 * (Kategorie, typisch reagierende Märkte, konkret betroffene Gladiator-Assets aus
 * dem echten Universum) — Impact-Farbcodierung hoch/mittel/niedrig. Kein Fake:
 * leere Tage bleiben leer; nur real geladene Assets erscheinen.
 */

type Calendar = Awaited<ReturnType<typeof trpc.market.calendar.query>>;
type CalEvent = Calendar['events'][number];

const IMPACT_COLOR: Record<number, string> = { 3: 'var(--color-neg)', 2: 'var(--color-warn)', 1: 'var(--color-mut)' };
const IMPACT_LABEL: Record<number, string> = { 3: 'calendar.impactHigh', 2: 'calendar.impactMedium', 1: 'calendar.impactLow' };

const SESSIONS = [
  { key: 'calendar.sessionAsia', from: 0, to: 7 },
  { key: 'calendar.sessionLondon', from: 7, to: 13 },
  { key: 'calendar.sessionOverlap', from: 13, to: 16 },
  { key: 'calendar.sessionNewyork', from: 16, to: 21 },
  { key: 'calendar.sessionOff', from: 21, to: 24 },
];

// ── Reine Datums-Helfer (lokale Zeit) ──────────────────────────────────────
function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
/** Montag der Woche von d (Woche beginnt Montag). */
function startOfWeekMonday(d: Date): Date {
  const x = startOfDay(d);
  const dow = (x.getDay() + 6) % 7; // Mo=0 … So=6
  return addDays(x, -dow);
}
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function sameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function severityOf(e: CalEvent): number {
  return e.impact?.severity ?? e.importance ?? 1;
}

function DayCell({
  date,
  events,
  inMonth,
  isToday,
  selected,
  onSelect,
}: {
  date: Date;
  events: CalEvent[];
  inMonth: boolean;
  isToday: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const top = [...events].sort((a, b) => severityOf(b) - severityOf(a)).slice(0, 3);
  return (
    <button
      onClick={onSelect}
      className="flex min-h-[84px] flex-col gap-1 rounded-[0.5rem] border p-1.5 text-left transition-all"
      style={{
        borderColor: selected ? 'rgba(79,209,255,0.7)' : isToday ? 'rgba(79,209,255,0.35)' : 'var(--color-line)',
        background: selected ? 'rgba(46,124,246,0.12)' : 'rgba(10,13,36,0.35)',
        opacity: inMonth ? 1 : 0.4,
        boxShadow: selected ? '0 0 14px rgba(46,124,246,0.25)' : 'none',
      }}
    >
      <span className="num text-xs" style={{ color: isToday ? 'var(--color-cyan)' : 'var(--color-mut)', fontWeight: isToday ? 700 : 400 }}>
        {date.getDate()}
      </span>
      <div className="flex flex-col gap-0.5">
        {top.map((e) => (
          <span
            key={e.id}
            className="truncate rounded px-1 py-0.5 text-[10px] leading-tight"
            style={{ background: 'rgba(4,6,20,0.6)', borderLeft: `2px solid ${IMPACT_COLOR[severityOf(e)] ?? 'var(--color-mut)'}` }}
            title={e.title}
          >
            <span className="num" style={{ color: 'var(--color-mut)' }}>{e.currency ?? '—'}</span> {e.title}
          </span>
        ))}
        {events.length > top.length && (
          <span className="text-[10px]" style={{ color: 'var(--color-mut)' }}>{t('calendar.moreEvents', { count: events.length - top.length })}</span>
        )}
      </div>
    </button>
  );
}

function EventDetail({ e }: { e: CalEvent }) {
  const { t } = useTranslation();
  const sev = severityOf(e);
  const color = IMPACT_COLOR[sev] ?? 'var(--color-mut)';
  const time = new Date(e.scheduledAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const assets = e.impact?.assets ?? [];
  const markets = e.impact?.markets ?? [];
  return (
    <li className="rounded-[0.625rem] border p-3" style={{ borderColor: 'var(--color-line)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="num text-xs" style={{ color: 'var(--color-mut)' }}>{time}</span>
        <span className="label rounded border px-1.5 py-0.5" style={{ borderColor: color, color }}>{t(IMPACT_LABEL[sev] ?? 'calendar.impactLow')}</span>
        <span className="label num">{e.currency ?? '—'}</span>
        <span className="text-sm font-medium">{e.title}</span>
      </div>
      {e.impact?.category && (
        <p className="mt-1.5 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t(`calendar.cat_${e.impact.category}`)}</p>
      )}
      {assets.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="label">{t('calendar.affectedAssets')}:</span>
          {assets.map((a) => (
            <span
              key={`${a.kind}-${a.symbol}`}
              className="num rounded border px-1.5 py-0.5 text-[11px]"
              style={{ borderColor: IMPACT_COLOR[a.level] ?? 'var(--color-line)', color: 'var(--color-ink)' }}
              title={t(IMPACT_LABEL[a.level] ?? 'calendar.impactLow')}
            >
              {a.symbol}
            </span>
          ))}
        </div>
      )}
      {markets.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="label">{t('calendar.typicalMarkets')}:</span>
          {markets.map((m) => (
            <span key={m} className="rounded px-1.5 py-0.5 text-[11px]" style={{ background: 'rgba(99,140,255,0.12)', color: 'var(--color-mut)' }}>
              {t(`calendar.mkt_${m}`)}
            </span>
          ))}
        </div>
      )}
      <div className="num mt-2 flex flex-wrap gap-4 text-xs" style={{ color: 'var(--color-mut)' }}>
        <span>{t('calendar.forecast')}: {e.forecast ?? '—'}</span>
        <span>{t('calendar.previous')}: {e.previous ?? '—'}</span>
      </div>
    </li>
  );
}

export function Kalender() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const hourUtc = new Date().getUTCHours();

  const [view, setView] = useState<'month' | 'week'>('month');
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
  const [selected, setSelected] = useState<Date>(() => startOfDay(new Date()));
  const [data, setData] = useState<Calendar | null>(null);

  // Sichtbarer Bereich: Monat = 6-Wochen-Gitter ab Montag; Woche = 7 Tage ab Montag.
  const gridStart = useMemo(() => {
    if (view === 'week') return startOfWeekMonday(anchor);
    return startOfWeekMonday(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  }, [view, anchor]);
  const gridDays = view === 'week' ? 7 : 42;
  const cells = useMemo(() => Array.from({ length: gridDays }, (_, i) => addDays(gridStart, i)), [gridStart, gridDays]);

  useEffect(() => {
    setData(null);
    const from = gridStart.toISOString();
    const to = addDays(gridStart, gridDays).toISOString();
    void trpc.market.calendar
      .query({ from, to })
      .then(setData)
      .catch(() => setData({ events: [], noTrade: null }));
  }, [gridStart, gridDays]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const e of data?.events ?? []) {
      const k = dayKey(new Date(e.scheduledAt));
      const list = map.get(k) ?? [];
      list.push(e);
      map.set(k, list);
    }
    return map;
  }, [data]);

  const weekdays = useMemo(() => {
    const mon = startOfWeekMonday(new Date());
    return Array.from({ length: 7 }, (_, i) => addDays(mon, i).toLocaleDateString(locale, { weekday: 'short' }));
  }, [locale]);

  const todayKey = dayKey(new Date());
  const selectedEvents = (byDay.get(dayKey(selected)) ?? []).sort(
    (a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime(),
  );

  const rangeLabel =
    view === 'week'
      ? `${gridStart.toLocaleDateString(locale, { day: '2-digit', month: 'short' })} – ${addDays(gridStart, 6).toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' })}`
      : anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric' });

  function shift(dir: -1 | 1) {
    setAnchor((a) => (view === 'week' ? addDays(a, dir * 7) : new Date(a.getFullYear(), a.getMonth() + dir, 1)));
  }
  function goToday() {
    const now = startOfDay(new Date());
    setAnchor(now);
    setSelected(now);
  }

  const toggleBtn = (v: 'month' | 'week', label: string) => (
    <button
      onClick={() => setView(v)}
      className="rounded-[0.5rem] border px-3 py-1.5 text-xs transition-all"
      style={
        view === v
          ? { borderColor: 'rgba(79,209,255,0.5)', color: 'var(--color-ink)', background: 'rgba(46,124,246,0.16)' }
          : { borderColor: 'var(--color-line)', color: 'var(--color-mut)' }
      }
    >
      {label}
    </button>
  );

  return (
    <div>
      <PageHeader
        title={t('calendar.title')}
        subtitle={t('calendar.subtitle')}
        right={
          <div className="flex flex-wrap items-center gap-2">
            {toggleBtn('month', t('calendar.viewMonth'))}
            {toggleBtn('week', t('calendar.viewWeek'))}
            <button onClick={goToday} className="rounded-[0.5rem] border px-3 py-1.5 text-xs" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
              {t('calendar.today')}
            </button>
          </div>
        }
      />

      {data?.noTrade && (
        <div
          className="glass reveal mb-5 p-4 text-sm leading-relaxed"
          style={{ borderColor: 'rgba(255,92,108,0.5)', color: 'var(--color-neg)', boxShadow: '0 0 24px rgba(255,92,108,0.15)' }}
        >
          ⚠ {t('calendar.noTradeActive', { reason: data.noTrade.reason })}
        </div>
      )}

      <Panel stagger={1}>
        {/* Kopf: Bereich + Navigation */}
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold capitalize">{rangeLabel}</h2>
          <div className="flex items-center gap-2">
            <button onClick={() => shift(-1)} aria-label="prev" className="rounded-[0.5rem] border px-2.5 py-1.5 text-sm" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>‹</button>
            <button onClick={() => shift(1)} aria-label="next" className="rounded-[0.5rem] border px-2.5 py-1.5 text-sm" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>›</button>
          </div>
        </div>

        {/* Impact-Legende */}
        <div className="mt-3 flex flex-wrap items-center gap-4 text-xs" style={{ color: 'var(--color-mut)' }}>
          {[3, 2, 1].map((imp) => (
            <span key={imp} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: IMPACT_COLOR[imp] }} />
              {t(IMPACT_LABEL[imp] ?? 'calendar.impactLow')}
            </span>
          ))}
        </div>

        {/* Wochentags-Kopf */}
        <div className="mt-4 grid grid-cols-7 gap-1.5">
          {weekdays.map((w) => (
            <div key={w} className="label pb-1 text-center capitalize">{w}</div>
          ))}
        </div>

        {/* Gitter */}
        {data === null ? (
          <Loading />
        ) : (
          <div className="mt-1.5 grid grid-cols-7 gap-1.5">
            {cells.map((d) => (
              <DayCell
                key={dayKey(d)}
                date={d}
                events={byDay.get(dayKey(d)) ?? []}
                inMonth={view === 'week' ? true : sameMonth(d, anchor)}
                isToday={dayKey(d) === todayKey}
                selected={dayKey(d) === dayKey(selected)}
                onSelect={() => setSelected(d)}
              />
            ))}
          </div>
        )}

        <p className="mt-3 text-[11px] leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('calendar.feedHint')}</p>
      </Panel>

      {/* Detail des gewählten Tages */}
      <Panel
        label={selected.toLocaleDateString(locale, { weekday: 'long', day: '2-digit', month: 'long' })}
        stagger={2}
        className="mt-5"
      >
        {selectedEvents.length === 0 ? (
          <Empty text={t('calendar.noEventsDay')} />
        ) : (
          <ul className="mt-4 space-y-2">
            {selectedEvents.map((e) => (
              <EventDetail key={e.id} e={e} />
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('calendar.noTradeInfo')}</p>
      </Panel>

      {/* Sessions (unverändert, echt aus der Engine) */}
      <Panel label={t('calendar.sessionsTitle')} stagger={3} className="mt-5">
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
                      background: active ? 'linear-gradient(92deg, rgba(46,124,246,0.5), rgba(139,92,246,0.4))' : 'rgba(99,140,255,0.15)',
                      boxShadow: active ? '0 0 18px rgba(46,124,246,0.35)' : 'none',
                    }}
                  />
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
