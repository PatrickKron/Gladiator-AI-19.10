import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { SignalChart } from './SignalChart.js';
import { FavStarSymbol } from './FavStar.js';
import { MlBadge } from './MlBadge.js';
import { RegimeBadge } from './RegimeBadge.js';
import { buildChartUrl } from '../lib/chart-url.js';
import { getUiMode } from '../lib/ui-mode.js';
import { lifecycleChips, type AutoKillInfo, type LeverageUpgradeInfo, type ReentryInfo } from '../lib/signal-lifecycle.js';

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
  isFavorite?: boolean;
  /** 05_ §9: Reentry-Plan, Hebel-Upgrade (inkl. Vorschlag), Auto-Kill-Grund. */
  reentry?: ReentryInfo | null;
  leverageUpgrade?: LeverageUpgradeInfo | null;
  autoKill?: AutoKillInfo | null;
};

function fmt(n: string): string {
  const v = Number(n);
  return v >= 1000
    ? v.toLocaleString('de-DE', { maximumFractionDigits: 0 })
    : v.toLocaleString('de-DE', { maximumFractionDigits: 2 });
}

/** Ablauf-Frist je Timeframe in Stunden — Spiegel der Backend-Regel (signal-expiry.ts). */
const TTL_HOURS: Record<string, number> = { '15m': 4, '1h': 12, '4h': 48, '1d': 120 };

/** Verbleibende Gültigkeit eines offenen Signals (null = überfällig, läuft beim nächsten Scan ab). */
function expiryInfo(createdAt: string, timeframe: string): { text: string; soon: boolean } | null {
  const ttlMs = (TTL_HOURS[timeframe] ?? 24) * 3_600_000;
  const leftMs = ttlMs - (Date.now() - new Date(createdAt).getTime());
  if (leftMs <= 0) return null;
  const h = leftMs / 3_600_000;
  const text = h >= 1 ? `${Math.round(h)} h` : `${Math.max(1, Math.round(leftMs / 60_000))} min`;
  return { text, soon: leftMs < ttlMs * 0.25 };
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
  institutional: 'signals.agentInstitutional',
  hedge: 'signals.agentHedge',
  portfolio: 'signals.agentPortfolio',
};

const SOURCE_KEY: Record<SignalRow['source'], string> = {
  engine: 'signals.sourceEngine',
  pine: 'signals.sourcePine',
  instruction: 'signals.sourceInstruction',
  manual: 'signals.sourceManual',
};

/** Herkunft erklären statt nur etikettieren — Tooltip je Quelle (UX: "Woher kommt das Signal?"). */
const SOURCE_HINT: Record<SignalRow['source'], string> = {
  engine: 'signals.sourceEngineHint',
  pine: 'signals.sourcePineHint',
  instruction: 'signals.sourceInstructionHint',
  manual: 'signals.sourceManualHint',
};

const CHIP_COLOR: Record<'info' | 'warn' | 'neg' | 'mut', string> = {
  info: 'var(--color-cyan)',
  warn: 'var(--color-warn)',
  neg: 'var(--color-neg)',
  mut: 'var(--color-mut)',
};

/** Reentry-/Hebel-Upgrade-/Auto-Kill-Hinweise (05_ §9) — kompakt, Details im Tooltip. */
function LifecycleChips({ signal }: { signal: SignalRow }) {
  const { t } = useTranslation();
  const chips = lifecycleChips({
    status: signal.status,
    reentry: signal.reentry,
    leverageUpgrade: signal.leverageUpgrade,
    autoKill: signal.autoKill,
  });
  if (chips.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <span
          key={c.key}
          className="num cursor-help rounded border px-1.5 py-0.5 text-[11px]"
          style={{ borderColor: CHIP_COLOR[c.tone], color: CHIP_COLOR[c.tone] }}
          title={t(c.hintKey, c.hintParams)}
        >
          {c.reasonKey ? t(c.key, { reason: t(c.reasonKey, c.params) }) : t(c.key, c.params)}
        </span>
      ))}
    </div>
  );
}

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

