import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { SignalCard, type SignalRow } from './SignalCard.js';
import { FavStarSymbol } from './FavStar.js';
import { ageText, expiryLeftMs, formatDuration, swarmVerdict, TTL_HOURS } from '../lib/signal-list.js';
import { appLocale } from '../lib/locale.js';

/**
 * Kompakte Signal-ZEILE für den Feed (Patrick: „unübersichtlich, zu klein,
 * unklar beschriftet" → scanbare Zeilen statt riesiger Karten).
 *
 * EHRLICHKEIT VOR DEM KLICK (Live-Befund 2026-07-09): Der Risk-Agent lehnt
 * real fast alle Signale hart ab (Margin > Konto, Exposure > 20-%-Limit) —
 * das Risk-Gate blockt „Bestätigen" dann IMMER. Deshalb zeigt die Zeile das
 * Risk-Veto prominent (roter Chip) und der Bestätigen-Button wechselt in
 * einen erklärten „Risk blockt"-Zustand, statt den Fehler erst nach dem
 * Klick zu offenbaren. Der Klick bleibt möglich, weil das Gate LIVE
 * entscheidet (Positionen/Preise können sich geändert haben) — ausgeführt
 * wird nur bei echter Freigabe.
 *
 * Details (Chart, alle Agenten-Begründungen, Intelligence) liefert die
 * bestehende SignalCard beim Aufklappen — bewusst wiederverwendet, damit es
 * genau EINE Detail-Wahrheit gibt (Karte bleibt unverändert, Dashboard nutzt
 * sie weiter).
 */

// Lokale Spiegel der SignalCard-Konstanten: die Karte exportiert sie nicht,
// und wir dürfen sie nicht anfassen (gemeinsame Komponente, Regel „additiv").
const VOTE_COLOR: Record<'confirm' | 'caution' | 'reject', string> = {
  confirm: 'var(--color-pos)',
  caution: 'var(--color-warn)',
  reject: 'var(--color-neg)',
};
const VOTE_SYMBOL: Record<'confirm' | 'caution' | 'reject', string> = { confirm: '✓', caution: '△', reject: '✕' };
const AGENT_KEY: Record<string, string> = {
  technik: 'signals.agentTechnik',
  risk: 'signals.agentRisk',
  devil: 'signals.agentDevil',
  makro: 'signals.agentMakro',
  shadow: 'signals.agentShadow',
  institutional: 'signals.agentInstitutional',
  hedge: 'signals.agentHedge',
  portfolio: 'signals.agentPortfolio',
};
const RISK_COLOR: Record<SignalRow['riskClass'], string> = {
  low: 'var(--color-pos)',
  medium: 'var(--color-warn)',
  high: 'var(--color-neg)',
};
const STATUS_CHIP: Record<string, { key: string; color: string }> = {
  confirmed: { key: 'signals.statusConfirmed', color: 'var(--color-cyan)' },
  filled: { key: 'signals.statusFilled', color: 'var(--color-pos)' },
  closed: { key: 'signals.statusClosed', color: 'var(--color-mut)' },
  rejected: { key: 'signals.statusRejected', color: 'var(--color-neg)' },
  expired: { key: 'signals.statusExpired', color: 'var(--color-mut)' },
};

function fmt(n: string): string {
  const v = Number(n);
  return v >= 1000
    ? v.toLocaleString(appLocale(), { maximumFractionDigits: 0 })
    : v.toLocaleString(appLocale(), { maximumFractionDigits: 2 });
}

