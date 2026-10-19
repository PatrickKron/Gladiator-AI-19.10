import { useEffect, useState } from 'react';
import { trpc } from '../api.js';
import { fmt } from './EquityChart.js';

/**
 * Optimierungs-Vorschläge (08_ §5) im Backtest-Labor. Die wöchentliche
 * Nacht-Optimierung legt hier NUR Vorschläge ab; „Übernehmen" erzeugt eine
 * neue Entwurfs-Version (draft) — scharf geschaltet wird erst nach Backtest
 * und Promotion über das reguläre Validitäts-Gate (Mensch im Loop).
 * Deutsch hart kodiert wie das übrige Labor (bestehende Konvention).
 */

type Proposal = Awaited<ReturnType<typeof trpc.lab.proposals.query>>[number];
type Summary = Proposal['results']['before'];

const STATE_LABEL: Record<Proposal['state'], string> = {
  open: 'offen',
  accepted: 'übernommen',
  rejected: 'verworfen',
  superseded: 'ersetzt',
};

function pf(m: Summary): string {
  if (m.tradeCount === 0) return '—';
  return m.profitFactor === null ? '∞' : fmt(m.profitFactor);
}

function MetricsCompare({ before, after }: { before: Summary; after: Summary }) {
  const rows: [string, string, string, number | null][] = [
    ['OOS-Trades', fmt(before.tradeCount, 0), fmt(after.tradeCount, 0), null],
    ['Erwartung', before.expectancy === null ? '—' : `${fmt(before.expectancy)} R`, after.expectancy === null ? '—' : `${fmt(after.expectancy)} R`, (after.expectancy ?? 0) - (before.expectancy ?? 0)],
    ['Profit-Factor', pf(before), pf(after), null],
    ['WinRate', before.winRate === null ? '—' : `${fmt(before.winRate * 100, 1)} %`, after.winRate === null ? '—' : `${fmt(after.winRate * 100, 1)} %`, null],
    ['Max-Drawdown', `${fmt(before.maxDrawdownPct)} %`, `${fmt(after.maxDrawdownPct)} %`, null],
    ['Netto-PnL', `${fmt(before.netPnl)} $`, `${fmt(after.netPnl)} $`, after.netPnl - before.netPnl],
  ];
  return (
    <table className="mt-3 w-full text-sm">
      <thead>
        <tr className="label text-left">
          <th className="py-1 pr-3 font-normal">OOS kombiniert · netto</th>
          <th className="py-1 pr-3 text-right font-normal">Aktuell</th>
          <th className="py-1 text-right font-normal">Vorschlag</th>
        </tr>
      </thead>
      <tbody className="num">
        {rows.map(([label, b, a, delta]) => (
          <tr key={label} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
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

const showValue = (v: unknown) => (v === null || v === undefined ? 'aus' : String(v));

export function OptimizationProposals() {
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
      setLoadError(err instanceof Error ? err.message : 'Vorschläge konnten nicht geladen werden.');
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
      setNotice(
        `${out.slug} v${out.version} als ENTWURF angelegt. Nächster Schritt: im Labor backtesten und unter Strategien über das Validitäts-Gate promoten — die laufende Version bleibt bis dahin unverändert.`,
      );
      setConfirmId(null);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Übernehmen fehlgeschlagen.');
    } finally {
      setBusyId(null);
    }
  }

  async function onReject(p: Proposal) {
    setBusyId(p.id);
    setActionError(null);
    try {
      await trpc.lab.rejectProposal.mutate({ id: p.id });
      setNotice(`Vorschlag für ${p.slug} v${p.baseVersion} verworfen.`);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Verwerfen fehlgeschlagen.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="glass mt-6 p-6" id="optimierungs-vorschlaege">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="label">Optimierungs-Vorschläge · Walk-Forward netto · du entscheidest</h2>
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
              {s === 'open' ? 'Offen' : 'Alle'}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-2 text-xs" style={{ color: 'var(--color-mut)' }}>
        Sonntags 03:00 UTC prüft die Nacht-Optimierung jede Paper-Strategie (und SMC Core) mit einem kleinen Parameter-Grid im
        Walk-Forward. Ein Vorschlag entsteht nur, wenn er auf denselben Out-of-Sample-Fenstern klar besser ist (Erwartung ≥ +0,05 R,
        Profit-Factor ≥ ×1,1, ≥ 30 OOS-Trades, Validitäts-Gate inkl. jüngstem Abschnitt). Übernehmen legt nur eine Entwurfs-Version an.
      </p>

      {notice && (
        <p className="mt-3 rounded-[0.625rem] border p-3 text-sm" style={{ borderColor: 'rgba(61,220,151,0.4)', color: 'var(--color-pos)' }}>
          ✓ {notice}{' '}
          <a href="#/strategien" className="underline">
            Zu den Strategien
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
          Lade …
        </p>
      )}
      {items !== null && items.length === 0 && (
        <p className="mt-3 text-sm" style={{ color: 'var(--color-mut)' }}>
          {scope === 'open'
            ? 'Keine offenen Vorschläge — entweder ist die aktuelle Version bereits die beste im Grid oder kein Kandidat war klar besser.'
            : 'Noch keine Vorschläge vorhanden.'}
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
                      {p.name} <span style={{ color: 'var(--color-mut)' }}>({p.slug})</span> · Basis v{p.baseVersion}
                    </p>
                    <p className="label mt-1">
                      {new Date(p.createdAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })} · {STATE_LABEL[p.state]}
                      {r.review.newVersion ? ` → v${r.review.newVersion} (Entwurf)` : ''} · {r.window.windows} OOS-Fenster ·
                      IS-Sieger in {r.wins} davon
                      {r.window.oosFrom && r.window.oosTo
                        ? ` · OOS ${new Date(r.window.oosFrom).toLocaleDateString('de-DE')} – ${new Date(r.window.oosTo).toLocaleDateString('de-DE')}`
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
                            style={{ borderColor: 'rgba(61,220,151,0.5)', color: 'var(--color-pos)' }}
                          >
                            {busyId === p.id ? 'Lege an …' : 'Ja, Entwurf anlegen'}
                          </button>
                          <button
                            onClick={() => setConfirmId(null)}
                            className="rounded border px-3 py-1.5 text-xs"
                            style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
                          >
                            Abbrechen
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            disabled={busyId !== null}
                            onClick={() => setConfirmId(p.id)}
                            className="rounded border px-3 py-1.5 text-xs"
                            style={{ borderColor: 'rgba(61,220,151,0.4)', color: 'var(--color-pos)' }}
                          >
                            Übernehmen …
                          </button>
                          <button
                            disabled={busyId !== null}
                            onClick={() => void onReject(p)}
                            className="rounded border px-3 py-1.5 text-xs"
                            style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
                          >
                            Verwerfen
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>

                {r.changes.length > 0 && (
                  <div className="mt-3">
                    <h3 className="label">Geänderte Parameter</h3>
                    <ul className="num mt-1 space-y-0.5 text-sm">
                      {r.changes.map((c) => (
                        <li key={c.path}>
                          <span style={{ color: 'var(--color-mut)' }}>{c.path}:</span> {showValue(c.from)} → <b>{showValue(c.to)}</b>
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
                    Jüngster OOS-Abschnitt (ab {new Date(r.holdout.fromTs).toLocaleDateString('de-DE')}): {r.holdout.tradeCount} Trades ·
                    Erwartung {r.holdout.expectancy === null ? '—' : `${fmt(r.holdout.expectancy)} R`} · PF{' '}
                    {r.holdout.profitFactor === null ? (r.holdout.tradeCount > 0 ? '∞' : '—') : fmt(r.holdout.profitFactor)}
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
                    Märkte:{' '}
                    {r.markets
                      .map(
                        (m) =>
                          `${m.key} (${m.windows} Fenster, Funding ${m.fundingSource === 'historical' ? 'historisch' : 'Modell'}${m.dataWarnings.length > 0 ? `, ${m.dataWarnings.length} Datenhinweis(e)` : ''})`,
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
