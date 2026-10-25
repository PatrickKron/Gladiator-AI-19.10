import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { appLocale } from '../lib/locale.js';
import { minutesUntil, oracleVerdict, sentinelVerdict, shadowVerdict, type Tone, type Verdict } from '../lib/asset-analysis.js';
import type { AssetContext } from './AssetContextPanel.js';
import { openAssistant } from './AssistantPanel.js';
import { priceUnit } from '../lib/asset-tabs.js';

/**
 * Oracle · Shadow · Sentinel für ein Asset auf einen Klick (Patricks Mängelliste 2026-10-22,
 * Punkt 6). Drei Karten, je ein Urteil in einem Satz + die echten Zahlen dahinter + Stand und
 * Quelle. Nicht verbundene Quellen stehen als solche da — kein Urteil ohne Daten.
 */

type Analysis = Awaited<ReturnType<typeof trpc.market.assetAnalysis.query>>;
type VerdictResult = Awaited<ReturnType<typeof trpc.market.assetVerdict.mutate>>;

const TONE: Record<Tone, string> = { pos: 'var(--color-pos)', neg: 'var(--color-neg)', warn: 'var(--color-warn)', mut: 'var(--color-mut)' };

/** `venue` = Kerzenquelle des Charts; ohne Angabe Binance (Krypto). */
export function AssetAnalysis({ symbol, venue = 'binance', ctx }: { symbol: string; venue?: string; ctx: AssetContext | null }) {
  const { t } = useTranslation();
  const [a, setA] = useState<Analysis | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  // KI-Urteil (Mängelliste 6, zweite Stufe): auf Knopfdruck, echte Kosten, ohne Schlüssel ehrlich nicht verbunden.
  const [ai, setAi] = useState<VerdictResult | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setA(null);
    setErr(null);
    setAi(null);
    setAiErr(null);
    void trpc.market.assetAnalysis
      .query({ symbol, venue })
      .then((r) => {
        if (!cancelled) setA(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [symbol, venue]);

  const c = ctx && ctx.available ? ctx : null;
  const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString(appLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  const num = (v: number | null | undefined, d = 2) => (v == null ? '—' : v.toLocaleString(appLocale(), { maximumFractionDigits: d }));
  const pct = (v: number | null | undefined, d = 2) => (v == null ? '—' : `${v.toLocaleString(appLocale(), { maximumFractionDigits: d })} %`);

  const oracle: Verdict | null = a ? oracleVerdict({ macroConnected: a.macro.connected, grsLabel: a.macro.grs?.label ?? null, emaRegime: c?.emaRegime ?? null, marketPhase: c?.marketPhase ?? null }) : null;
  const shadow: Verdict | null = a
    ? shadowVerdict({ derivativesConnected: a.derivatives.connected, fundingRate: a.derivatives.fundingRate, oiChangePct24h: a.derivatives.oiChangePct24h, cotConnected: a.cot.connected, cotStatus: a.cot.status, cotNetRatio: a.cot.netRatio })
    : null;
  const nextMin = a ? minutesUntil(a.noTrade.nextHigh?.scheduledAt ?? null, now) : null;
  const atrPct = a?.volatility.atrPct ?? c?.atrPct ?? null;
  const sentinel: Verdict | null = a
    ? sentinelVerdict({ killSwitchActive: a.risk.killSwitchActive, noTradeActive: a.noTrade.active, noTradeReason: a.noTrade.reason, noTradeScope: a.noTrade.scope, nextHighMinutes: nextMin, atrPct, exposureNotional: a.risk.exposureNotional, openPositions: a.risk.openPositions })
    : null;
  const unit = priceUnit(a?.profile?.quoteCurrency ?? null);
  const money = (v: number) => `${num(v, 0)}${unit ? ` ${unit}` : ''}`;

  const deepen = () => openAssistant(t('analysis.deepenPrompt', { symbol }));
  const askAi = async () => {
    setAiBusy(true);
    setAiErr(null);
    try {
      setAi(await trpc.market.assetVerdict.mutate({ symbol, venue }));
    } catch (e) {
      setAiErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAiBusy(false);
    }
  };
  const aiFor = (agent: 'makro' | 'shadow') => ai?.agents.find((x) => x.agent === agent) ?? null;

  return (
    <section className="mb-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{t('analysis.title', { symbol })}</h2>
        <span className="text-xs" style={{ color: 'var(--color-mut)' }}>
          {t('analysis.subtitle')}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" className="tbtn" onClick={() => void askAi()} disabled={aiBusy || !a} title={a && !a.llmConfigured ? t('analysis.aiNotConfigured') : undefined}>
            {aiBusy ? t('analysis.aiBusy') : t('analysis.ai')}
          </button>
          <button type="button" className="tbtn" onClick={deepen}>
            {t('analysis.deepen')}
          </button>
        </div>
      </div>
      {aiErr && (
        <p className="mb-2 text-xs" style={{ color: 'var(--color-warn)' }}>
          {aiErr} <a href="#/einstellungen?tab=keys" className="underline">{t('analysis.aiToKeys')}</a>
        </p>
      )}
      {ai && (
        <p className="mb-2 text-[11px]" style={{ color: 'var(--color-mut)' }}>
          {t('analysis.aiCost', { usd: ai.costUsd.toFixed(4), when: fmtTime(ai.asOf) })}
        </p>
      )}
      {err && (
        <p className="text-sm" style={{ color: 'var(--color-neg)' }}>
          {err}
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-3">
        <Card name={t('analysis.oracle')} sub={t('analysis.oracleSub')} verdict={oracle} t={t} footer={a ? (a.macro.connected ? t('analysis.asOf', { when: fmtTime(a.macro.asOf) }) : t('analysis.notConnected')) : null}>
          <Row label={t('analysis.grs')} value={a?.macro.grs ? `${num(a.macro.grs.score, 1)} · ${t(`analysis.grs_${a.macro.grs.label}`)}` : '—'} />
          <Row label="VIX" value={num(a?.macro.vix, 1)} />
          <Row label="DXY" value={num(a?.macro.dxy, 2)} />
          <Row label="US10Y" value={pct(a?.macro.us10y, 2)} />
          <Row label={t('analysis.regime')} value={c?.emaRegime ? t(`analysis.regime_${c.emaRegime}`) : '—'} tone={c?.emaRegime === 'above' ? 'pos' : c?.emaRegime === 'below' ? 'neg' : undefined} />
          <Row label={t('analysis.phase')} value={c?.marketPhase ? t(`analysis.phase_${c.marketPhase}`) : '—'} />
          <Row label={t('analysis.structure')} value={c?.lastStructure ? `${c.lastStructure.kind} ${c.lastStructure.direction} @ ${num(c.lastStructure.level, 0)}` : '—'} />
          <AiRow outcome={aiFor('makro')} t={t} />
        </Card>
        <Card
          name={t('analysis.shadow')}
          sub={t('analysis.shadowSub')}
          verdict={shadow}
          t={t}
          footer={a ? [!a.derivatives.applicable ? t('analysis.derivNa') : a.derivatives.connected ? t('analysis.derivAsOf', { when: fmtTime(a.derivatives.asOf) }) : t('analysis.derivNone'), a.cot.applicable ? (a.cot.connected ? t('analysis.cotAsOf', { when: fmtTime(a.cot.reportDate) }) : t('analysis.cotNone')) : t('analysis.cotNa')].join(' · ') : null}
        >
          <Row label={t('analysis.funding')} value={a?.derivatives.fundingRate == null ? '—' : pct(a.derivatives.fundingRate * 100, 4)} tone={a?.derivatives.fundingRate == null ? undefined : a.derivatives.fundingRate >= 0 ? 'pos' : 'neg'} />
          <Row label={t('analysis.oi')} value={a?.derivatives.openInterest == null ? '—' : num(a.derivatives.openInterest, 0)} />
          <Row label={t('analysis.oi24')} value={pct(a?.derivatives.oiChangePct24h, 1)} />
          <Row label={t('analysis.cotMarket')} value={a?.cot.market ? `${t(`intel.cotMarket_${a.cot.market}`)}${a.cot.inverse ? ` · ${t('analysis.cotInverse')}` : ''}` : '—'} />
          <Row label={t('analysis.cotStatus')} value={a?.cot.status ? t(`analysis.cot_${a.cot.status}`) : '—'} tone={a?.cot.status === 'crowded_long' || a?.cot.status === 'crowded_short' || a?.cot.status === 'contrarian_alert' ? 'warn' : undefined} />
          <Row label={t('analysis.cotNet')} value={a?.cot.netRatio == null ? '—' : `${num(a.cot.netRatio, 3)} · P${a.cot.percentile == null ? '—' : Math.round(a.cot.percentile * 100)}`} />
          <Row label={t('analysis.cotWeek')} value={a?.cot.weekChange == null ? '—' : `${a.cot.weekChange >= 0 ? '+' : ''}${num(a.cot.weekChange, 3)}`} />
          <AiRow outcome={aiFor('shadow')} t={t} />
        </Card>
        <Card name={t('analysis.sentinel')} sub={t('analysis.sentinelSub')} verdict={sentinel} t={t} footer={a ? (a.noTrade.calendarConnected ? t('analysis.calendarOk') : t('analysis.calendarNone')) : null}>
          <Row label={t('analysis.killSwitch')} value={a ? (a.risk.killSwitchActive ? t('analysis.on') : t('analysis.off')) : '—'} tone={a?.risk.killSwitchActive ? 'neg' : 'pos'} />
          {/* Engine-Sperre ist GLOBAL: steht immer da, bei fremdem Termin ausdrücklich als „global“. */}
          <Row
            label={t('analysis.noTrade')}
            value={a ? (a.noTrade.active ? (a.noTrade.scope === 'global' ? t('analysis.noTradeGlobal', { reason: a.noTrade.reason ?? '' }) : (a.noTrade.reason ?? t('analysis.on'))) : t('analysis.noTradeNone')) : '—'}
            tone={a?.noTrade.active ? 'neg' : undefined}
          />
          <Row
            label={a?.noTrade.filter === 'asset' && a.noTrade.currencies?.length ? t('analysis.nextHighFor', { currencies: a.noTrade.currencies.join('/') }) : t('analysis.nextHigh')}
            value={a?.noTrade.nextHigh ? `${a.noTrade.nextHigh.title} · ${fmtTime(a.noTrade.nextHigh.scheduledAt)}` : '—'}
          />
          <Row label={t('analysis.atr')} value={pct(atrPct, 2)} tone={(atrPct ?? 0) >= 5 ? 'warn' : undefined} />
          <Row
            label={t('analysis.exposure')}
            value={a ? `${t('analysis.exposureSplit', { agent: money(a.risk.agent.notional), demo: money(a.risk.demo.notional) })} · ${t('analysis.positions', { n: a.risk.openPositions })}` : '—'}
          />
          <Row label={t('analysis.limits')} value={a ? t('analysis.limitsValue', { risk: num(a.risk.riskPctPerTrade, 1), lev: num(a.risk.maxLeverage, 0), exp: num(a.risk.maxExposurePctPerAsset, 0), day: num(a.risk.dailyLossLimitPct, 1) }) : '—'} />
          <Row label={t('analysis.mode')} value={a?.risk.mode ?? '—'} />
        </Card>
      </div>
    </section>
  );
}

function Card({ name, sub, verdict, footer, t, children }: { name: string; sub: string; verdict: Verdict | null; footer: string | null; t: (k: string, o?: Record<string, unknown>) => string; children: React.ReactNode }) {
  return (
    <div className="glass p-4">
      <p className="text-sm font-semibold">{name}</p>
      <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
        {sub}
      </p>
      <p className="mt-2 text-sm leading-snug" style={{ color: verdict ? TONE[verdict.tone] : 'var(--color-mut)' }}>
        {verdict ? t(verdict.key, verdict.params) : t('common.loading')}
      </p>
      <ul className="mt-3 space-y-1 text-sm">{children}</ul>
      {footer && (
        <p className="mt-3 text-[11px]" style={{ color: 'var(--color-mut)' }}>
          {footer}
        </p>
      )}
    </div>
  );
}

/** KI-Urteil eines Agenten als Zeile unter den Fakten — nur nach Knopfdruck, nie geraten. */
function AiRow({ outcome, t }: { outcome: VerdictResult['agents'][number] | null; t: (k: string, o?: Record<string, unknown>) => string }) {
  if (!outcome) return null;
  if (!outcome.connected) {
    return (
      <li className="mt-2 border-t pt-2 text-xs" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
        {t('analysis.aiLabel')}: {outcome.reason}
      </li>
    );
  }
  if ('error' in outcome) {
    return (
      <li className="mt-2 border-t pt-2 text-xs" style={{ borderColor: 'var(--color-line)', color: 'var(--color-warn)' }}>
        {t('analysis.aiLabel')}: {outcome.error}
      </li>
    );
  }
  const v = outcome.verdict;
  const tone: Tone = v.stance === 'bullish' ? 'pos' : v.stance === 'bearish' ? 'neg' : 'warn';
  return (
    <li className="mt-2 border-t pt-2 text-sm" style={{ borderColor: 'var(--color-line)' }}>
      <span className="font-medium" style={{ color: TONE[tone] }}>
        {t('analysis.aiLabel')} · {t(`analysis.stance_${v.stance}`)} · {Math.round(v.confidence * 100)} %
      </span>
      <p className="mt-0.5 text-xs leading-snug" style={{ color: 'var(--color-mut)' }}>
        {v.reason}
      </p>
    </li>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span style={{ color: 'var(--color-mut)' }}>{label}</span>
      <span className="num text-right" style={{ color: tone ? TONE[tone] : 'var(--color-ink)' }}>
        {value}
      </span>
    </li>
  );
}
