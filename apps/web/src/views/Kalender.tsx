import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, Loading, PageHeader, Panel } from '../components/ui.js';
import {
  addDays,
  buildAgenda,
  countdownParts,
  dayKey,
  isNoTradeEvent,
  isPast,
  nextHighImpact,
  severityOf,
  startOfDay,
  startOfWeekMonday,
  type AgendaSection,
} from '../lib/calendar-agenda.js';

/**
 * Makro-Kalender (09_ §3.7) — Agenda-Redesign (Patrick, 2026-07-09):
 * Das alte Monatsgitter war fast immer leer (der ForexFactory-Feed liefert vor
 * allem die laufende Woche) und die Events darin winzig. Jetzt: Agenda nach
 * Tagen gruppiert (sticky „Heute/Morgen/Wochentag"-Köpfe), Uhrzeit groß,
 * Impact als Stufen-Pille, Forecast/Previous nebeneinander, No-Trade-Events
 * mit rotem Rahmen, leere Tage zu einer Zeile gefaltet, vergangene Events
 * gedimmt und Live-Countdown zum nächsten High-Impact-Event.
 * Kein Fake: alles aus market.calendar (echter Feed), leere Bereiche bleiben
 * ehrlich leer.
 */

type Calendar = Awaited<ReturnType<typeof trpc.market.calendar.query>>;
type CalEvent = Calendar['events'][number];

const IMPACT_COLOR: Record<number, string> = { 3: 'var(--color-neg)', 2: 'var(--color-warn)', 1: 'var(--color-mut)' };
const IMPACT_LABEL: Record<number, string> = { 3: 'calendar.impactHigh', 2: 'calendar.impactMedium', 1: 'calendar.impactLow' };

/**
 * Akzentfarbe je Währung — NUR Wiedererkennung beim Scannen der Liste, keine
 * Bewertung. Bewusst Punkt+Code statt Flaggen-Emoji: Windows rendert
 * Flaggen-Emojis nicht (nur Buchstabenpaare), Patrick arbeitet auf Windows.
 */
const CURRENCY_ACCENT: Record<string, string> = {
  USD: 'var(--color-cyan)',
  EUR: 'var(--color-violet)',
  GBP: 'var(--color-magenta)',
  JPY: 'var(--color-warn)',
  CHF: 'var(--color-pos)',
  CAD: 'var(--color-blue)',
  AUD: 'var(--color-blue)',
  NZD: 'var(--color-pos)',
  CNY: 'var(--color-neg)',
};

const SESSIONS = [
  { key: 'calendar.sessionAsia', from: 0, to: 7 },
  { key: 'calendar.sessionLondon', from: 7, to: 13 },
  { key: 'calendar.sessionOverlap', from: 13, to: 16 },
  { key: 'calendar.sessionNewyork', from: 16, to: 21 },
  { key: 'calendar.sessionOff', from: 21, to: 24 },
];

