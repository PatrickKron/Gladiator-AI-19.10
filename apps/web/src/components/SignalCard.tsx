import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';

export type SignalReview = {
  agent: string;
  vote: 'confirm' | 'reject' | 'caution';
  confidence: number;
  reason: string;
  refs: unknown;
};

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
  source: 'engine' | 'pine' | 'instruction' | 'manual';
  strategySlug: string;
  reviews: SignalReview[];
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

const VOTE_COLOR: Record<SignalReview['vote'], string> = {
  confirm: 'var(--color-pos)',
  caution: 'var(--color-warn)',
  reject: 'var(--color-neg)',
};

const VOTE_SYMBOL: Record<SignalReview['vote'], string> = { confirm: '✓', caution: '△', reject: '✕' };

const AGENT_KEY: Record<string, string> = {
  technik: 'signals.agentTechnik',
  risk: 'signals.agentRisk',
  devil: 'signals.agentDevil',
  makro: 'signals.agentMakro',
  shadow: 'signals.agentShadow',
  portfolio: 'signals.agentPortfolio',
};

const SOURCE_KEY: Record<SignalRow['source'], string> = {
  engine: 'signals.sourceEngine',
  pine: 'signals.sourcePine',
  instruction: 'signals.sourceInstruction',
  manual: 'signals.sourceManual',
};

/** Schwarm-Urteile (Phase 5): transparent, aufklappbar — keine Blackbox. */
function SwarmReviews({ reviews }: { reviews: SignalReview[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (reviews.length === 0) {
    return (
      <p className="mt-3 text-[11px]" style={{ color: 'var(--color-mut)' }}>
        {t('signals.reviewPending')}
      </p>
    );
  }
  const portfolio = reviews.find((r) => r.agent === 'portfolio');
  const singles = reviews.filter((r) => r.agent !== 'portfolio');
  const disabled = ((portfolio?.refs as { disabled?: { agent: string; reason: string }[] } | null)?.disabled ?? []);

  return (
    <div className="mt-3 rounded border p-2" style={{ borderColor: 'var(--color-line)' }}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-2 text-left">
        <span className="flex flex-wrap items-center gap-1.5">
          {singles.map((r) => (
            <span
              key={r.agent}
              className="num rounded px-1.5 py-0.5 text-[11px]"
              style={{ color: VOTE_COLOR[r.vote], border: `1px solid ${VOTE_COLOR[r.vote]}` }}
              title={r.reason}
            >
              {VOTE_SYMBOL[r.vote]} {t(AGENT_KEY[r.agent] ?? r.agent)}
            </span>
          ))}
          {disabled.map((d) => (
            <span
              key={d.agent}
              className="rounded border border-dashed px-1.5 py-0.5 text-[11px]"
              style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
              title={d.reason}
            >
              ⊘ {t(AGENT_KEY[d.agent] ?? d.agent)}
            </span>
          ))}
        </span>
        {portfolio && (
          <span className="num shrink-0 text-[11px] font-semibold" style={{ color: VOTE_COLOR[portfolio.vote] }}>
            {VOTE_SYMBOL[portfolio.vote]} {(portfolio.confidence * 100).toFixed(0)} %
          </span>
        )}
      </button>
      {open && (
        <ul className="mt-2 space-y-1.5 text-[11px]" style={{ color: 'var(--color-mut)' }}>
          {[...singles, ...(portfolio ? [portfolio] : [])].map((r) => (
            <li key={r.agent}>
              <span style={{ color: VOTE_COLOR[r.vote] }}>
                {VOTE_SYMBOL[r.vote]} {t(AGENT_KEY[r.agent] ?? r.agent)} ({(r.confidence * 100).toFixed(0)} %):
              </span>{' '}
              {r.reason}
            </li>
          ))}
          {disabled.map((d) => (
            <li key={d.agent}>⊘ {t(AGENT_KEY[d.agent] ?? d.agent)}: {t('common.disabled')} — {d.reason}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Signal-„Sammelkarte" (09_ §3.2): echtes Setup mit Score, Confluence und
 * Mensch-im-Loop-Entscheidung. EHRLICH: Bestätigen führt noch KEINE Order aus
 * (Ausführung kommt mit Phase 4) — das steht sichtbar auf der Karte.
 */
export function SignalCard({ signal, onDecided, readOnly = false }: { signal: SignalRow; onDecided: () => void; readOnly?: boolean }) {
  const { t } = useTranslation();
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
          setSuccess(`✓ ${res.detail} ${t('signals.qty')} ${res.qty?.toFixed(6)} — ${t('signals.executed')}`);
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
      setError(err instanceof Error ? err.message : t('common.error'));
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
          {signal.source !== 'engine' && (
            <span
              className="rounded border px-1.5 py-0.5 text-[10px] tracking-wider"
              style={{ borderColor: 'var(--color-acc2, var(--color-line))', color: 'var(--color-mut)' }}
            >
              {t(SOURCE_KEY[signal.source])}
            </span>
          )}
        </div>
        <div className="num text-lg font-semibold" style={{ color: RISK_COLOR[signal.riskClass] }}>
          {Number(signal.score).toLocaleString('de-DE', { minimumFractionDigits: 1 })}
          <span className="text-xs font-normal" style={{ color: 'var(--color-mut)' }}> / 10</span>
        </div>
      </div>

      <div className="num mt-4 grid grid-cols-3 gap-2 text-sm">
        <div>
          <p className="label">{t('signals.entry')}</p>
          <p className="mt-0.5">{fmt(signal.entry)}</p>
        </div>
        <div>
          <p className="label">{t('signals.stopLoss')}</p>
          <p className="mt-0.5" style={{ color: 'var(--color-neg)' }}>{fmt(signal.stopLoss)}</p>
        </div>
        <div>
          <p className="label">{t('signals.tp')} 1–{signal.takeProfits.length}</p>
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
          {t('common.session')}: {signal.session}
        </span>
      </div>

      <SwarmReviews reviews={signal.reviews} />

      {error && <p className="mt-3 text-xs" style={{ color: 'var(--color-neg)' }}>{error}</p>}
      {success && (
        <p className="mt-3 rounded border p-2 text-xs" style={{ borderColor: 'rgba(61,220,151,0.4)', color: 'var(--color-pos)' }}>
          {success}
        </p>
      )}
      {blocked && (
        <div className="mt-3 rounded border p-2 text-xs" style={{ borderColor: 'rgba(255,92,108,0.4)', color: 'var(--color-neg)' }}>
          <p className="font-medium">{t('signals.riskBlocked')}</p>
          <ul className="mt-1 list-disc pl-4">
            {blocked.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}

      {!readOnly && (
        <>
          <div className="mt-4 flex items-center gap-2.5">
            <button
              onClick={() => void decide('confirm')}
              disabled={busy !== null}
              className="btn-primary flex-1 px-3 py-2 text-sm disabled:opacity-50"
            >
              {busy === 'confirm' ? t('signals.confirming') : t('signals.confirmBtn')}
            </button>
            <button
              onClick={() => void decide('reject')}
              disabled={busy !== null}
              className="flex-1 rounded-[0.625rem] border px-3 py-2 text-sm transition-colors disabled:opacity-50"
              style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
            >
              {busy === 'reject' ? t('signals.rejecting') : t('signals.rejectBtn')}
            </button>
          </div>
          <p className="mt-2.5 text-center text-[11px]" style={{ color: 'var(--color-mut)' }}>
            {t('signals.footer')}
          </p>
        </>
      )}
    </div>
  );
}