type SignalIntel = {
  assetIsExample: boolean;
  marketRegime: string | null;
  scoreComponents: Record<string, number> | null;
  riskClass: string | null;
  positionSizeMode: string | null;
  hedgeMode: string | null;
  cpiStatus: string;
  cotStatus: string;
  buffettStatus: string;
  shadowWarning: string;
  oracleMacroSummary: string;
  devilsAdvocate: string;
  finalDecision: string | null;
  explanationForUser: string;
};

const DECISION_COLOR: Record<string, string> = {
  signal: 'var(--color-pos)',
  wait: 'var(--color-warn)',
  hedge: 'var(--color-warn)',
  no_trade: 'var(--color-neg)',
};

const INTEL_COMPONENTS = ['technical', 'macroCpi', 'liquidityShadow', 'cotPositioning', 'valuationBuffett', 'riskReward'] as const;

/**
 * KI-Intelligence-Schicht des Signals (PDF §11): CPI-/COT-/Bewertungs-Status,
 * Score-Komponenten, Hedge-Modus und finale Entscheidung — lazy geladen beim
 * Aufklappen. Ohne Anreicherung: ehrlicher Hinweis statt Fake.
 */
function IntelligenceSection({ signalId }: { signalId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [intel, setIntel] = useState<SignalIntel | null | 'loading' | 'error'>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && (intel === null || intel === 'error')) {
      setIntel('loading');
      try {
        const row = (await trpc.intelligence.signalIntelligence.query({ signalId })) as SignalIntel | null;
        setIntel(row);
      } catch {
        setIntel('error');
      }
    }
  }

  return (
    <div className="mt-2">
      <button onClick={() => void toggle()} className="text-xs" style={{ color: 'var(--color-violet)' }}>
        {open ? `− ${t('intel.signalHide')}` : `+ ${t('intel.signalShow')}`}
      </button>
      {open && intel === 'loading' && (
        <p className="mt-2 animate-pulse text-[11px]" style={{ color: 'var(--color-mut)' }}>{t('common.loading')}</p>
      )}
      {open && intel === 'error' && (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--color-neg)' }}>{t('intel.loadError')}</p>
      )}
      {open && intel === null && (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--color-mut)' }}>{t('intel.signalNone')}</p>
      )}
      {open && intel !== null && intel !== 'loading' && intel !== 'error' && (
        <div className="mt-2 rounded border p-2.5" style={{ borderColor: 'var(--color-line)' }}>
          <div className="flex flex-wrap items-center gap-1.5">
            {intel.finalDecision && (
              <span
                className="rounded px-1.5 py-0.5 text-[11px] font-semibold tracking-wider"
                style={{ color: DECISION_COLOR[intel.finalDecision] ?? 'var(--color-mut)', border: `1px solid ${DECISION_COLOR[intel.finalDecision] ?? 'var(--color-line)'}` }}
              >
                {t(`intel.decision_${intel.finalDecision}`)}
              </span>
            )}
            {intel.hedgeMode && (
              <span className="rounded border px-1.5 py-0.5 text-[11px]" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
                {t(`intel.hedge_${intel.hedgeMode}`)}
              </span>
            )}
            {intel.cpiStatus !== 'none' && (
              <span className="rounded border px-1.5 py-0.5 text-[11px]" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
                CPI: {t(`intel.cpiPhase_${intel.cpiStatus}`)}
              </span>
            )}
            {intel.cotStatus !== 'not_applicable' && (
              <span className="rounded border px-1.5 py-0.5 text-[11px]" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
                COT: {t(`intel.cotStatus_${intel.cotStatus}`)}
              </span>
            )}
            {intel.buffettStatus !== 'not_applicable' && (
              <span className="rounded border px-1.5 py-0.5 text-[11px]" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
                Buffett: {t(`intel.buffettStatus_${intel.buffettStatus}`)}
              </span>
            )}
          </div>
          {intel.scoreComponents && (
            <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
              {INTEL_COMPONENTS.filter((c) => typeof intel.scoreComponents?.[c] === 'number').map((c) => {
                const v = intel.scoreComponents![c]!;
                return (
                  <div key={c}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px]" style={{ color: 'var(--color-mut)' }}>{t(`intel.comp_${c}`)}</span>
                      <span className="num text-[10px]" style={{ color: 'var(--color-mut)' }}>{(v * 100).toFixed(0)}</span>
                    </div>
                    <div className="mt-0.5 h-1 w-full overflow-hidden rounded" style={{ background: 'rgba(255,255,255,0.06)' }}>
                      <div
                        className="h-full rounded"
                        style={{ width: `${Math.round(v * 100)}%`, background: v >= 0.55 ? 'var(--color-pos)' : v >= 0.4 ? 'var(--color-warn)' : 'var(--color-neg)' }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {intel.shadowWarning && (
            <p className="mt-2 text-[11px]" style={{ color: 'var(--color-warn)' }}>⚠ {intel.shadowWarning}</p>
          )}
          {intel.devilsAdvocate && (
            <p className="mt-1.5 text-[11px]" style={{ color: 'var(--color-mut)' }}>
              <span style={{ color: 'var(--color-neg)' }}>{t('intel.devilsAdvocate')}:</span> {intel.devilsAdvocate}
            </p>
          )}
          {intel.explanationForUser && (
            <p className="mt-1.5 text-[11px] leading-relaxed" style={{ color: 'var(--color-mut)' }}>{intel.explanationForUser}</p>
          )}
        </div>
      )}
    </div>
  );
}

type ExecPreview = Awaited<ReturnType<typeof trpc.signals.executionPreview.query>>;

type ExperienceOk = Extract<ExecPreview['experience'], { available: true }>;

/**
 * „Vorschlag aus Erfahrung": gelernte Parameter des passenden Clusters aus
 * echten Labor- und Paper-Trades (VDB2). Ein Klick übernimmt Hebel + Betrag
 * (aus Risiko %) ins Ticket — bestätigt wird weiterhin manuell, das
 * Risk-Gate prüft beim Ausführen erneut. Kein Vorschlag → ehrlicher Grund.
 */
function ExperienceSuggestion({ preview, onApply }: { preview: ExecPreview; onApply: (e: ExperienceOk) => void }) {
  const { t } = useTranslation();
  const exp = preview.experience;
  if (!exp.available) {
    const text =
      exp.reason === 'low_sample'
        ? t('ticket.experienceNoneLowSample', { n: exp.tradeCount, min: exp.minTrades })
        : exp.reason === 'not_recommended'
          ? t('ticket.experienceNoneNotRecommended')
          : exp.reason === 'error'
            ? t('ticket.experienceNoneError')
            : t('ticket.experienceNoneNoData');
    return (
      <p className="mt-2 text-[11px]" style={{ color: 'var(--color-mut)' }}>
        {text}
      </p>
    );
  }
  return (
    <div className="mt-2 rounded border p-2 text-[11px]" style={{ borderColor: 'var(--color-line)' }}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs">{t('ticket.experienceTitle', { n: exp.tradeCount })}</span>
        <button className="underline decoration-dotted" onClick={() => onApply(exp)}>
          {t('ticket.experienceApply')}
        </button>
      </div>
      <p className="num mt-1">
        {t('ticket.experienceDetail', {
          lev: exp.leverage,
          risk: exp.riskPct.toLocaleString('de-DE', { maximumFractionDigits: 2 }),
          schema: exp.tpSchema,
        })}
      </p>
      <p className="mt-1" style={{ color: 'var(--color-mut)' }}>
        {exp.level !== 'exact' && <>{t('ticket.experienceFallback')} </>}
        {(exp.capped.leverage || exp.capped.riskPct) && <>{t('ticket.experienceCapped')} </>}
        {exp.tpSchema !== 'A' && <>{t('ticket.experienceSchemaInfo', { schema: exp.tpSchema })} </>}
        {t('ticket.experienceHint')}
      </p>
    </div>
  );
}

/**
 * Anpassbares Order-Ticket (Patricks Kernwunsch B): Das Signal zeigt den
 * Strategie-Vorschlag (Betrag/Hebel/SL/TP) — der User kann ALLES anpassen,
 * bevor er bestätigt. Der Vorschlag bleibt sichtbar als Referenz. Betrag in €
 * mit ECHTEM Kurs (kein Kurs → Betrag-Anpassung ehrlich deaktiviert).
 * Einfach-Modus spricht Klartext („Verkaufe automatisch bei −x %"),
 * Profi sieht Rohwerte.
 */
function AdjustTicket({
  signal,
  onExecute,
  onCancel,
  busy,
}: {
  signal: SignalRow;
  onExecute: (overrides: { amountEur?: number; leverage?: number; stopLoss?: number; takeProfits?: number[] } | null) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<ExecPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [amountEur, setAmountEur] = useState<number | null>(null);
  const [leverage, setLeverage] = useState(1);
  const [slPct, setSlPct] = useState<number | null>(null);
  const [tps, setTps] = useState<number[]>(signal.takeProfits.map(Number));
  const [dirty, setDirty] = useState(false);
  const profi = getUiMode() === 'profi';

  const entry = Number(signal.entry);
  const long = signal.direction === 'long';
  const suggestedSlPct = (Math.abs(entry - Number(signal.stopLoss)) / entry) * 100;

  useEffect(() => {
    let cancelled = false;
    trpc.signals.executionPreview
      .query({ id: signal.id })
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        setAmountEur(p.suggested.notionalEur !== null ? Math.round(p.suggested.notionalEur) : null);
        setLeverage(p.suggested.leverage);
        setSlPct(Math.round(suggestedSlPct * 10) / 10);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [signal.id]);

  if (loadError) {
    return (
      <div className="mt-4 rounded border p-3 text-xs" style={{ borderColor: 'rgba(255,92,108,0.4)', color: 'var(--color-neg)' }}>
        {loadError}
        <button className="ml-2 underline" onClick={onCancel}>{t('common.close')}</button>
      </div>
    );
  }
  if (!preview) {
    return <p className="mt-4 animate-pulse text-xs" style={{ color: 'var(--color-mut)' }}>{t('common.loading')}</p>;
  }

  const rate = preview.eurUsdRate;
  const maxEur = rate !== null ? Math.max(10, Math.floor(preview.limits.maxNotionalUsd / rate)) : null;
  const minEur = rate !== null ? Math.max(1, Math.ceil(preview.limits.minNotionalUsd / rate)) : null;
  const slPrice = slPct !== null ? (long ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100)) : Number(signal.stopLoss);
  const amountUsd = amountEur !== null && rate !== null ? amountEur * rate : preview.suggested.notionalUsd;
  // Live-Kostenvorschau: Taker-Gebühr 0,04 % (Paper-Kostenmodell) auf Ein- und Ausstieg
  const feeEstUsd = amountUsd !== null ? amountUsd * 0.0004 * 2 : null;
  const riskUsd = amountUsd !== null && slPct !== null ? amountUsd * (slPct / 100) : null;

  const num = (n: number | null, unit: string, digits = 0) =>
    n === null ? '—' : `${n.toLocaleString('de-DE', { maximumFractionDigits: digits })} ${unit}`;

  const send = () => {
    if (!dirty) {
      onExecute(null); // nichts angepasst → Standardpfad (Strategie-Vorschlag)
      return;
    }
    onExecute({
      ...(amountEur !== null && rate !== null ? { amountEur } : {}),
      ...(leverage !== preview.suggested.leverage || leverage > 1 ? { leverage } : {}),
      ...(slPct !== null ? { stopLoss: Math.round(slPrice * 1e6) / 1e6 } : {}),
      ...(tps.length > 0 ? { takeProfits: tps.slice(0, 3) } : {}),
    });
  };

  return (
    <div className="mt-4 rounded border p-3" style={{ borderColor: 'rgba(99,140,255,0.35)' }}>
      {/* Referenz: was die Strategie vorschlägt — bleibt IMMER sichtbar */}
      <p className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
        {t('ticket.suggestionRef', {
          amount:
            preview.suggested.notionalEur !== null
              ? `${Math.round(preview.suggested.notionalEur).toLocaleString('de-DE')} €`
              : num(preview.suggested.notionalUsd, '$'),
          lev: preview.suggested.leverage,
          sl: fmt(signal.stopLoss),
        })}
        <button
          className="ml-2 underline decoration-dotted"
          onClick={() => {
            setAmountEur(preview.suggested.notionalEur !== null ? Math.round(preview.suggested.notionalEur) : null);
            setLeverage(preview.suggested.leverage);
            setSlPct(Math.round(suggestedSlPct * 10) / 10);
            setTps(signal.takeProfits.map(Number));
            setDirty(false);
          }}
        >
          {t('ticket.reset')}
        </button>
      </p>

      {/* Vorschlag aus Erfahrung (13_ §7): VDB2-Cluster, durch Risk-Settings gedeckelt — nur Angebot */}
      <ExperienceSuggestion
        preview={preview}
        onApply={(exp) => {
          setLeverage(exp.leverage);
          // Risiko % → Betrag: Positionswert so, dass der Stop-Abstand genau exp.riskPct des Kontos kostet
          if (rate !== null && maxEur !== null && minEur !== null && slPct !== null && slPct > 0) {
            const usd = (preview.limits.equityUsd * (exp.riskPct / 100)) / (slPct / 100);
            setAmountEur(Math.min(maxEur, Math.max(minEur, Math.round(usd / rate))));
          }
          setDirty(true);
        }}
      />

      {/* Betrag in € */}
      <div className="mt-3">
        <div className="flex items-center justify-between text-xs">
          <span>{t('ticket.amount')}</span>
          <span className="num">{rate !== null ? num(amountEur, '€') : num(preview.suggested.notionalUsd, '$')}</span>
        </div>
        {rate !== null && maxEur !== null && minEur !== null ? (
          <div className="mt-1 flex items-center gap-2">
            <input
              type="range"
              min={minEur}
              max={maxEur}
              step={1}
              value={amountEur ?? minEur}
              onChange={(e) => {
                setAmountEur(Number(e.target.value));
                setDirty(true);
              }}
              className="w-full"
            />
            <input
              type="number"
              className="field w-24 px-2 py-1 text-xs"
              min={minEur}
              max={maxEur}
              value={amountEur ?? ''}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) {
                  setAmountEur(Math.min(maxEur, Math.max(minEur, v)));
                  setDirty(true);
                }
              }}
            />
          </div>
        ) : (
          <p className="mt-1 text-[11px]" style={{ color: 'var(--color-warn)' }}>
            {t('ticket.noRate')}
          </p>
        )}
      </div>

      {/* Hebel */}
      <div className="mt-3">
        <div className="flex items-center justify-between text-xs">
          <span>
            {t('ticket.leverage')}
            {!profi && (
              <span className="ml-1 cursor-help" title={t('ticket.leverageHint')} style={{ color: 'var(--color-mut)' }}>ⓘ</span>
            )}
          </span>
          <span className="num">{leverage}×</span>
        </div>
        <input
          type="range"
          min={1}
          max={Math.max(1, Math.round(preview.limits.maxLeverage))}
          step={1}
          value={leverage}
          onChange={(e) => {
            setLeverage(Number(e.target.value));
            setDirty(true);
          }}
          className="mt-1 w-full"
        />
      </div>

      {/* Absicherung (Stop-Loss in Klartext) */}
      <div className="mt-3">
        <div className="flex items-center justify-between text-xs">
          <span>
            {profi ? t('ticket.stopLossPro') : t('ticket.protection')}
            {!profi && (
              <span className="ml-1 cursor-help" title={t('ticket.protectionHint')} style={{ color: 'var(--color-mut)' }}>ⓘ</span>
            )}
          </span>
          <span className="num">
            {slPct !== null ? `−${slPct.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %` : '—'}
            {profi && slPct !== null && <span style={{ color: 'var(--color-mut)' }}> ({slPrice.toLocaleString('de-DE', { maximumFractionDigits: 6 })})</span>}
          </span>
        </div>
        <input
          type="range"
          min={0.5}
          max={Math.max(15, Math.ceil(suggestedSlPct * 2))}
          step={0.1}
          value={slPct ?? suggestedSlPct}
          onChange={(e) => {
            setSlPct(Number(e.target.value));
            setDirty(true);
          }}
          className="mt-1 w-full"
        />
        {!profi && slPct !== null && (
          <p className="mt-0.5 text-[11px]" style={{ color: 'var(--color-mut)' }}>
            {t('ticket.protectionText', { pct: slPct.toLocaleString('de-DE', { maximumFractionDigits: 1 }) })}
          </p>
        )}
      </div>

      {/* Gewinnziele (Profi: Preise editierbar) */}
      {profi && (
        <div className="mt-3">
          <p className="text-xs">{t('ticket.takeProfits')}</p>
          <div className="mt-1 flex gap-2">
            {tps.map((tp, i) => (
              <input
                key={i}
                type="number"
                className="field w-full px-2 py-1 text-xs"
                value={tp}
                step="any"
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v > 0) {
                    setTps((old) => old.map((x, j) => (j === i ? v : x)));
                    setDirty(true);
                  }
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Live-Kostenvorschau + echtes Risiko */}
      <div className="mt-3 grid grid-cols-2 gap-2 rounded border p-2 text-[11px]" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
        <span>
          {t('ticket.feeEstimate')}: <span className="num" style={{ color: 'var(--color-ink)' }}>{feeEstUsd !== null ? `≈ ${num(rate !== null ? feeEstUsd / rate : feeEstUsd, rate !== null ? '€' : '$', 2)}` : '—'}</span>
        </span>
        <span>
          {t('ticket.maxRisk')}: <span className="num" style={{ color: 'var(--color-neg)' }}>{riskUsd !== null ? `≈ ${num(rate !== null ? riskUsd / rate : riskUsd, rate !== null ? '€' : '$', 2)}` : '—'}</span>
        </span>
      </div>

      {preview.gateReasons.length > 0 && (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--color-warn)' }}>
          ⚠ {preview.gateReasons.join(' · ')}
          {dirty && <span style={{ color: 'var(--color-mut)' }}> {t('ticket.gateRecheck')}</span>}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button onClick={send} disabled={busy} className="btn-primary flex-1 px-3 py-2 text-sm disabled:opacity-50">
          {busy ? t('signals.confirming') : t('ticket.executeNow')}
        </button>
        <button onClick={onCancel} disabled={busy} className="rounded-[0.625rem] border px-3 py-2 text-sm" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
          {t('common.cancel')}
        </button>
      </div>
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
  const [showChart, setShowChart] = useState(false);
  const [busy, setBusy] = useState<'confirm' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string[] | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [ticketOpen, setTicketOpen] = useState(false);
  const long = signal.direction === 'long';
  const dirColor = long ? 'var(--color-pos)' : 'var(--color-neg)';
  const exp = signal.status === 'new' ? expiryInfo(signal.createdAt, signal.timeframe) : null;

  async function executeConfirm(
    overrides: { amountEur?: number; leverage?: number; stopLoss?: number; takeProfits?: number[] } | null,
  ) {
    setBusy('confirm');
    setError(null);
    setBlocked(null);
    try {
      const res = await trpc.signals.confirm.mutate({ id: signal.id, ...(overrides ? { overrides } : {}) });
      if (res.executed) {
        setSuccess(`✓ ${res.detail} ${t('signals.qty')} ${res.qty?.toFixed(6)} — ${t('signals.executed')}`);
        setTicketOpen(false);
        window.setTimeout(onDecided, 2500);
      } else {
        // Risk-Gate hat geblockt — Signal bleibt offen, Gründe anzeigen
        setBlocked(res.riskReasons.length > 0 ? res.riskReasons : [res.detail]);
        setBusy(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
      setBusy(null);
    }
  }

  async function decide(action: 'confirm' | 'reject') {
    if (action === 'confirm') {
      // Kein Sofort-Kauf mehr: erst das anpassbare Ticket (Betrag/Hebel/SL/TP).
      setTicketOpen(true);
      return;
    }
    setBusy(action);
    setError(null);
    setBlocked(null);
    try {
      await trpc.signals.reject.mutate({ id: signal.id });
      onDecided();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
      setBusy(null);
    }
  }

  return (
    <div className="glass glass-hover p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <span
            className="num rounded px-1.5 py-0.5 text-xs font-semibold tracking-wider"
            style={{ color: dirColor, border: `1px solid ${dirColor}`, boxShadow: `0 0 12px ${long ? 'rgba(61,220,151,0.25)' : 'rgba(255,92,108,0.25)'}` }}
          >
            {long ? 'LONG' : 'SHORT'}
          </span>
          <span className="flex items-center gap-1 font-medium">
            <FavStarSymbol symbol={signal.symbol} initialFavorite={signal.isFavorite} />
            <a href={buildChartUrl(signal.symbol, signal.timeframe)} className="hover:underline" title={t('chart.title')}>
              {signal.symbol.replace('/USDT', '')}
            </a>
          </span>
          <span className="label">{signal.timeframe} · {signal.setupType}</span>
          {signal.status === 'new' && exp && (
            <span
              className="rounded border px-1.5 py-0.5 text-[10px]"
              style={
                exp.soon
                  ? { borderColor: 'rgba(232,184,75,0.5)', color: 'var(--color-warn)' }
                  : { borderColor: 'var(--color-line)', color: 'var(--color-mut)' }
              }
              title={t('signals.expiresHint')}
            >
              ⏳ {t('signals.expiresIn', { time: exp.text })}
            </span>
          )}
          {signal.status === 'expired' && (
            <span className="rounded border px-1.5 py-0.5 text-[10px]" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
              {t('signals.statusExpired')}
            </span>
          )}
          {/* Herkunft IMMER zeigen (auch Engine) — mit erklärendem Tooltip statt nacktem Etikett */}
          <span
            className="cursor-help rounded border px-1.5 py-0.5 text-[10px] tracking-wider"
            style={{ borderColor: 'var(--color-acc2, var(--color-line))', color: 'var(--color-mut)' }}
            title={t(SOURCE_HINT[signal.source])}
          >
            {t(SOURCE_KEY[signal.source])}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <RegimeBadge symbol={signal.symbol} timeframe={signal.timeframe} />
          <MlBadge signalId={signal.id} />
          <span className="num text-lg font-semibold" style={{ color: RISK_COLOR[signal.riskClass] }}>
            {Number(signal.score).toLocaleString('de-DE', { minimumFractionDigits: 1 })}
            <span className="text-xs font-normal" style={{ color: 'var(--color-mut)' }}> / 10</span>
          </span>
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

      <LifecycleChips signal={signal} />

      <button onClick={() => setShowChart(!showChart)} className="mt-3 text-xs" style={{ color: 'var(--color-cyan)' }}>
        {showChart ? `− ${t('signals.chartHide')}` : `+ ${t('signals.chartShow')}`}
      </button>
      {showChart && (
        <SignalChart
          symbol={signal.symbol}
          timeframe={signal.timeframe as '15m' | '1h' | '4h' | '1d'}
          entry={Number(signal.entry)}
          stopLoss={Number(signal.stopLoss)}
          takeProfits={signal.takeProfits.map(Number)}
        />
      )}

      <SwarmReviews reviews={signal.reviews} />

      <IntelligenceSection signalId={signal.id} />

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
          {ticketOpen && !success ? (
            <AdjustTicket
              signal={signal}
              busy={busy === 'confirm'}
              onExecute={(overrides) => void executeConfirm(overrides)}
              onCancel={() => setTicketOpen(false)}
            />
          ) : (
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
          )}
          <p className="mt-2.5 text-center text-[11px]" style={{ color: 'var(--color-mut)' }}>
            {t('signals.footer')}
          </p>
        </>
      )}
    </div>
  );
}
