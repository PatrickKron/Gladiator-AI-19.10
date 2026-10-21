import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { fmt } from './EquityChart.js';
import { appLocale } from '../lib/locale.js';

/**
 * Optimierungs-Vorschläge (08_ §5) im Backtest-Labor. Die wöchentliche
 * Nacht-Optimierung legt hier NUR Vorschläge ab; „Übernehmen" erzeugt eine
 * neue Entwurfs-Version (draft) — scharf geschaltet wird erst nach Backtest
 * und Promotion über das reguläre Validitäts-Gate (Mensch im Loop).
 * Alle Texte über i18n (`labor.proposals.*`).
 */

type Proposal = Awaited<ReturnType<typeof trpc.lab.proposals.query>>[number];
type Summary = Proposal['results']['before'];

const STATE_KEY: Record<Proposal['state'], string> = {
  open: 'labor.proposals.stateOpen',
  accepted: 'labor.proposals.stateAccepted',
  rejected: 'labor.proposals.stateRejected',
  superseded: 'labor.proposals.stateSuperseded',
};

function pf(m: Summary): string {
  if (m.tradeCount === 0) return '—';
  return m.profitFactor === null ? '∞' : fmt(m.profitFactor);
}

function MetricsCompare({ before, after }: { before: Summary; after: Summary }) {
  const { t } = useTranslation();
  const rows: [string, string, string, number | null][] = [
    [t('labor.proposals.oosTrades'), fmt(before.tradeCount, 0), fmt(after.tradeCount, 0), null],
    [t('labor.proposals.expectation'), before.expectancy === null ? '—' : `${fmt(before.expectancy)} R`, after.expectancy === null ? '—' : `${fmt(after.expectancy)} R`, (after.expectancy ?? 0) - (before.expectancy ?? 0)],
    [t('labor.profitFactor'), pf(before), pf(after), null],
    [t('labor.winRate'), before.winRate === null ? '—' : `${fmt(before.winRate * 100, 1)} %`, after.winRate === null ? '—' : `${fmt(after.winRate * 100, 1)} %`, null],
    [t('labor.maxDrawdown'), `${fmt(before.maxDrawdownPct)} %`, `${fmt(after.maxDrawdownPct)} %`, null],
    [t('labor.netPnl'), `${fmt(before.netPnl)} $`, `${fmt(after.netPnl)} $`, after.netPnl - before.netPnl],
  ];
  return (
    <table className="mt-3 w-full text-sm">
      <thead>
        <tr className="label text-left">
          <th className="py-1 pr-3 font-normal">{t('labor.proposals.tableHead')}</th>
          <th className="py-1 pr-3 text-right font-normal">{t('labor.proposals.current')}</th>
          <th className="py-1 text-right font-normal">{t('labor.proposals.proposal')}</th>
        </tr>
      </thead>
      <tbody className="num">
        {rows.map(([label, b, a, delta]) => (
          <tr key={label} style={{ borderTop: '1px solid rgba(148,163,184,0.08)' }}>
            <td className="py-1 pr-3">{label}</td>
            <td className="py-1 pr-3 text-right">{b}</td>
            <td
              className="py-1 text-right"
              style={{ color: delta === null ? undefined : delta >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}
            >
              {a}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const showValue = (v: unknown, off: string) => (v === null || v === undefined ? off : String(v));

export function OptimizationProposals() {
  const { t } = useTranslation();
  const [scope, setScope] = useState<'open' | 'all'>('open');
  const [items, setItems] = useState<Proposal[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function load(s = scope) {
    try {
      setItems(await trpc.lab.proposals.query({ state: s }));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('labor.proposals.errLoad'));
    }
  }
  useEffect(() => {
    void load(scope);
  }, [scope]);

  async function onAccept(p: Proposal) {
    setBusyId(p.id);
    setActionError(null);
    try {
      const out = await trpc.lab.acceptProposal.mutate({ id: p.id });
      setNotice(t('labor.proposals.acceptedNotice', { slug: out.slug, version: out.version }));
      setConfirmId(null);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('labor.proposals.errAccept'));
    } finally {
      setBusyId(null);
    }
  }

  async function onReject(p: Proposal) {
    setBusyId(p.id);
    setActionError(null);
    try {
      await trpc.lab.rejectProposal.mutate({ id: p.id });
      setNotice(t('labor.proposals.rejectedNotice', { slug: p.slug, version: p.baseVersion }));
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('labor.proposals.errReject'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="glass mt-6 p-6" id="optimierungs-vorschlaege">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="label">{t('labor.proposals.title')}</h2>
        <div className="flex gap-2 text-xs">
          {(['open', 'all'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className="rounded border px-3 py-1"
              style={{
                borderColor: scope === s ? 'var(--color-cyan)' : 'var(--color-line)',
                color: scope === s ? 'var(--color-cyan)' : 'var(--color-mut)',
              }}
            >
              {s === 'open' ? t('labor.proposals.scopeOpen') : t('labor.proposals.scopeAll')}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-2 text-xs" style={{ color: 'var(--color-mut)' }}>
        {t('labor.proposals.intro')}
      </p>

      {notice && (
        <p className="mt-3 rounded-[0.625rem] border p-3 text-sm" style={{ borderColor: 'rgba(34,197,94,0.4)', color: 'var(--color-pos)' }}>
          ✓ {notice}{' '}
          <a href="#/strategien" className="underline">
            {t('labor.proposals.toStrategies')}
          </a>
        </p>
      )}
      {actionError && (
        <p className="mt-3 text-sm" style={{ color: 'var(--color-neg)' }}>
          {actionError}
        </p>
      )}
      {loadError && (
        <p className="mt-3 text-sm" style={{ color: 'var(--color-neg)' }}>
          {loadError}
        </p>
      )}

      {items === null && !loadError && (
        <p className="mt-3 text-sm" style={{ color: 'var(--color-mut)' }}>
          {t('labor.proposals.loading')}
        </p>
      )}
      {items !== null && items.length === 0 && (
        <p className="mt-3 text-sm" style={{ color: 'var(--color-mut)' }}>
          {scope === 'open'
            ? t('labor.proposals.emptyOpen')
            : t('labor.proposals.emptyAll')}
        </p>
      )}

      {items !== null && items.length > 0 && (
        <ul className="mt-4 space-y-4">
          {items.map((p) => {
            const r = p.results;
            const open = p.state === 'open';
            return (
              <li key={p.id} className="rounded-xl border p-4" style={{ borderColor: 'var(--color-line)', opacity: open ? 1 : 0.75 }}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">
                      {p.name} <span style={{ color: 'var(--color-mut)' }}>({p.slug})</span> · {t('labor.proposals.baseVersion', { version: p.baseVersion })}
                    </p>
                    <p className="label mt-1">
                      {new Date(p.createdAt).toLocaleString(appLocale(), { dateStyle: 'short', timeStyle: 'short' })} · {t(STATE_KEY[p.state])}
                      {r.review.newVersion ? ` → ${t('labor.proposals.draftVersion', { version: r.review.newVersion })}` : ''} ·{' '}
                      {t('labor.proposals.windowsWins', { windows: r.window.windows, wins: r.wins })}
                      {r.window.oosFrom && r.window.oosTo
                        ? ` · ${t('labor.proposals.oosRange', {
                            from: new Date(r.window.oosFrom).toLocaleDateString(appLocale()),
                            to: new Date(r.window.oosTo).toLocaleDateString(appLocale()),
                          })}`
                        : ''}
                    </p>
                  </div>
                  {open && (
                    <div className="flex shrink-0 gap-2">
                      {confirmId === p.id ? (
                        <>
                          <button
                            disabled={busyId === p.id}
                            onClick={() => void onAccept(p)}
                            className="rounded border px-3 py-1.5 text-xs"
                            style={{ borderColor: 'rgba(34,197,94,0.5)', color: 'var(--color-pos)' }}
                          >
                            {busyId === p.id ? t('labor.proposals.creating') : t('labor.proposals.confirm')}
                          </button>
                          <button
                            onClick={() => setConfirmId(null)}
                            className="rounded border px-3 py-1.5 text-xs"
                            style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
                          >
                            {t('labor.proposals.cancel')}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            disabled={busyId !== null}
                            onClick={() => setConfirmId(p.id)}
                            className="rounded border px-3 py-1.5 text-xs"
                            style={{ borderColor: 'rgba(34,197,94,0.4)', color: 'var(--color-pos)' }}
                          >
                            {t('labor.proposals.accept')}
                          </button>
                          <button
                            disabled={busyId !== null}
                            onClick={() => void onReject(p)}
                            className="rounded border px-3 py-1.5 text-xs"
                            style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
                          >
                            {t('labor.proposals.reject')}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>

                {r.changes.length > 0 && (
                  <div className="mt-3">
                    <h3 className="label">{t('labor.proposals.changedParams')}</h3>
                    <ul className="num mt-1 space-y-0.5 text-sm">
                      {r.changes.map((c) => (
                        <li key={c.path}>
                          <span style={{ color: 'var(--color-mut)' }}>{c.path}:</span> {showValue(c.from, t('labor.off'))} → <b>{showValue(c.to, t('labor.off'))}</b>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="overflow-x-auto">
                  <MetricsCompare before={r.before} after={r.after} />
                </div>

                {r.holdout && (
                  <p className="mt-2 text-xs" style={{ color: 'var(--color-mut)' }}>
                    {t('labor.proposals.holdout', {
                      from: new Date(r.holdout.fromTs).toLocaleDateString(appLocale()),
                      n: r.holdout.tradeCount,
                      expectancy: r.holdout.expectancy === null ? '—' : `${fmt(r.holdout.expectancy)} R`,
                      pf: r.holdout.profitFactor === null ? (r.holdout.tradeCount > 0 ? '∞' : '—') : fmt(r.holdout.profitFactor),
                    })}
                  </p>
                )}

                <ul className="mt-2 space-y-0.5 text-xs">
                  {r.checks.map((c) => (
                    <li key={c.name} style={{ color: c.passed ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                      {c.passed ? '✓' : '✗'} {c.detail}
                    </li>
                  ))}
                </ul>

                {r.markets.length > 0 && (
                  <p className="mt-2 text-xs" style={{ color: 'var(--color-mut)' }}>
                    {t('labor.proposals.markets')}{' '}
                    {r.markets
                      .map((m) =>
                        t('labor.proposals.marketItem', {
                          key: m.key,
                          windows: m.windows,
                          funding:
                            m.fundingSource === 'historical'
                              ? t('labor.proposals.fundingHistorical')
                              : t('labor.proposals.fundingModel'),
                          warnings:
                            m.dataWarnings.length > 0 ? `, ${t('labor.proposals.dataHints', { n: m.dataWarnings.length })}` : '',
                        }),
                      )
                      .join(' · ')}
                  </p>
                )}
                {r.markets.some((m) => m.dataWarnings.length > 0) && (
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs" style={{ color: 'var(--color-warn)' }}>
                    {r.markets.flatMap((m) => m.dataWarnings.map((w) => <li key={`${m.key}-${w}`}>{m.key}: {w}</li>))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