/** Moderne Segmented Control für Monat/Woche — ersetzt die zwei losen Buttons. */
function SegmentedControl({
  value,
  onChange,
  options,
}: {
  value: 'month' | 'week';
  onChange: (v: 'month' | 'week') => void;
  options: { key: 'month' | 'week'; label: string }[];
}) {
  return (
    <div
      className="flex items-center rounded-full border p-1"
      style={{ borderColor: 'var(--color-line)', background: 'rgba(11,13,18,0.6)' }}
      role="group"
    >
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          aria-pressed={value === o.key}
          className="rounded-full px-3.5 py-1.5 text-xs font-medium transition-all"
          style={
            value === o.key
              ? {
                  background: 'linear-gradient(94deg, rgba(59,130,246,0.9), rgba(148,163,184,0.85))',
                  color: 'white',
                }
              : { color: 'var(--color-mut)' }
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Impact als Stufen-Pille: 3 Balken (gefüllt = Stufe) + Klartext — statt nur Farbpunkt. */
function ImpactPill({ sev, unknown = false }: { sev: number; unknown?: boolean }) {
  const { t } = useTranslation();
  // Patricks Mängelliste Punkt 8: „die Wichtigkeit steht nicht dabei“ — liefert der Feed keinen Impact, sagen wir das, statt „Niedrig“ zu raten.
  const color = unknown ? 'var(--color-mut)' : (IMPACT_COLOR[sev] ?? 'var(--color-mut)');
  return (
    <span
      className="flex items-center gap-1.5 rounded-full border px-2 py-0.5"
      style={{
        borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
      }}
    >
      <span className="flex items-end gap-[2px]" aria-hidden>
        {[1, 2, 3].map((i) => (
          <span
            key={i}
            className="w-[3px] rounded-sm"
            style={{ height: `${3 + i * 3}px`, background: i <= sev ? color : 'rgba(139,148,184,0.3)' }}
          />
        ))}
      </span>
      <span className="text-[11px] font-medium" style={{ color }}>
        {unknown ? t('calendar.impactUnknown') : t(IMPACT_LABEL[sev] ?? 'calendar.impactLow')}
      </span>
    </span>
  );
}

/** Währungs-Chip mit Farbakzent (Punkt) — schnelles Scannen nach Land/Währung. */
function CurrencyChip({ code }: { code: string | null }) {
  const accent = (code && CURRENCY_ACCENT[code]) ?? 'var(--color-mut)';
  return (
    <span
      className="num flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px]"
      style={{ borderColor: 'var(--color-line)', background: 'rgba(11,13,18,0.6)', color: 'var(--color-ink)' }}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: accent, boxShadow: `0 0 6px ${accent}` }} />
      {code ?? '—'}
    </span>
  );
}

/**
 * Eine Event-Karte der Agenda. Klick klappt Details auf (Kategorie-Erklärung,
 * betroffene Assets, typische Märkte) — Progressive Disclosure statt alles
 * gleichzeitig (Patricks Kritik: zu dicht, zu klein).
 */
function EventCard({ e, now, countdown }: { e: CalEvent; now: Date; countdown: string | null }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const sev = severityOf(e);
  const past = isPast(e, now);
  const noTrade = isNoTradeEvent(e);
  const time = new Date(e.scheduledAt).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
  const assets = e.impact?.assets ?? [];
  const markets = e.impact?.markets ?? [];

  return (
    <li
      className="rounded-[0.75rem] border transition-all"
      style={{
        borderColor: noTrade ? 'rgba(239,68,68,0.45)' : 'var(--color-line)',
        background: 'rgba(10,13,36,0.45)',
        boxShadow: noTrade && !past ? '0 0 18px rgba(239,68,68,0.1)' : 'none',
        // Vergangene Events bleiben lesbar, treten aber sichtbar zurück
        opacity: past ? 0.45 : 1,
      }}
    >
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-start gap-3 p-3 text-left sm:gap-4 sm:p-4">
        {/* Uhrzeit groß — wichtigste Information zum Einordnen des Tages */}
        <span
          className="num w-14 shrink-0 pt-0.5 text-lg font-semibold leading-none sm:text-xl"
          style={{ color: past ? 'var(--color-mut)' : 'var(--color-ink)' }}
        >
          {time}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <CurrencyChip code={e.currency} />
            <ImpactPill sev={sev} unknown={e.importance == null && sev <= 1} />
            {noTrade && (
              <span
                className="label rounded-full border px-2 py-0.5"
                title={t('calendar.noTradeInfo')}
                style={{
                  borderColor: 'rgba(239,68,68,0.55)',
                  color: 'var(--color-neg)',
                  background: 'rgba(239,68,68,0.08)',
                  letterSpacing: '0.08em',
                }}
              >
                {t('calendar.noTradeBadge')}
              </span>
            )}
            {countdown && (
              <span
                className="num rounded-full border px-2 py-0.5 text-[11px] font-semibold"
                style={{
                  borderColor: 'rgba(96,165,250,0.5)',
                  color: 'var(--color-cyan)',
                  background: 'rgba(96,165,250,0.08)',
                }}
              >
                {countdown}
              </span>
            )}
          </span>

          <span className="mt-1.5 block text-[15px] font-medium leading-snug">{e.title}</span>

          {/* Forecast/Previous sauber nebeneinander — mit Beschriftung statt kryptischer Zahlenreihe */}
          {(e.actual != null || e.forecast != null || e.previous != null) && (
            <span className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
              {e.actual != null && (
                <span>
                  <span className="label block">{t('calendar.actual')}</span>
                  <span className="num text-sm font-semibold" style={{ color: 'var(--color-ink)' }}>
                    {e.actual}
                    {e.unit ?? ''}
                  </span>
                </span>
              )}
              <span>
                <span className="label block">{t('calendar.forecast')}</span>
                <span className="num text-sm">{e.forecast != null ? `${e.forecast}${e.unit ?? ''}` : '—'}</span>
              </span>
              <span>
                <span className="label block">{t('calendar.previous')}</span>
                <span className="num text-sm">{e.previous != null ? `${e.previous}${e.unit ?? ''}` : '—'}</span>
              </span>
            </span>
          )}
        </span>

        <span
          aria-hidden
          className="mt-1 shrink-0 text-xs transition-transform"
          style={{ color: 'var(--color-mut)', transform: open ? 'rotate(180deg)' : 'none' }}
        >
          ▾
        </span>
      </button>

      {open && (
        <div className="border-t px-3 pb-3 pt-2.5 sm:px-4" style={{ borderColor: 'var(--color-line)' }}>
          {e.impact?.category && (
            <p className="text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
              {t(`calendar.cat_${e.impact.category}`)}
            </p>
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
                <span key={m} className="rounded px-1.5 py-0.5 text-[11px]" style={{ background: 'rgba(148,163,184,0.12)', color: 'var(--color-mut)' }}>
                  {t(`calendar.mkt_${m}`)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function Kalender() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  // Default WOCHE statt Monat: der Feed deckt vor allem die laufende Woche ab —
  // so ist die erste Ansicht dicht und nützlich statt eines fast leeren Monats.
  const [view, setView] = useState<'month' | 'week'>('week');
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
  const [data, setData] = useState<Calendar | null>(null);

  // Tickt alle 30 s: treibt Countdown, „vergangen"-Dimmung und Session-Marker.
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Sichtbarer Bereich: Woche = Mo–So; Monat = 1. bis 1. des Folgemonats (exklusiv).
  const range = useMemo(() => {
    if (view === 'week') {
      const start = startOfWeekMonday(anchor);
      return { start, end: addDays(start, 7) };
    }
    const start = startOfDay(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
    return { start, end: startOfDay(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1)) };
  }, [view, anchor]);

  useEffect(() => {
    let cancelled = false; // Blättert der Nutzer schnell, darf eine alte Antwort die neue nicht überschreiben
    setData(null);
    void trpc.market.calendar
      .query({ from: range.start.toISOString(), to: range.end.toISOString() })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setData({ events: [], noTrade: null });
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  const todayKey = dayKey(now);
  const tomorrowKey = dayKey(addDays(now, 1));

  // „Heute" als gepinnter Anker — über `now` getickt, damit der Anker um
  // Mitternacht automatisch weiterwandert (kein verstecktes new Date() im Memo).
  const sections = useMemo<AgendaSection<CalEvent>[]>(
    () => buildAgenda(data?.events ?? [], range.start, range.end, now),
    [data, range, now],
  );

  const nextHigh = useMemo(() => nextHighImpact(data?.events ?? [], now), [data, now]);
  const nextHighCd = nextHigh ? countdownParts(new Date(nextHigh.scheduledAt), now) : null;
  const countdownText =
    nextHighCd === null
      ? null
      : nextHighCd.h > 0
        ? t('calendar.inHM', { h: nextHighCd.h, m: nextHighCd.m })
        : nextHighCd.m > 0
          ? t('calendar.inM', { m: nextHighCd.m })
          : t('calendar.imminent');

  // Nach dem Laden zum „Heute"-Anker springen (nur innerhalb der Agenda-Box,
  // nicht die Seite scrollen) — sonst beginnt der Monat immer beim 1.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dayRefs = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (!data) return;
    const box = scrollRef.current;
    if (!box) return;
    const target = dayRefs.current.get(todayKey);
    box.scrollTop = target ? Math.max(0, target.offsetTop - 2) : 0;
    // Bewusst nur [data]: es soll genau einmal nach dem Laden gescrollt werden,
    // nicht bei jedem Tageswechsel (todayKey ist innerhalb einer Sitzung stabil).
  }, [data]);

  const rangeLabel =
    view === 'week'
      ? `${range.start.toLocaleDateString(locale, { day: '2-digit', month: 'short' })} – ${addDays(range.end, -1).toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' })}`
      : anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric' });

  function shift(dir: -1 | 1) {
    setAnchor((a) => (view === 'week' ? addDays(a, dir * 7) : new Date(a.getFullYear(), a.getMonth() + dir, 1)));
  }

  const hourUtc = now.getUTCHours();

  return (
    <div>
      <PageHeader
        title={t('calendar.title')}
        subtitle={`${t('calendar.subtitle')} ${t('calendar.tzHint', { tz: Intl.DateTimeFormat().resolvedOptions().timeZone })}`}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              value={view}
              onChange={setView}
              options={[
                { key: 'week', label: t('calendar.viewWeek') },
                { key: 'month', label: t('calendar.viewMonth') },
              ]}
            />
            <button
              onClick={() => setAnchor(startOfDay(new Date()))}
              className="rounded-full border px-3.5 py-2 text-xs font-medium transition-all"
              style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
            >
              {t('calendar.today')}
            </button>
          </div>
        }
      />

      {data?.noTrade && (
        <div
          className="glass reveal mb-5 p-4 text-sm leading-relaxed"
          style={{ borderColor: 'rgba(239,68,68,0.5)', color: 'var(--color-neg)' }}
        >
          ⚠ {t('calendar.noTradeActive', { reason: data.noTrade.reason })}
        </div>
      )}

      <Panel stagger={1}>
        {/* Kopf: Bereich + Navigation */}
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold capitalize">{rangeLabel}</h2>
          <div className="flex items-center gap-2">
            <button onClick={() => shift(-1)} aria-label="prev" className="rounded-[0.5rem] border px-2.5 py-1.5 text-sm" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
              ‹
            </button>
            <button onClick={() => shift(1)} aria-label="next" className="rounded-[0.5rem] border px-2.5 py-1.5 text-sm" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
              ›
            </button>
          </div>
        </div>

        {/* Live-Countdown zum nächsten High-Impact-Event (nur echt geladene Events) */}
        {nextHigh && countdownText && (
          <div
            className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[0.75rem] border p-3"
            style={{ borderColor: 'rgba(96,165,250,0.35)', background: 'rgba(96,165,250,0.06)' }}
          >
            <span className="label" style={{ color: 'var(--color-cyan)' }}>
              {t('calendar.nextHighImpact')}
            </span>
            <span className="text-sm font-medium">{nextHigh.title}</span>
            <CurrencyChip code={nextHigh.currency} />
            <span className="num text-sm font-semibold" style={{ color: 'var(--color-cyan)' }}>
              {countdownText}
            </span>
          </div>
        )}

        {/* Impact-Legende */}
        <div className="mt-3 flex flex-wrap items-center gap-4 text-xs" style={{ color: 'var(--color-mut)' }}>
          {[3, 2, 1].map((imp) => (
            <span key={imp} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: IMPACT_COLOR[imp] }} />
              {t(IMPACT_LABEL[imp] ?? 'calendar.impactLow')}
            </span>
          ))}
        </div>

        {/* Agenda: eigene Scroll-Box, damit die Tages-Köpfe zuverlässig sticky sind
            (die Topbar der App ist selbst sticky mit variabler Höhe) */}
        {data === null ? (
          <Loading />
        ) : (
          <>
            {data.events.length === 0 && <Empty text={t('calendar.rangeEmpty')} />}
            <div
              ref={scrollRef}
              className="relative mt-4 max-h-[62vh] overflow-y-auto pr-1"
              style={{ scrollbarWidth: 'thin' }}
            >
              {sections.map((s) => {
                if (s.kind === 'gap') {
                  const from = s.from.toLocaleDateString(locale, { day: '2-digit', month: 'short' });
                  const to = s.to.toLocaleDateString(locale, { day: '2-digit', month: 'short' });
                  const label = s.days === 1 ? `${from} · ${t('calendar.gapOne')}` : `${from} – ${to} · ${t('calendar.gapMany', { n: s.days })}`;
                  return (
                    <div key={`gap-${dayKey(s.from)}`} className="flex items-center gap-3 py-2">
                      <span className="h-px flex-1" style={{ background: 'var(--color-line)' }} />
                      <span className="num text-[11px]" style={{ color: 'var(--color-mut)' }}>
                        {label}
                      </span>
                      <span className="h-px flex-1" style={{ background: 'var(--color-line)' }} />
                    </div>
                  );
                }

                const k = dayKey(s.date);
                const isToday = k === todayKey;
                const isTomorrow = k === tomorrowKey;
                const big = isToday ? t('calendar.today') : isTomorrow ? t('calendar.tomorrow') : s.date.toLocaleDateString(locale, { weekday: 'long' });
                const count = s.events.length;
                return (
                  <div
                    key={k}
                    ref={(el) => {
                      if (el) dayRefs.current.set(k, el);
                      else dayRefs.current.delete(k);
                    }}
                  >
                    {/* Sticky Tages-Kopf: bleibt beim Scrollen oben in der Agenda-Box stehen.
                        flex-wrap: auf 375px darf die Event-Zahl umbrechen statt zu überlaufen. */}
                    <div
                      className="sticky top-0 z-10 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-[0.5rem] px-2 py-2"
                      style={{
                        background: 'rgba(18,21,28,0.92)',
                        backdropFilter: 'blur(8px)',
                        WebkitBackdropFilter: 'blur(8px)',
                        borderBottom: '1px solid var(--color-line)',
                      }}
                    >
                      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                        <span className="text-sm font-semibold capitalize" style={{ color: isToday ? 'var(--color-cyan)' : 'var(--color-ink)' }}>
                          {big}
                        </span>
                        <span className="num text-xs" style={{ color: 'var(--color-mut)' }}>
                          {s.date.toLocaleDateString(locale, { day: '2-digit', month: 'long' })}
                        </span>
                      </span>
                      <span className="num text-xs" style={{ color: 'var(--color-mut)' }}>
                        {count === 0 ? t('calendar.noEventsDay') : count === 1 ? t('calendar.eventOne') : t('calendar.eventsMany', { n: count })}
                      </span>
                    </div>
                    {count > 0 && (
                      <ul className="space-y-2 pb-4 pt-2">
                        {s.events.map((e) => (
                          <EventCard key={e.id} e={e} now={now} countdown={nextHigh && e.id === nextHigh.id ? countdownText : null} />
                        ))}
                      </ul>
                    )}
                    {count === 0 && <div className="pb-4 pt-1" />}
                  </div>
                );
              })}
            </div>
          </>
        )}

        <p className="mt-3 text-[11px] leading-relaxed" style={{ color: 'var(--color-mut)' }}>
          {t('calendar.feedHint')}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed" style={{ color: 'var(--color-mut)' }}>
          {t('calendar.noTradeInfo')}
        </p>
      </Panel>

      {/* Sessions (unverändert, echt aus der Engine) */}
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
                      background: active ? 'rgba(59,130,246,0.5)' : 'rgba(148,163,184,0.15)',
                      boxShadow: active ? '0 0 18px rgba(59,130,246,0.35)' : 'none',
                    }}
                  />
                  <div
                    className="absolute inset-y-0 w-px"
                    style={{ left: `${((hourUtc + now.getUTCMinutes() / 60) / 24) * 100}%`, background: 'var(--color-cyan)' }}
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