export function SignalListRow({ signal, onDecided }: { signal: SignalRow; onDecided: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const long = signal.direction === 'long';
  const dirColor = long ? 'var(--color-pos)' : 'var(--color-neg)';
  const isNew = signal.status === 'new';
  const isExpired = signal.status === 'expired';
  const now = Date.now();
  const verdict = swarmVerdict(signal.reviews);
  const score = Number(signal.score);

  // Restlaufzeit nur für offene Signale — Ampel „bald" bei < 25 % der TTL (wie auf der Karte).
  const leftMs = isNew ? expiryLeftMs(signal.createdAt, signal.timeframe, now) : null;
  const ttlMs = (TTL_HOURS[signal.timeframe] ?? 24) * 3_600_000;
  const expirySoon = leftMs !== null && leftMs < ttlMs * 0.25;

  // Tooltip fürs Schwarm-Kurzurteil: jede Agenten-Begründung, Portfolio zuletzt.
  const verdictTooltip =
    verdict.lines.length === 0
      ? t('signals.reviewPending')
      : verdict.lines
          .map((r) => `${VOTE_SYMBOL[r.vote]} ${t(AGENT_KEY[r.agent] ?? r.agent)} (${Math.round(r.confidence * 100)} %): ${r.reason}`)
          .join('\n');

  async function decide(action: 'confirm' | 'reject') {
    if (action === 'confirm') {
      // EIN Trade-Flow überall (Umbau 2026-07-10): Bestätigen öffnet die
      // Detail-Karte mit dem anpassbaren Ticket (Betrag/Hebel/SL/TP) —
      // die Zeile platziert selbst KEINE Order mehr.
      setOpen(true);
      return;
    }
    setBusy(action);
    setError(null);
    try {
      await trpc.signals.reject.mutate({ id: signal.id });
      onDecided();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
      setBusy(null);
    }
  }

  const statusChip = STATUS_CHIP[signal.status];

  return (
    <div className={isExpired ? 'opacity-45' : undefined}>
      {/* Kopfzeile der Row — Klick klappt Details auf (SignalCard) */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        title={open ? t('signals.collapseRow') : t('signals.expandRow')}
        className="cursor-pointer px-3 py-2.5 transition-colors hover:bg-[rgba(120,140,255,0.05)] sm:px-4"
      >
        {/* Zeile 1: Richtung + Symbol (groß) · TF/Setup · Score-Balken · Schwarm-Urteil */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span
            className="num inline-block w-16 shrink-0 rounded px-1 py-0.5 text-center text-xs font-semibold tracking-wider"
            style={{ color: dirColor, border: `1px solid ${dirColor}`, boxShadow: `0 0 10px ${long ? 'rgba(34,197,94,0.22)' : 'rgba(239,68,68,0.22)'}` }}
          >
            {long ? 'LONG' : 'SHORT'}
          </span>
          <span className="flex items-center gap-0.5 text-base font-semibold tracking-tight">
            {signal.symbol.replace('/USDT', '')}
            <FavStarSymbol symbol={signal.symbol} initialFavorite={signal.isFavorite} />
          </span>
          <span className="label">{signal.timeframe} · {signal.setupType}</span>

          {/* Score als Balken — Farbe = Risikoklasse (dieselbe Semantik wie auf der Karte) */}
          <span
            className="flex items-center gap-1.5"
            title={t('signals.scoreTitle', { n: score.toLocaleString(appLocale(), { minimumFractionDigits: 1 }), risk: t(`signals.risk_${signal.riskClass}`) })}
          >
            <span className="h-1.5 w-16 overflow-hidden rounded" style={{ background: 'rgba(255,255,255,0.08)' }}>
              <span
                className="block h-full rounded"
                style={{ width: `${Math.min(100, Math.max(0, score * 10))}%`, background: RISK_COLOR[signal.riskClass] }}
              />
            </span>
            <span className="num text-xs font-semibold" style={{ color: RISK_COLOR[signal.riskClass] }}>
              {score.toLocaleString(appLocale(), { minimumFractionDigits: 1 })}
            </span>
          </span>

          {/* Schwarm-Kurzurteil (✓/△/✕) + hartes Risk-Veto — VOR jedem Klick sichtbar */}
          <span className="ml-auto flex items-center gap-1.5">
            {verdict.vote === null ? (
              <span className="text-xs" style={{ color: 'var(--color-mut)' }} title={t('signals.reviewPending')}>
                {t('signals.swarmVerdict')}: —
              </span>
            ) : (
              <span
                className="num cursor-help rounded border px-1.5 py-0.5 text-xs font-semibold"
                style={{ color: VOTE_COLOR[verdict.vote], borderColor: VOTE_COLOR[verdict.vote] }}
                title={`${t('signals.swarmVerdict')}\n${verdictTooltip}`}
              >
                {VOTE_SYMBOL[verdict.vote]} {verdict.confidence !== null ? `${Math.round(verdict.confidence * 100)} %` : ''}
              </span>
            )}
            {verdict.riskReject && !isExpired && (
              <span
                className="cursor-help rounded border px-1.5 py-0.5 text-[11px] font-medium"
                style={{ color: 'var(--color-neg)', borderColor: 'rgba(239,68,68,0.55)', background: 'rgba(239,68,68,0.08)' }}
                title={t('signals.riskVetoHint', { reason: verdict.riskReject })}
              >
                ✕ {t('signals.riskVeto')}
              </span>
            )}
            {statusChip && (
              <span className="rounded border px-1.5 py-0.5 text-[11px]" style={{ color: statusChip.color, borderColor: 'var(--color-line)' }}>
                {t(statusChip.key)}
              </span>
            )}
          </span>
        </div>

        {/* Zeile 2: Entry/SL/TP kompakt · Alter/Ablauf · Aktionen */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          <span className="num flex flex-wrap items-center gap-x-3" style={{ color: 'var(--color-ink)' }}>
            <span><span style={{ color: 'var(--color-mut)' }}>{t('signals.entry')}</span> {fmt(signal.entry)}</span>
            <span title={t('signals.stopLoss')}><span style={{ color: 'var(--color-mut)' }}>SL</span> <span style={{ color: 'var(--color-neg)' }}>{fmt(signal.stopLoss)}</span></span>
            <span><span style={{ color: 'var(--color-mut)' }}>{t('signals.tp')}</span> <span style={{ color: 'var(--color-pos)' }}>{signal.takeProfits.map(fmt).join(' · ')}</span></span>
          </span>

          <span style={{ color: 'var(--color-mut)' }}>
            {t('signals.age', { time: ageText(signal.createdAt, now) })}
            {leftMs !== null && (
              <span style={{ color: expirySoon ? 'var(--color-warn)' : 'var(--color-mut)' }} title={t('signals.expiresHint')}>
                {' '}· ⏳ {t('signals.expiresIn', { time: leftMs > 0 ? formatDuration(leftMs) : '≤ 1 min' })}
              </span>
            )}
          </span>

          {isNew && (
            <span className="ml-auto flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              {verdict.riskReject ? (
                // Ehrlicher Button-Zustand: Risk-Veto liegt vor → Klick prüft trotzdem LIVE am Gate.
                <button
                  onClick={() => void decide('confirm')}
                  disabled={busy !== null}
                  className="rounded-[0.625rem] border border-dashed px-2.5 py-1 text-xs disabled:opacity-50"
                  style={{ borderColor: 'rgba(239,68,68,0.6)', color: 'var(--color-neg)' }}
                  title={t('signals.blockedBtnHint', { reason: verdict.riskReject })}
                >
                  ⛔ {t('signals.blockedBtn')}
                </button>
              ) : (
                <button
                  onClick={() => void decide('confirm')}
                  disabled={busy !== null}
                  className="btn-primary px-2.5 py-1 text-xs disabled:opacity-50"
                >
                  {t('signals.confirmBtn')}
                </button>
              )}
              <button
                onClick={() => void decide('reject')}
                disabled={busy !== null}
                className="rounded-[0.625rem] border px-2.5 py-1 text-xs transition-colors disabled:opacity-50"
                style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
              >
                {busy === 'reject' ? t('signals.rejecting') : t('signals.rejectBtn')}
              </button>
            </span>
          )}
          <span className="text-[11px]" style={{ color: 'var(--color-mut)', marginLeft: isNew ? undefined : 'auto' }}>
            {open ? '▾' : '▸'} {open ? t('signals.collapseRow') : t('signals.expandRow')}
          </span>
        </div>
      </div>

      {/* Fehler beim Ablehnen (Ausführung läuft seit dem Umbau NUR über die Karte unten) */}
      {error && (
        <p className="px-4 pb-2 text-xs" style={{ color: 'var(--color-neg)' }}>{error}</p>
      )}

      {/* Aufgeklappt: die bestehende Sammelkarte als einzige Detail-Wahrheit */}
      {open && (
        <div className="px-3 pb-3 sm:px-4">
          {verdict.riskReject && isNew && (
            <div className="mb-3 rounded border p-2.5 text-xs leading-relaxed" style={{ borderColor: 'rgba(239,68,68,0.45)', color: 'var(--color-neg)' }}>
              {t('signals.riskVetoHint', { reason: verdict.riskReject })}
            </div>
          )}
          <SignalCard signal={signal} onDecided={onDecided} readOnly={!isNew} />
        </div>
      )}
    </div>
  );
}
