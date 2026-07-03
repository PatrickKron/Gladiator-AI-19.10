import { useState } from 'react';
import { trpc } from '../api.js';

export type SignalRow = {
  id: string;
  createdAt: string;
  symbol: string;
  timeframe: string;
  direction: 'long' | 'short';
  setupType: 'scalp' | 'swing' | 'position';
  entry: string;
  stopLoss: string;
  takeProfits: string[];
  score: string;
  riskClass: 'low' | 'medium' | 'high';
  confluence: string[];
  session: string;
  status: string;
  strategySlug: string;
};

function fmt(n: string): string {
  const v = Number(n);
  return v >= 1000
    ? v.toLocaleString('de-DE', { maximumFractionDigits: 0 })
    : v.toLocaleString('de-DE', { maximumFractionDigits: 2 });
}

const RISK_COLOR: Record<SignalRow['riskClass'], string> = {
  low: 'var(--color-pos)',
  medium: 'var(--color-warn)',
  high: 'var(--color-neg)',
};

/**
 * Signal-„Sammelkarte" (09_ §3.2): echtes Setup mit Score, Confluence und
 * Mensch-im-Loop-Entscheidung. EHRLICH: Bestätigen führt noch KEINE Order aus
 * (Ausführung kommt mit Phase 4) — das steht sichtbar auf der Karte.
 */
export function SignalCard({ signal, onDecided }: { signal: SignalRow; onDecided: () => void }) {
  const [busy, setBusy] = useState<'confirm' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string[] | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const long = signal.direction === 'long';
  const dirColor = long ? 'var(--color-pos)' : 'var(--color-neg)';

  async function decide(action: 'confirm' | 'reject') {
    setBusy(action);
    setError(null);
    setBlocked(null);
    try {
      if (action === 'confirm') {
        const res = await trpc.signals.confirm.mutate({ id: signal.id });
        if (res.executed) {
          setSuccess(`✓ ${res.detail} Menge ${res.qty?.toFixed(6)} — Position offen (siehe Trading).`);
          window.setTimeout(onDecided, 2500);
        } else {
          // Risk-Gate hat geblockt — Signal bleibt offen, Gründe anzeigen
          setBlocked(res.riskReasons.length > 0 ? res.riskReasons : [res.detail]);
          setBusy(null);
        }
      } else {
        await trpc.signals.reject.mutate({ id: signal.id });
        onDecided();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Aktion fehlgeschlagen.');
      setBusy(null);
    }
  }

  return (
    <div className="glass glass-hover p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            className="num rounded px-1.5 py-0.5 text-xs font-semibold tracking-wider"
            style={{ color: dirColor, border: `1px solid ${dirColor}`, boxShadow: `0 0 12px ${long ? 'rgba(61,220,151,0.25)' : 'rgba(255,92,108,0.25)'}` }}
          >
            {long ? 'LONG' : 'SHORT'}
          </span>
          <span className="font-medium">{signal.symbol.replace('/USDT', '')}</span>
          <span className="label">{signal.timeframe} · {signal.setupType}</span>
        </div>
        <div className="num text-lg font-semibold" style={{ color: RISK_COLOR[signal.riskClass] }}>
          {Number(signal.score).toLocaleString('de-DE', { minimumFractionDigits: 1 })}
          <span className="text-xs font-normal" style={{ color: 'var(--color-mut)' }}> / 10</span>
        </div>
      </div>

      <div className="num mt-4 grid grid-cols-3 gap-2 text-sm">
        <div>
          <p className="label">Entry</p>
          <p className="mt-0.5">{fmt(signal.entry)}</p>
        </div>
        <div>
          <p className="label">Stop-Loss</p>
          <p className="mt-0.5" style={{ color: 'var(--color-neg)' }}>{fmt(signal.stopLoss)}</p>
        </div>
        <div>
          <p className="label">TP 1–{signal.takeProfits.length}</p>
          <p className="mt-0.5" style={{ color: 'var(--color-pos)' }}>
            {signal.takeProfits.map(fmt).join(' · ')}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {signal.confluence.map((tag) => (
          <span key={tag} className="rounded border px-1.5 py-0.5 text-[11px]" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
            {tag}
          </span>
        ))}
        <span className="rounded border px-1.5 py-0.5 text-[11px]" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
          Session: {signal.session}
        </span>
      </div>

      {error && <p className="mt-3 text-xs" style={{ color: 'var(--color-neg)' }}>{error}</p>}
      {success && (
        <p className="mt-3 rounded border p-2 text-xs" style={{ borderColor: 'rgba(61,220,151,0.4)', color: 'var(--color-pos)' }}>
          {success}
        </p>
      )}
      {blocked && (
        <div className="mt-3 rounded border p-2 text-xs" style={{ borderColor: 'rgba(255,92,108,0.4)', color: 'var(--color-neg)' }}>
          <p className="font-medium">Risk-Gate hat geblockt:</p>
          <ul className="mt-1 list-disc pl-4">
            {blocked.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2.5">
        <button
          onClick={() => void decide('confirm')}
          disabled={busy !== null}
          className="btn-primary flex-1 px-3 py-2 text-sm disabled:opacity-50"
        >
          {busy === 'confirm' ? 'Bestätige …' : 'Bestätigen'}
        </button>
        <button
          onClick={() => void decide('reject')}
          disabled={busy !== null}
          className="flex-1 rounded-[0.625rem] border px-3 py-2 text-sm transition-colors disabled:opacity-50"
          style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
        >
          {busy === 'reject' ? 'Lehne ab …' : 'Ablehnen'}
        </button>
      </div>
      <p className="mt-2.5 text-center text-[11px]" style={{ color: 'var(--color-mut)' }}>
        Bestätigen → Risk-Gate (statisch + adaptiv) → Paper-Order gegen echten Live-Preis. Alles auditiert.
      </p>
    </div>
  );
}
