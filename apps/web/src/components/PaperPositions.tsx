import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, Loading } from './ui.js';
import { buildChartUrl } from '../lib/chart-url.js';
import { appLocale } from '../lib/locale.js';

/**
 * Offene Positionen des Agenten-Kontos mit Steuerung (Mensch im Loop):
 * SL/TP direkt in der Zeile ändern, Gewinn mitnehmen (Teilschluss 25/50/75 %),
 * Trailing-Stop schalten, Position schließen (jeweils zweistufig bestätigt).
 * Einen Stop WEITER weg zu setzen erhöht das Risiko → eigene Bestätigung.
 * Ausführung serverseitig über die aktive Venue (echte Gegen-/Schutz-Orders).
 */

export type PaperPosition = Awaited<ReturnType<typeof trpc.trading.positions.query>>[number];

type Draft = { sl: string; tps: Record<string, string> };

const fmt = (n: number | null | undefined, d = 2) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toLocaleString(appLocale(), { maximumFractionDigits: d });

const parse = (s: string): number | null => {
  const n = Number(s.replace(',', '.').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Server-Fehlercode `position:<reason>` → übersetzter Text. */
function reasonText(t: (k: string) => string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const code = msg.startsWith('position:') ? msg.slice('position:'.length) : null;
  return code ? t(`position.err_${code}`) : msg;
}

export function PaperPositions({ positions, onChanged }: { positions: PaperPosition[] | null; onChanged: () => void }) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [armedClose, setArmedClose] = useState<string | null>(null);
  const [armedPartial, setArmedPartial] = useState<{ id: string; pct: number } | null>(null);
  const [trailDrafts, setTrailDrafts] = useState<Record<string, string>>({});
  const [widenAsk, setWidenAsk] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ id: string; ok: boolean; text: string } | null>(null);

  // Meldung zu einer gerade geschlossenen Position (die Zeile ist dann weg).
  const orphanMsg = msg && !(positions ?? []).some((p) => p.id === msg.id) ? msg : null;
  const orphan = orphanMsg && (
    <p className="mt-3 text-sm" style={{ color: orphanMsg.ok ? 'var(--color-pos)' : 'var(--color-neg)' }}>
      {orphanMsg.text}
    </p>
  );

  if (positions === null) return <Loading />;
  if (positions.length === 0)
    return (
      <>
        {orphan}
        <Empty text={t('trading.noPositions')} />
      </>
    );

  const draftOf = (p: PaperPosition): Draft =>
    drafts[p.id] ?? {
      sl: p.stopLoss ? String(p.stopLoss.price) : '',
      tps: Object.fromEntries(p.takeProfits.map((tp) => [tp.orderId, String(tp.price)])),
    };

  const setDraft = (id: string, d: Draft) => setDrafts((all) => ({ ...all, [id]: d }));
  const clearDraft = (id: string) =>
    setDrafts((all) => {
      const next = { ...all };
      delete next[id];
      return next;
    });

  async function save(p: PaperPosition, confirmWiden = false) {
    const d = draftOf(p);
    const sl = d.sl.trim() === '' ? undefined : parse(d.sl);
    const tps = p.takeProfits
      .map((tp) => ({ orderId: tp.orderId, price: parse(d.tps[tp.orderId] ?? '') }))
      .filter((x): x is { orderId: string; price: number } => x.price !== null);
    if (sl === null || tps.length !== p.takeProfits.length) {
      setMsg({ id: p.id, ok: false, text: t('position.invalidNumber') });
      return;
    }
    setBusy(p.id);
    setMsg(null);
    try {
      await trpc.trading.updateProtection.mutate({
        positionId: p.id,
        ...(sl !== undefined ? { stopLoss: sl } : {}),
        ...(tps.length > 0 ? { takeProfits: tps } : {}),
        ...(confirmWiden ? { confirmWiden: true } : {}),
      });
      clearDraft(p.id);
      setWidenAsk(null);
      setMsg({ id: p.id, ok: true, text: t('position.saved') });
      onChanged();
    } catch (err) {
      const text = reasonText(t, err);
      if (err instanceof Error && err.message === 'position:widen_requires_confirm') setWidenAsk(p.id);
      else setMsg({ id: p.id, ok: false, text });
    } finally {
      setBusy(null);
    }
  }

  async function closePart(p: PaperPosition, pct: number) {
    setBusy(p.id);
    setMsg(null);
    try {
      const r = await trpc.trading.closePosition.mutate({ positionId: p.id, qty: (p.openQty * pct) / 100 });
      setArmedPartial(null);
      setMsg({
        id: p.id,
        ok: true,
        text: r.partial
          ? t('position.partialDone', { price: fmt(r.exitPrice), qty: fmt(r.remainingQty, 6) })
          : t('position.closedAt', { price: fmt(r.exitPrice), pnl: fmt(r.netPnl) }),
      });
      onChanged();
    } catch (err) {
      setMsg({ id: p.id, ok: false, text: reasonText(t, err) });
    } finally {
      setBusy(null);
    }
  }

  async function setTrailing(p: PaperPosition, pct: number | null) {
    setBusy(p.id);
    setMsg(null);
    try {
      await trpc.trading.updateProtection.mutate({ positionId: p.id, trailPct: pct });
      setTrailDrafts((d) => {
        const next = { ...d };
        delete next[p.id];
        return next;
      });
      setMsg({ id: p.id, ok: true, text: pct === null ? t('position.trailOffDone') : t('position.trailOnDone', { pct: fmt(pct) }) });
      onChanged();
    } catch (err) {
      setMsg({ id: p.id, ok: false, text: reasonText(t, err) });
    } finally {
      setBusy(null);
    }
  }

  async function close(p: PaperPosition) {
    setBusy(p.id);
    setMsg(null);
    try {
      const r = await trpc.trading.closePosition.mutate({ positionId: p.id });
      setArmedClose(null);
      setMsg({
        id: p.id,
        ok: true,
        text: t('position.closedAt', { price: fmt(r.exitPrice), pnl: fmt(r.netPnl) }),
      });
      onChanged();
    } catch (err) {
      setMsg({ id: p.id, ok: false, text: reasonText(t, err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
    {orphan}
    <ul className="mt-4 space-y-3">
      {positions.map((p) => {
        const d = draftOf(p);
        const dirty = drafts[p.id] !== undefined;
        const partial = p.openQty < p.qty - 1e-12;
        return (
          <li key={p.id} className="rounded-[0.625rem] border p-4" style={{ borderColor: 'var(--color-line)' }}>
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <a href={buildChartUrl(p.symbol)} className="num font-medium hover:underline" style={{ color: 'var(--color-cyan)' }}>
                  {p.symbol}
                </a>
                <span className="label" style={{ color: p.direction === 'long' ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                  {p.direction.toUpperCase()}
                </span>
                <span className="label">{p.subAgentId ? t('position.originAgent') : t('position.originSignal')}</span>
              </div>
              <div className="num flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
                <span>
                  <span className="label mr-1.5">{t('position.openQty')}</span>
                  {fmt(p.openQty, 6)}
                  {partial && <span style={{ color: 'var(--color-mut)' }}> / {fmt(p.qty, 6)}</span>}
                </span>
                <span>
                  <span className="label mr-1.5">Entry</span>
                  {fmt(p.entryPrice)}
                </span>
                <span>
                  <span className="label mr-1.5">Mark</span>
                  {fmt(p.markPrice)}
                </span>
                <span style={{ color: (p.unrealizedPnl ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                  <span className="label mr-1.5">{t('trading.uPnl')}</span>
                  {fmt(p.unrealizedPnl)} $
                </span>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span className="label" style={{ color: 'var(--color-neg)' }}>{t('position.stopLoss')}</span>
                <input
                  id={`sl-${p.id}`}
                  value={d.sl}
                  disabled={!p.stopLoss}
                  onChange={(e) => setDraft(p.id, { ...d, sl: e.target.value })}
                  className="field num w-28 px-2 py-1.5 text-sm"
                  inputMode="decimal"
                />
              </label>
              {p.takeProfits.map((tp, i) => (
                <label key={tp.orderId} className="flex flex-col gap-1">
                  <span className="label" style={{ color: 'var(--color-pos)' }}>TP{i + 1}</span>
                  <input
                    id={`tp-${tp.orderId}`}
                    value={d.tps[tp.orderId] ?? ''}
                    onChange={(e) => setDraft(p.id, { ...d, tps: { ...d.tps, [tp.orderId]: e.target.value } })}
                    className="field num w-28 px-2 py-1.5 text-sm"
                    inputMode="decimal"
                  />
                </label>
              ))}
              {dirty && (
                <>
                  <button
                    onClick={() => void save(p)}
                    disabled={busy !== null}
                    className="rounded-[0.625rem] border px-3 py-1.5 text-xs disabled:opacity-50"
                    style={{ borderColor: 'rgba(79,209,255,0.5)', color: 'var(--color-cyan)' }}
                  >
                    {busy === p.id ? '…' : t('position.saveProtection')}
                  </button>
                  <button onClick={() => clearDraft(p.id)} className="px-2 py-1.5 text-xs" style={{ color: 'var(--color-mut)' }}>
                    {t('common.cancel')}
                  </button>
                </>
              )}

              <div className="ml-auto flex items-center gap-2">
                {armedClose === p.id ? (
                  <>
                    <span className="text-xs" style={{ color: 'var(--color-mut)' }}>
                      {t('position.closeAsk', { qty: fmt(p.openQty, 6) })}
                    </span>
                    <button
                      onClick={() => void close(p)}
                      disabled={busy !== null}
                      className="rounded-[0.625rem] border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                      style={{ borderColor: 'rgba(255,92,108,0.6)', color: 'var(--color-neg)', background: 'rgba(255,92,108,0.1)' }}
                    >
                      {busy === p.id ? t('position.closing') : t('position.closeConfirm')}
                    </button>
                    <button onClick={() => setArmedClose(null)} className="px-2 py-1.5 text-xs" style={{ color: 'var(--color-mut)' }}>
                      {t('common.cancel')}
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setArmedClose(p.id)}
                    disabled={busy !== null}
                    className="rounded-[0.625rem] border px-3 py-1.5 text-xs disabled:opacity-50"
                    style={{ borderColor: 'rgba(255,92,108,0.4)', color: 'var(--color-neg)' }}
                  >
                    {t('position.close')}
                  </button>
                )}
              </div>
            </div>

            {/* Gewinn mitnehmen (Teilschluss) + Trailing-Stop */}
            <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3 border-t pt-3" style={{ borderColor: 'rgba(99,140,255,0.12)' }}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="label">{t('position.partialTitle')}</span>
                {armedPartial?.id === p.id ? (
                  <>
                    <span className="text-xs" style={{ color: 'var(--color-mut)' }}>
                      {t('position.partialAsk', { pct: armedPartial.pct, qty: fmt((p.openQty * armedPartial.pct) / 100, 6) })}
                    </span>
                    <button
                      onClick={() => void closePart(p, armedPartial.pct)}
                      disabled={busy !== null}
                      className="rounded-[0.625rem] border px-3 py-1 text-xs font-medium disabled:opacity-50"
                      style={{ borderColor: 'rgba(61,220,151,0.6)', color: 'var(--color-pos)', background: 'rgba(61,220,151,0.08)' }}
                    >
                      {busy === p.id ? '…' : t('position.partialConfirm')}
                    </button>
                    <button onClick={() => setArmedPartial(null)} className="px-1 text-xs" style={{ color: 'var(--color-mut)' }}>
                      {t('common.cancel')}
                    </button>
                  </>
                ) : (
                  [25, 50, 75].map((pct) => (
                    <button
                      key={pct}
                      onClick={() => setArmedPartial({ id: p.id, pct })}
                      disabled={busy !== null || p.openQty <= 0}
                      className="num rounded-[0.625rem] border px-2.5 py-1 text-xs disabled:opacity-50"
                      style={{ borderColor: 'rgba(61,220,151,0.35)', color: 'var(--color-pos)' }}
                    >
                      {pct} %
                    </button>
                  ))
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="label">{t('position.trailing')}</span>
                <input
                  id={`trail-${p.id}`}
                  value={trailDrafts[p.id] ?? (p.trailPct !== null ? String(p.trailPct) : '2')}
                  onChange={(e) => setTrailDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                  disabled={!p.stopLoss}
                  className="field num w-16 px-2 py-1 text-xs"
                  inputMode="decimal"
                  aria-label={t('position.trailing')}
                />
                <span className="text-xs" style={{ color: 'var(--color-mut)' }}>%</span>
                <button
                  onClick={() => {
                    const pct = parse(trailDrafts[p.id] ?? (p.trailPct !== null ? String(p.trailPct) : '2'));
                    if (pct === null || pct < 0.1 || pct > 50) setMsg({ id: p.id, ok: false, text: t('position.err_invalid_trail') });
                    else void setTrailing(p, pct);
                  }}
                  disabled={busy !== null || !p.stopLoss || (p.trailPct !== null && trailDrafts[p.id] === undefined)}
                  className="rounded-[0.625rem] border px-2.5 py-1 text-xs disabled:opacity-40"
                  style={{ borderColor: 'rgba(79,209,255,0.45)', color: 'var(--color-cyan)' }}
                >
                  {p.trailPct === null ? t('position.trailOn') : t('position.trailUpdate')}
                </button>
                {p.trailPct !== null && (
                  <>
                    <span className="label rounded border px-1.5 py-0.5" style={{ borderColor: 'rgba(79,209,255,0.45)', color: 'var(--color-cyan)' }}>
                      {t('position.trailActive', { pct: fmt(p.trailPct) })}
                    </span>
                    <button onClick={() => void setTrailing(p, null)} disabled={busy !== null} className="px-1 text-xs" style={{ color: 'var(--color-mut)' }}>
                      {t('position.trailOff')}
                    </button>
                  </>
                )}
              </div>
            </div>
            <p className="mt-2 text-[11px]" style={{ color: 'var(--color-mut)' }}>
              {t('position.trailHint')}
            </p>

            {widenAsk === p.id && (
              <div
                role="alert"
                className="mt-3 flex flex-wrap items-center gap-3 rounded-[0.625rem] border p-3 text-xs"
                style={{ borderColor: 'rgba(232,184,75,0.5)', color: 'var(--color-warn)' }}
              >
                <span className="min-w-0 flex-1">{t('position.widenWarn')}</span>
                <button
                  onClick={() => void save(p, true)}
                  disabled={busy !== null}
                  className="rounded-[0.625rem] border px-3 py-1.5 font-medium"
                  style={{ borderColor: 'rgba(232,184,75,0.6)' }}
                >
                  {t('position.widenConfirm')}
                </button>
                <button onClick={() => setWidenAsk(null)} style={{ color: 'var(--color-mut)' }}>
                  {t('common.cancel')}
                </button>
              </div>
            )}

            {msg?.id === p.id && (
              <p className="mt-2 text-xs" style={{ color: msg.ok ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                {msg.text}
              </p>
            )}
          </li>
        );
      })}
    </ul>
    </>
  );
}
