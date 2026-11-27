import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { SignalChart } from './SignalChart.js';
import { FavStarSymbol } from './FavStar.js';
import { openAssistant } from './AssistantPanel.js';
import { MlBadge } from './MlBadge.js';
import { RegimeBadge } from './RegimeBadge.js';
import { buildChartUrl } from '../lib/chart-url.js';
import { setPendingTradeSymbol } from '../lib/trade-symbol.js';
import { getUiMode } from '../lib/ui-mode.js';
import { lifecycleChips, type AutoKillInfo, type LeverageUpgradeInfo, type ReentryInfo } from '../lib/signal-lifecycle.js';
import { appLocale } from '../lib/locale.js';

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
  /** Kursquelle (binance | yahoo | twelvedata) — Chart-Link und Ausführungsart (A2/A3). */
  venue?: string;
  timeframe: string;
  direction: 'long' | 'short';
  setupType: 'scalp' | 'swing' | 'position';
  entry: string;
  stopLoss: string;
  takeProfits: string[];
  leverageSuggested?: string;
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
    ? v.toLocaleString(appLocale(), { maximumFractionDigits: 0 })
    : v.toLocaleString(appLocale(), { maximumFractionDigits: 2 });
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
          risk: exp.riskPct.toLocaleString(appLocale(), { maximumFractionDigits: 2 }),
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
const fmtPct = (n: number, digits = 1) => `${n.toLocaleString(appLocale(), { maximumFractionDigits: digits })} %`;
const SIGNAL_LEVERAGE_STEPS = [1, 2, 3, 5, 10, 15, 20, 25, 50, 75, 100, 125] as const;

