import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { buildTodayItems, type TodayEvent, type TodayItem, type TodayNotification, type TodayProposal, type TodaySignal } from '../lib/today-items.js';
import { appLocale } from '../lib/locale.js';
import { clearVisibleInterval, setVisibleInterval } from '../lib/visible-interval.js';

/**
 * „Heute wichtig" (Welle B): die fünf Dinge, die jetzt Aufmerksamkeit
 * verdienen — offene Signale, Termine mit Impact in den nächsten 24 h,
 * ungelesene Ereignisse, offene Optimierungs-Vorschläge. Jede Quelle lädt
 * unabhängig und fällt einzeln ehrlich aus; die Rangfolge ist rein
 * (lib/today-items.ts, getestet).
 */

function relative(ts: string, now: number, locale: string): string {
  const diffMin = Math.round((Date.parse(ts) - now) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, 'minute');
  if (Math.abs(diffMin) < 60 * 24) return rtf.format(Math.round(diffMin / 60), 'hour');
  return rtf.format(Math.round(diffMin / (60 * 24)), 'day');
}

function Row({ icon, tone, title, subtitle, href, action }: { icon: string; tone: 'pos' | 'neg' | 'acc' | 'warn' | 'mut'; title: string; subtitle: string; href: string; action: string }) {
  const toneBg: Record<typeof tone, string> = {
    pos: 'rgba(34,197,94,0.14)',
    neg: 'rgba(239,68,68,0.14)',
    acc: 'rgba(59,130,246,0.16)',
    warn: 'rgba(245,158,11,0.14)',
    mut: 'rgba(255,255,255,0.06)',
  };
  const toneFg: Record<typeof tone, string> = { pos: 'var(--color-pos)', neg: 'var(--color-neg)', acc: 'var(--color-cyan)', warn: 'var(--color-warn)', mut: 'var(--color-mut)' };
  return (
    <a href={href} className="glass glass-hover grid items-center gap-3 px-4 py-3" style={{ gridTemplateColumns: '36px minmax(0,1fr) auto' }}>
      <span className="num grid h-9 w-9 place-items-center rounded-[10px] text-xs font-bold" style={{ background: toneBg[tone], color: toneFg[tone] }}>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="block truncate text-xs" style={{ color: 'var(--color-mut)' }}>
          {subtitle}
        </span>
      </span>
      <span className={`chip ${tone === 'mut' ? '' : 'chip--acc'}`}>{action}</span>
    </a>
  );
}

export function TodayList({ onSignalCount }: { onSignalCount?: (n: number) => void }) {
  const { t } = useTranslation();
  const [signals, setSignals] = useState<TodaySignal[] | null>(null);
  const [events, setEvents] = useState<TodayEvent[]>([]);
  const [notes, setNotes] = useState<TodayNotification[]>([]);
  const [proposals, setProposals] = useState<TodayProposal[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      setNow(Date.now());
      void trpc.signals.list
        .query({ status: ['new'], limit: 10 })
        .then((rows) => {
          if (cancelled) return;
          const list = rows.map((r) => ({ id: r.id, symbol: r.symbol, direction: r.direction, score: Number(r.score), createdAt: r.createdAt, timeframe: r.timeframe }));
          setSignals(list);
          onSignalCount?.(list.length);
        })
        .catch(() => !cancelled && setSignals((p) => p ?? []));
      void trpc.market.calendar
        .query({ days: 2 })
        .then((d) => !cancelled && setEvents(d.events.map((e) => ({ id: e.id, title: e.title, importance: e.importance, scheduledAt: new Date(e.scheduledAt).toISOString(), currency: e.currency }))))
        .catch(() => !cancelled && setEvents([]));
      void trpc.notifications.list
        .query({ limit: 20, unreadOnly: true })
        .then((rows) => !cancelled && setNotes(rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, createdAt: n.createdAt, read: n.read, link: n.link }))))
        .catch(() => !cancelled && setNotes([]));
      void trpc.lab.proposals
        .query({ state: 'open', limit: 5 })
        .then((rows) => !cancelled && setProposals(rows.map((p) => ({ id: p.id, name: p.name, createdAt: new Date(p.createdAt as unknown as string).toISOString() }))))
        .catch(() => !cancelled && setProposals([]));
    };
    load();
    const timer = setVisibleInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearVisibleInterval(timer);
    };
  }, [onSignalCount]);

  const items = useMemo(() => buildTodayItems({ signals: signals ?? [], events, notifications: notes, proposals }, now, 5), [signals, events, notes, proposals, now]);
  const locale = appLocale();

  const render = (it: TodayItem) => {
    switch (it.kind) {
      case 'signal': {
        const s = it.signal;
        const long = s.direction === 'long';
        return (
          <Row
            key={it.id}
            icon={long ? 'L' : 'S'}
            tone={long ? 'pos' : 'neg'}
            title={t('today.signalTitle', { symbol: s.symbol, dir: long ? 'Long' : 'Short', score: s.score.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}
            subtitle={`${s.timeframe} · ${relative(s.createdAt, now, locale)}`}
            href="#/signals"
            action={t('today.check')}
          />
        );
      }
      case 'event': {
        const e = it.event;
        const at = new Date(e.scheduledAt);
        return (
          <Row
            key={it.id}
            icon={at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
            tone={(e.importance ?? 0) >= 3 ? 'warn' : 'mut'}
            title={e.title + (e.currency ? ` · ${e.currency}` : '')}
            subtitle={`${t('today.eventIn', { time: relative(e.scheduledAt, now, locale) })} · ${(e.importance ?? 0) >= 3 ? t('today.highImpact') : t('today.mediumImpact')}`}
            href="#/kalender"
            action={t('today.calendar')}
          />
        );
      }
      case 'notification': {
        const n = it.notification;
        const critical = n.kind === 'kill_switch' || n.kind === 'emergency';
        return <Row key={it.id} icon={critical ? '!' : '•'} tone={critical ? 'neg' : 'acc'} title={n.title} subtitle={relative(n.createdAt, now, locale)} href={n.link ?? '#/'} action={t('today.open')} />;
      }
      case 'proposal':
        return <Row key={it.id} icon="A" tone="acc" title={t('today.proposalTitle', { name: it.proposal.name })} subtitle={t('today.proposalSub')} href="#/labor" action={t('today.view')} />;
    }
  };

  return (
    <section className="reveal mt-7" style={{ '--stagger': 2 } as React.CSSProperties}>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">{t('today.title')}</h2>
        <a href="#/signals" className="text-xs" style={{ color: 'var(--color-cyan)' }}>
          {t('today.all')}
        </a>
      </div>
      {signals === null ? (
        <p className="label animate-pulse py-3">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="glass px-4 py-3 text-sm" style={{ color: 'var(--color-mut)' }}>
          {t('today.empty')}
        </p>
      ) : (
        <div className="flex flex-col gap-2">{items.map(render)}</div>
      )}
    </section>
  );
}