function AdjustTicket({
  signal,
  onExecute,
  onCancel,
  busy,
}: {
  signal: SignalRow;
  onExecute: (
    overrides: {
      amountEur?: number;
      amountUsd?: number;
      leverage?: number;
      stopLoss?: number;
      takeProfits?: number[];
    } | null,
  ) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<ExecPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [amountEur, setAmountEur] = useState<number | null>(null);
  const [leverage, setLeverage] = useState(1);
  const [leverageMode, setLeverageMode] = useState<'scale_position' | 'save_margin'>('scale_position');
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
        const r = p.eurUsdRate;
        const maxNotional = p.limits.exchangeMaxNotionalUsd ?? p.limits.maxNotionalUsd;
        const maxE = r !== null ? Math.max(10, Math.floor(maxNotional / r)) : null;
        const minE = r !== null ? Math.max(1, Math.ceil(p.limits.minNotionalUsd / r)) : null;
        const rawEur = p.suggested.notionalEur !== null ? Math.round(p.suggested.notionalEur) : null;
        const clampedEur =
          rawEur !== null && maxE !== null && minE !== null ? Math.min(maxE, Math.max(minE, rawEur)) : rawEur;
        setAmountEur(clampedEur);
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
      <div className="mt-4 rounded border p-3 text-xs" style={{ borderColor: 'rgba(239,68,68,0.4)', color: 'var(--color-neg)' }}>
        {loadError}
        <button className="ml-2 underline" onClick={onCancel}>{t('common.close')}</button>
      </div>
    );
  }
  if (!preview) {
    return <p className="mt-4 animate-pulse text-xs" style={{ color: 'var(--color-mut)' }}>{t('common.loading')}</p>;
  }

  const rate = preview.eurUsdRate;
  const exchangeMaxLeverage = Math.max(1, Math.round(preview.limits.exchangeMaxLeverage ?? preview.limits.maxLeverage));
  const availableLeverageSteps = SIGNAL_LEVERAGE_STEPS.filter((step) => step <= exchangeMaxLeverage);
  const availMarginUsd = Math.max(0, preview.limits.availableMarginUsd ?? preview.limits.equityUsd);
  const availMarginEur = rate !== null ? Math.max(1, Math.floor(availMarginUsd / rate)) : null;
  const maxNotionalForLevUsd = Math.max(preview.limits.minNotionalUsd, availMarginUsd * Math.max(1, leverage));
  const maxEur = rate !== null ? Math.max(10, Math.floor(maxNotionalForLevUsd / rate)) : null;
  const minEur = rate !== null ? Math.max(1, Math.ceil(preview.limits.minNotionalUsd / rate)) : null;
  const slPrice = slPct !== null ? (long ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100)) : Number(signal.stopLoss);
  const amountUsd = amountEur !== null && rate !== null ? amountEur * rate : preview.suggested.notionalUsd;
  const marginEur = amountEur !== null ? Math.max(1, Math.round((amountEur / Math.max(1, leverage)) * 100) / 100) : null;
  const marginUsd = amountUsd !== null ? amountUsd / Math.max(1, leverage) : null;
  // Live-Kostenvorschau: Taker-Gebühr 0,04 % (Paper-Kostenmodell) auf Ein- und Ausstieg
  const feeEstUsd = amountUsd !== null ? amountUsd * 0.0004 * 2 : null;
  const riskUsd = amountUsd !== null && slPct !== null ? amountUsd * (slPct / 100) : null;
  const activeRiskPct =
    riskUsd !== null && preview.limits.equityUsd > 0
      ? Math.round((riskUsd / preview.limits.equityUsd) * 10000) / 100
      : (preview.suggested.riskPct ?? preview.exposureFit.riskPct);

  const num = (n: number | null, unit: string, digits = 0) =>
    n === null ? '—' : `${n.toLocaleString(appLocale(), { maximumFractionDigits: digits })} ${unit}`;

  const applyLeverage = (nextLevRaw: number) => {
    const nextLev = Math.min(exchangeMaxLeverage, Math.max(1, Math.round(nextLevRaw)));
    if (leverageMode === 'scale_position' && amountEur !== null && rate !== null) {
      const currentMargin = amountEur / Math.max(1, leverage);
      const nextMaxEur = Math.max(10, Math.floor((availMarginUsd * nextLev) / rate));
      const nextMinEur = minEur ?? 1;
      setAmountEur(Math.min(nextMaxEur, Math.max(nextMinEur, Math.round(currentMargin * nextLev))));
    } else if (amountEur !== null && rate !== null) {
      const nextMaxEur = Math.max(10, Math.floor((availMarginUsd * nextLev) / rate));
      if (amountEur > nextMaxEur) setAmountEur(nextMaxEur);
    }
    setLeverage(nextLev);
    setDirty(true);
  };

  const applyConvictionRiskPct = (targetRiskPct: number) => {
    if (rate !== null && maxEur !== null && minEur !== null && slPct !== null && slPct > 0) {
      const targetNotionalUsd = (preview.limits.equityUsd * (targetRiskPct / 100)) / (slPct / 100);
      const targetEur = Math.round(targetNotionalUsd / rate);
      setAmountEur(Math.min(maxEur, Math.max(minEur, targetEur)));
      setDirty(true);
    }
  };

  const send = () => {
    onExecute({
      ...(amountEur !== null && rate !== null
        ? { amountEur }
        : preview.suggested.notionalUsd !== null
          ? { amountUsd: preview.suggested.notionalUsd }
          : {}),
      leverage: Math.max(1, leverage),
      ...(slPct !== null ? { stopLoss: Math.round(slPrice * 1e6) / 1e6 } : {}),
      ...(tps.length > 0 ? { takeProfits: tps.slice(0, 3) } : {}),
    });
  };

  const defaultRiskPct = preview.suggested.riskPct ?? preview.exposureFit.riskPct;
  const convictionPresets = [
    { key: 'cautious', label: '🛡️ Vorsichtig', pct: 0.5 },
    {
      key: 'default',
      label: preview.suggested.sourceLabel === 'strategy' ? '⚖️ Strategie-Standard' : '⚖️ Signal-Standard',
      pct: Math.round(defaultRiskPct * 100) / 100,
    },
    { key: 'confident', label: '🔥 Sicher', pct: 2.0 },
    { key: 'high', label: '🚀 Sehr sicher', pct: 3.5 },
  ];

  return (
    <div
      className="mt-4 rounded-xl border p-3.5"
      style={{
        borderColor: 'rgba(6,182,212,0.45)',
        background: 'linear-gradient(180deg, rgba(6,182,212,0.07) 0%, rgba(15,23,42,0.45) 100%)',
      }}
    >
      {/* Kopfzeile des Schnell-Ausführen-Cockpits + 1-Klick-Sofort-Ausführung */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold tracking-wide" style={{ color: 'var(--color-cyan)' }}>
            ⚡ Schnell-Ausführen-Cockpit
          </span>
          <span
            className="rounded border px-1.5 py-0.5 text-[10px]"
            style={{ borderColor: 'rgba(6,182,212,0.35)', color: 'var(--color-mut)' }}
          >
            {preview.suggested.sourceLabel === 'strategy'
              ? 'Vorausgefüllt aus Strategie & Kapital'
              : 'Vorausgefüllt aus Kapital & Signal-Setup'}
          </span>
        </div>
        <button
          type="button"
          className="text-[11px] underline decoration-dotted"
          style={{ color: 'var(--color-mut)' }}
          onClick={() => {
            setAmountEur(preview.suggested.notionalEur !== null ? Math.round(preview.suggested.notionalEur) : null);
            setLeverage(preview.suggested.leverage);
            setSlPct(Math.round(suggestedSlPct * 10) / 10);
            setTps(signal.takeProfits.map(Number));
            setDirty(false);
          }}
        >
          ↺ {t('ticket.reset')}
        </button>
      </div>

      {/* 4-Kachel-Zusammenfassung der vorausgefüllten / angepassten Werte */}
      <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-lg border px-2.5 py-1.5" style={{ borderColor: 'var(--color-line)', background: 'rgba(15,23,42,0.55)' }}>
          <div className="text-[10px]" style={{ color: 'var(--color-mut)' }}>Dein Einsatz (Margin)</div>
          <div className="num mt-0.5 text-sm font-semibold" style={{ color: 'var(--color-ink)' }}>
            {rate !== null ? num(marginEur, '€') : num(marginUsd, '$')}
          </div>
        </div>
        <div className="rounded-lg border px-2.5 py-1.5" style={{ borderColor: 'var(--color-line)', background: 'rgba(15,23,42,0.55)' }}>
          <div className="text-[10px]" style={{ color: 'var(--color-mut)' }}>Börsen-Hebel</div>
          <div className="num mt-0.5 text-sm font-semibold" style={{ color: 'var(--color-cyan)' }}>
            {leverage}× <span className="text-[10px] font-normal" style={{ color: 'var(--color-mut)' }}>/ max {exchangeMaxLeverage}×</span>
          </div>
        </div>
        <div className="rounded-lg border px-2.5 py-1.5" style={{ borderColor: 'var(--color-line)', background: 'rgba(15,23,42,0.55)' }}>
          <div className="text-[10px]" style={{ color: 'var(--color-mut)' }}>Positionsgröße</div>
          <div className="num mt-0.5 text-sm font-semibold" style={{ color: 'var(--color-ink)' }}>
            {rate !== null ? num(amountEur, '€') : num(amountUsd, '$')}
          </div>
        </div>
        <div className="rounded-lg border px-2.5 py-1.5" style={{ borderColor: 'var(--color-line)', background: 'rgba(15,23,42,0.55)' }}>
          <div className="text-[10px]" style={{ color: 'var(--color-mut)' }}>Max. Risiko bei SL</div>
          <div className="num mt-0.5 text-sm font-semibold" style={{ color: 'var(--color-neg)' }}>
            {riskUsd !== null ? `≈ ${num(rate !== null ? riskUsd / rate : riskUsd, rate !== null ? '€' : '$', 0)}` : '—'}{' '}
            <span className="text-[10px] font-normal" style={{ color: 'var(--color-mut)' }}>
              ({fmtPct(activeRiskPct, 2)})
            </span>
          </div>
        </div>
      </div>

      {/* Direkt oben: 1-Klick-Ausführen mit den vorausgefüllten / aktuellen Parametern */}
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={send}
          disabled={busy}
          className="btn-primary flex-1 px-3 py-2 text-xs font-semibold disabled:opacity-50"
        >
          {busy
            ? t('signals.confirming')
            : `🚀 Jetzt durch Trupp ausführen (${rate !== null ? num(marginEur, '€') : num(marginUsd, '$')} Margin × ${leverage}× = ${rate !== null ? num(amountEur, '€') : num(amountUsd, '$')})`}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border px-2.5 py-2 text-xs"
          style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
        >
          {t('common.cancel')}
        </button>
      </div>

      {/* Referenz: was die Strategie vorschlägt — bleibt IMMER sichtbar */}
      <p className="mt-2 text-[11px]" style={{ color: 'var(--color-mut)' }}>
        {t('ticket.suggestionRef', {
          amount:
            preview.suggested.notionalEur !== null
              ? `${Math.round(preview.suggested.notionalEur).toLocaleString(appLocale())} €`
              : num(preview.suggested.notionalUsd, '$'),
          lev: preview.suggested.leverage,
          sl: fmt(signal.stopLoss),
        })}
      </p>

      {/* Vorschlag aus Erfahrung (13_ §7): VDB2-Cluster, durch Risk-Settings gedeckelt — nur Angebot */}
      <ExperienceSuggestion
        preview={preview}
        onApply={(exp) => {
          setLeverage(exp.leverage);
          if (rate !== null && maxEur !== null && minEur !== null && slPct !== null && slPct > 0) {
            const usd = (preview.limits.equityUsd * (exp.riskPct / 100)) / (slPct / 100);
            setAmountEur(Math.min(maxEur, Math.max(minEur, Math.round(usd / rate))));
          }
          setDirty(true);
        }}
      />

      {/* Persönliche Sicherheit / Überzeugung (1-Klick-Presets + Risiko-%-Regler) */}
      <div className="mt-3 rounded-lg border p-2.5" style={{ borderColor: 'var(--color-line)', background: 'rgba(15,23,42,0.35)' }}>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="font-medium">Persönliche Überzeugung (Risiko am Konto bei SL)</span>
          <span className="num font-semibold" style={{ color: 'var(--color-cyan)' }}>
            {fmtPct(activeRiskPct, 2)} Kontorisiko
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {convictionPresets.map((preset) => {
            const isActive = Math.abs(activeRiskPct - preset.pct) < 0.08;
            return (
              <button
                key={preset.key}
                type="button"
                onClick={() => applyConvictionRiskPct(preset.pct)}
                className="rounded border px-2 py-1 text-[11px] font-medium transition-colors"
                style={{
                  borderColor: isActive ? 'var(--color-cyan)' : 'var(--color-line)',
                  background: isActive ? 'rgba(6,182,212,0.16)' : 'rgba(255,255,255,0.03)',
                  color: isActive ? 'var(--color-cyan)' : 'var(--color-ink)',
                }}
              >
                {preset.label} ({fmtPct(preset.pct, 2)})
              </button>
            );
          })}
        </div>
      </div>

      {/* Börsen-Hebel bis 125× (1-Klick-Chips + Slider + Direkteingabe + Kopplungs-Modus) */}
      <div className="mt-3 rounded-lg border p-2.5" style={{ borderColor: 'var(--color-line)', background: 'rgba(15,23,42,0.35)' }}>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span>
            {t('ticket.leverage')} (Börsen-Hebel bis {exchangeMaxLeverage}×)
            {!profi && (
              <span className="ml-1 cursor-help" title={t('ticket.leverageHint')} style={{ color: 'var(--color-mut)' }}>ⓘ</span>
            )}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setLeverageMode((m) => (m === 'scale_position' ? 'save_margin' : 'scale_position'))}
              className="rounded border px-2 py-0.5 text-[10px]"
              style={{ borderColor: 'rgba(6,182,212,0.35)', color: 'var(--color-cyan)' }}
              title="Wähle, ob ein höherer Hebel deine Positionsgröße bei gleicher Margin vergrößert oder bei gleicher Positionsgröße weniger Margin bindet."
            >
              {leverageMode === 'scale_position'
                ? '🔗 Margin halten (Hebel skaliert Position)'
                : '🛡️ Position halten (Hebel spart Margin)'}
            </button>
            <span className="num text-sm font-bold" style={{ color: 'var(--color-cyan)' }}>{leverage}×</span>
          </div>
        </div>
        {exchangeMaxLeverage > 1 && (
          <>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {availableLeverageSteps.map((step) => {
                const isSelected = leverage === step;
                const isSuggested = preview.suggested.leverage === step;
                return (
                  <button
                    key={step}
                    type="button"
                    onClick={() => applyLeverage(step)}
                    className="num rounded border px-2 py-0.5 text-[11px] font-medium transition-colors"
                    style={{
                      borderColor: isSelected
                        ? 'var(--color-cyan)'
                        : isSuggested
                          ? 'rgba(34,197,94,0.5)'
                          : 'var(--color-line)',
                      background: isSelected ? 'rgba(6,182,212,0.18)' : 'rgba(255,255,255,0.03)',
                      color: isSelected ? 'var(--color-cyan)' : isSuggested ? 'var(--color-pos)' : 'var(--color-ink)',
                    }}
                    title={isSuggested ? `Empfohlener Signal-Hebel (${step}×)` : `${step}× Hebel wählen`}
                  >
                    {step}×
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="range"
                min={1}
                max={exchangeMaxLeverage}
                step={1}
                value={leverage}
                onChange={(e) => applyLeverage(Number(e.target.value))}
                className="w-full"
              />
              <input
                type="number"
                className="field num w-20 px-2 py-1 text-xs"
                min={1}
                max={exchangeMaxLeverage}
                value={leverage}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= 1) applyLeverage(v);
                }}
              />
            </div>
          </>
        )}
      </div>

      {/* Einsatz (Margin) & Positionsgröße in € */}
      <div className="mt-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span>
            {t('ticket.amount')} <span style={{ color: 'var(--color-mut)' }}>(Margin × {leverage}× Hebel)</span>
          </span>
          <span className="num">
            {rate !== null
              ? `${num(marginEur, '€')} Margin → ${num(amountEur, '€')} Position`
              : num(preview.suggested.notionalUsd, '$')}
          </span>
        </div>
        {rate !== null && maxEur !== null && minEur !== null ? (
          <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="rounded border p-2 text-[11px]" style={{ borderColor: 'var(--color-line)' }}>
              <div className="flex items-center justify-between" style={{ color: 'var(--color-mut)' }}>
                <span>Dein Einsatz (Margin in €)</span>
                {availMarginEur !== null && <span>frei: {num(availMarginEur, '€')}</span>}
              </div>
              <input
                type="number"
                className="field num mt-1 w-full px-2 py-1 text-xs"
                min={1}
                max={availMarginEur ?? maxEur}
                value={marginEur !== null ? Math.round(marginEur) : ''}
                onChange={(e) => {
                  const m = Number(e.target.value);
                  if (Number.isFinite(m) && m > 0) {
                    setAmountEur(Math.min(maxEur, Math.max(minEur, Math.round(m * Math.max(1, leverage)))));
                    setDirty(true);
                  }
                }}
              />
            </label>
            <label className="rounded border p-2 text-[11px]" style={{ borderColor: 'var(--color-line)' }}>
              <div className="flex items-center justify-between" style={{ color: 'var(--color-mut)' }}>
                <span>Positionsgröße gesamt (in €)</span>
                <span>max: {num(maxEur, '€')}</span>
              </div>
              <input
                type="number"
                className="field num mt-1 w-full px-2 py-1 text-xs"
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
            </label>
            <div className="sm:col-span-2">
              <input
                type="range"
                min={minEur}
                max={maxEur}
                step={1}
                value={Math.min(maxEur, Math.max(minEur, amountEur ?? minEur))}
                onChange={(e) => {
                  setAmountEur(Number(e.target.value));
                  setDirty(true);
                }}
                className="w-full"
              />
            </div>
          </div>
        ) : (
          <p className="mt-1 text-[11px]" style={{ color: 'var(--color-warn)' }}>
            {t('ticket.noRate')}
          </p>
        )}
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
            {slPct !== null ? `−${slPct.toLocaleString(appLocale(), { maximumFractionDigits: 1 })} %` : '—'}
            {profi && slPct !== null && <span style={{ color: 'var(--color-mut)' }}> ({slPrice.toLocaleString(appLocale(), { maximumFractionDigits: 6 })})</span>}
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
            {t('ticket.protectionText', { pct: slPct.toLocaleString(appLocale(), { maximumFractionDigits: 1 }) })}
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

      {preview.execution.mode === 'candle_close' && (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--color-mut)' }}>
          {t('ticket.closeExecution', { source: preview.execution.source === 'twelvedata' ? 'Twelve Data' : 'Yahoo' })}
        </p>
      )}
      {preview.execution.mode === 'live' && (
        <p className="mt-2 rounded border px-2 py-1 text-[11px] font-medium" style={{ borderColor: 'rgba(245,158,11,0.5)', color: 'var(--color-warn)', background: 'rgba(245,158,11,0.08)' }}>
          ⚡ Live-Ausführung über {preview.execution.source.toUpperCase()} — echte Börsen-Order mit echtem Geld (Risk-Gate + Schutz-Orders aktiv).
        </p>
      )}

      {preview.gateReasons.length > 0 && (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--color-warn)' }}>
          ⚠ {preview.gateReasons.join(' · ')}
          {dirty && <span style={{ color: 'var(--color-mut)' }}> {t('ticket.gateRecheck')}</span>}
        </p>
      )}

      {/* Adaptives Asset-Hedging (Welle 20): transparent anzeigen, wenn der Asset-Hedge live aktiv ist */}
      {preview.hedging && preview.hedging.state === 'active' && (
        <p
          className="mt-2 rounded border px-2 py-1 text-[11px] leading-relaxed"
          style={{ borderColor: 'rgba(245,158,11,0.45)', color: 'var(--color-warn)', background: 'rgba(245,158,11,0.08)' }}
        >
          🛡️ Adaptives Hedging aktiv ({preview.hedging.strategyName}): {preview.hedging.summary}
          {preview.hedging.scaled ? ' — Vorschlag automatisch auf 50 % reduziert.' : ''}
        </p>
      )}

      {/* Automatische konservative Deckelung bei engem Stop transparent anzeigen */}
      {preview.suggested.autoCapped && (
        <p
          className="mt-2 rounded border px-2 py-1 text-[11px] leading-relaxed"
          style={{ borderColor: 'rgba(6,182,212,0.4)', color: 'var(--color-cyan)', background: 'rgba(6,182,212,0.08)' }}
        >
          ✓ Einsatz automatisch an dein {fmtPct(preview.exposureFit.limitPct, 0)}-Exposure-Limit angepasst (tatsächliches Risiko: {fmtPct(preview.suggested.effectiveRiskPct, 2)} statt {fmtPct(preview.exposureFit.riskPct, 2)}).
        </p>
      )}

      {/* Risiko% vs. Exposure-Limit (enger Stop): Rechnung offenlegen + größten erlaubten Betrag anbieten */}
      {!preview.suggested.autoCapped && !preview.exposureFit.fits && preview.exposureFit.stopPct > 0 && !dirty && (
        <div className="mt-2 rounded border p-2 text-[11px] leading-relaxed" style={{ borderColor: 'rgba(245,182,66,0.4)', color: 'var(--color-mut)' }}>
          <p>
            {t('ticket.exposureExplain', {
              risk: fmtPct(preview.exposureFit.riskPct, 2),
              stop: fmtPct(preview.exposureFit.stopPct),
              implied: fmtPct(preview.exposureFit.impliedExposurePct, 0),
              limit: fmtPct(preview.exposureFit.limitPct, 0),
            })}
          </p>
          {preview.exposureFit.maxNotional > 0 && rate !== null && minEur !== null && (
            <button
              type="button"
              className="mt-1 rounded border px-2 py-0.5"
              style={{ borderColor: 'var(--color-line)', color: 'var(--color-ink)' }}
              onClick={() => {
                setAmountEur(Math.max(minEur, Math.floor(preview.exposureFit.maxNotional / rate)));
                setDirty(true);
              }}
            >
              {t('ticket.exposureApply', {
                amount: num(Math.floor(preview.exposureFit.maxNotional / rate), '€'),
                risk: fmtPct(preview.exposureFit.riskPctAtMax, 2),
              })}
            </button>
          )}
          <p className="mt-1">{t('ticket.exposureSettings')}</p>
        </div>
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
export function SignalCard({
  signal,
  onDecided,
  readOnly = false,
  initialTicketOpen = false,
}: {
  signal: SignalRow;
  onDecided: () => void;
  readOnly?: boolean;
  initialTicketOpen?: boolean;
}) {
  const { t } = useTranslation();
  // Das Bild gehört zur Karte (Welle D): bei offenen Signalen von Anfang an sichtbar, bei abgelaufenen auf Wunsch.
  const [showChart, setShowChart] = useState(signal.status === 'new');
  const [busy, setBusy] = useState<'confirm' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string[] | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [ticketOpen, setTicketOpen] = useState(initialTicketOpen);
  const long = signal.direction === 'long';
  const exp = signal.status === 'new' ? expiryInfo(signal.createdAt, signal.timeframe) : null;

  async function executeConfirm(
    overrides: {
      amountEur?: number;
      amountUsd?: number;
      leverage?: number;
      stopLoss?: number;
      takeProfits?: number[];
    } | null,
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
          <span className={`chip ${long ? 'chip--pos' : 'chip--neg'}`}>{long ? 'Long' : 'Short'}</span>
          <span className="flex items-center gap-1 font-medium">
            <FavStarSymbol symbol={signal.symbol} venue={signal.venue} initialFavorite={signal.isFavorite} />
            <a href={buildChartUrl(signal.symbol, signal.timeframe, signal.venue)} className="hover:underline" title={t('chart.title')}>
              {signal.symbol.replace('/USDT', '')}
            </a>
          </span>
          <span className="label">{signal.timeframe} · {signal.setupType}</span>
          {signal.status === 'new' && exp && (
            <span
              className="rounded border px-1.5 py-0.5 text-[10px]"
              style={
                exp.soon
                  ? { borderColor: 'rgba(245,158,11,0.5)', color: 'var(--color-warn)' }
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
          <RegimeBadge symbol={signal.symbol} timeframe={signal.timeframe} venue={signal.venue} />
          <MlBadge signalId={signal.id} />
          <span className="num text-2xl font-bold tracking-tight" style={{ color: RISK_COLOR[signal.riskClass] }} title={`${Number(signal.score).toLocaleString(appLocale(), { minimumFractionDigits: 1 })} / 10`}>
            {Number(signal.score).toLocaleString(appLocale(), { minimumFractionDigits: 1 })}
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

      {/* Schnell-Ausführen-Cockpit direkt oben unter Entry/SL/TP, damit man nicht über den Chart scrollen muss */}
      {error && <p className="mt-3 text-xs" style={{ color: 'var(--color-neg)' }}>{error}</p>}
      {success && (
        <p className="mt-3 rounded border p-2 text-xs" style={{ borderColor: 'rgba(34,197,94,0.4)', color: 'var(--color-pos)' }}>
          {success}
        </p>
      )}
      {blocked && (
        <div className="mt-3 rounded border p-2 text-xs" style={{ borderColor: 'rgba(239,68,68,0.4)', color: 'var(--color-neg)' }}>
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
            <div className="mt-4 grid grid-cols-[1fr_auto] items-center gap-2">
              <button onClick={() => void decide('confirm')} disabled={busy !== null} className="btn-primary px-3 py-2.5 text-sm font-semibold disabled:opacity-50">
                {busy === 'confirm'
                  ? t('signals.confirming')
                  : `⚡ Schnell-Ausführen (${signal.leverageSuggested && Number(signal.leverageSuggested) > 1 ? `${signal.leverageSuggested}× · ` : ''}${t('signals.openTicket')})`}
              </button>
              <button onClick={() => void decide('reject')} disabled={busy !== null} className="btn disabled:opacity-50">
                {busy === 'reject' ? t('signals.rejecting') : t('signals.rejectBtn')}
              </button>
            </div>
          )}
        </>
      )}

      {/* Gründe und Risiko in Worten (Welle D) */}
      <p className="mt-4 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        <span className="font-semibold" style={{ color: 'var(--color-ink)' }}>{t('signals.why')}:</span> {signal.confluence.join(' · ')}
      </p>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        <span className="font-semibold" style={{ color: 'var(--color-ink)' }}>{t('signals.riskLine')}:</span> {t(`signals.risk_${signal.riskClass}`)} · {t('common.session')} {signal.session} · {signal.setupType}
      </p>

      <LifecycleChips signal={signal} />

      <button onClick={() => setShowChart(!showChart)} className="mt-3 text-xs" style={{ color: 'var(--color-cyan)' }}>
        {showChart ? `− ${t('signals.chartHide')}` : `+ ${t('signals.chartShow')}`}
      </button>
      {showChart && (
        <SignalChart
          symbol={signal.symbol}
          timeframe={signal.timeframe as '15m' | '1h' | '4h' | '1d'}
          venue={signal.venue}
          entry={Number(signal.entry)}
          stopLoss={Number(signal.stopLoss)}
          takeProfits={signal.takeProfits.map(Number)}
        />
      )}

      <SwarmReviews reviews={signal.reviews} />

      <IntelligenceSection signalId={signal.id} />

      {!readOnly && (
        <p className="mt-2.5 text-center text-[11px]" style={{ color: 'var(--color-mut)' }}>
          {t('signals.footer')}
        </p>
      )}
      {/* Direkt-Einstieg ins Chart & Demo-Ticket — funktioniert für offene UND abgelaufene Signale */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-2.5" style={{ borderColor: 'rgba(148,163,184,0.12)' }}>
        <a
          href={buildChartUrl(signal.symbol, signal.timeframe, signal.venue)}
          onClick={() => setPendingTradeSymbol(signal.symbol)}
          className="rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:border-[var(--color-cyan)]"
          style={{ borderColor: 'rgba(6,182,212,0.45)', color: 'var(--color-cyan)' }}
        >
          📈 Im Chart & Demo-Ticket handeln
        </a>
        {/* Chat-Einstieg (Mängelliste 4): Signal mit echten Werten in den Chat tragen — bewertet mit recent_signals + asset_analysis. */}
        <button
          type="button"
          className="text-xs underline decoration-dotted"
          style={{ color: 'var(--color-blue)' }}
          onClick={() =>
            openAssistant(
              t('signals.chatPrompt', { symbol: signal.symbol, direction: signal.direction, tf: signal.timeframe, entry: fmt(signal.entry), sl: fmt(signal.stopLoss), score: fmt(signal.score) }),
            )
          }
        >
          {t('signals.discussChat')}
        </button>
      </div>
    </div>
  );
}
