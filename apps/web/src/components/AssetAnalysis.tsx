import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { appLocale } from '../lib/locale.js';
import { minutesUntil, oracleVerdict, sentinelVerdict, shadowVerdict, type Tone, type Verdict } from '../lib/asset-analysis.js';
import type { AssetContext } from './AssetContextPanel.js';
import { openAssistant } from './AssistantPanel.js';

/**
 * Oracle · Shadow · Sentinel für ein Asset auf einen Klick (Patricks Mängelliste 2026-10-22,
 * Punkt 6). Drei Karten, je ein Urteil in einem Satz + die echten Zahlen dahinter + Stand und
 * Quelle. Nicht verbundene Quellen stehen als solche da — kein Urteil ohne Daten.
 */

type Analysis = Awaited<ReturnType<typeof trpc.market.assetAnalysis.query>>;

const TONE: Record<Tone, string> = { pos: 'var(--color-pos)', neg: 'var(--color-neg)', warn: 'var(--color-warn)', mut: 'var(--color-mut)' };

export function AssetAnalysis({ symbol, ctx }: { symbol: string; ctx: AssetContext | null }) {
  const { t } = useTranslation();
  const [a, setA] = useState<Analysis | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let cancelled = false;
    setA(null);
    setErr(null);
    void trpc.market.assetAnalysis
      .query({ symbol })
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
  }, [symbol]);

  const c = ctx && ctx.available ? ctx : null;
  const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString(appLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  const num = (v: number | null | undefined, d = 2) => (v == null ? '—' : v.toLocaleString(appLocale(), { maximumFractionDigits: d }));
  const pct = (v: number | null | undefined, d = 2) => (v == null ? '—' : `${v.toLocaleString(appLocale(), { maximumFractionDigits: d })} %`);

  const oracle: Verdict | null = a ? oracleVerdict({ macroConnected: a.macro.connected, grsLabel: a.macro.grs?.label ?? null, emaRegime: c?.emaRegime ?? null, marketPhase: c?.marketPhase ?? null }) : null;
  const shadow: Verdict | null = a
    ? shadowVerdict({ derivativesConnected: a.derivatives.connected, fundingRate: a.derivatives.fundingRate, oiChangePct24h: a.derivatives.oiChangePct24h, cotConnected: a.cot.connected, cotStatus: a.cot.status, cotNetRatio: a.cot.netRatio })
    : null;
  const nextMin = a ? minutesUntil(a.noTrade.nextHigh?.scheduledAt ?? null, now) : null;
  const sentinel: Verdict | null = a
    ? sentinelVerdict({ killSwitchActive: a.risk.killSwitchActive, noTradeActive: a.noTrade.active, noTradeReason: a.noTrade.reason, nextHighMinutes: nextMin, atrPct: c?.atrPct ?? null, exposureNotional: a.risk.exposureNotional, openPositions: a.risk.openPositions })
    : null;

  const deepen = () => openAssistant(t('analysis.deepenPrompt', { symbol }));

  return (
    <section className="mb-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{t('analysis.title', { symbol })}</h2>
        <span className="text-xs" style={{ color: 'var(--color-mut)' }}>
          {t('analysis.subtitle')}
        </span>
        <button type="button" className="tbtn ml-auto" onClick={deepen}>
          {t('analysis.deepen')}
        </button>
      </div>
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
        </Card>
        <Card
          name={t('analysis.shadow')}
          sub={t('analysis.shadowSub')}
          verdict={shadow}
          t={t}
          footer={a ? [a.derivatives.connected ? t('analysis.derivAsOf', { when: fmtTime(a.derivatives.asOf) }) : t('analysis.derivNone'), a.cot.applicable ? (a.cot.connected ? t('analysis.cotAsOf', { when: fmtTime(a.cot.reportDate) }) : t('analysis.cotNone')) : t('analysis.cotNa')].join(' · ') : null}
        >
          <Row label={t('analysis.funding')} value={a?.derivatives.fundingRate == null ? '—' : pct(a.derivatives.fundingRate * 100, 4)} tone={a?.derivatives.fundingRate == null ? undefined : a.derivatives.fundingRate >= 0 ? 'pos' : 'neg'} />
          <Row label={t('analysis.oi')} value={a?.derivatives.openInterest == null ? '—' : num(a.derivatives.openInterest, 0)} />
          <Row label={t('analysis.oi24')} value={pct(a?.derivatives.oiChangePct24h, 1)} />
          <Row label={t('analysis.cotMarket')} value={a?.cot.market ?? '—'} />
          <Row label={t('analysis.cotStatus')} value={a?.cot.status ? t(`analysis.cot_${a.cot.status}`) : '—'} tone={a?.cot.status === 'crowded_long' || a?.cot.status === 'crowded_short' || a?.cot.status === 'contrarian_alert' ? 'warn' : undefined} />
          <Row label={t('analysis.cotNet')} value={a?.cot.netRatio == null ? '—' : `${num(a.cot.netRatio, 3)} · P${a.cot.percentile == null ? '—' : Math.round(a.cot.percentile * 100)}`} />
          <Row label={t('analysis.cotWeek')} value={a?.cot.weekChange == null ? '—' : `${a.cot.weekChange >= 0 ? '+' : ''}${num(a.cot.weekChange, 3)}`} />
        </Card>
        <Card name={t('analysis.sentinel')} sub={t('analysis.sentinelSub')} verdict={sentinel} t={t} footer={a ? (a.noTrade.calendarConnected ? t('analysis.calendarOk') : t('analysis.calendarNone')) : null}>
          <Row label={t('analysis.killSwitch')} value={a ? (a.risk.killSwitchActive ? t('analysis.on') : t('analysis.off')) : '—'} tone={a?.risk.killSwitchActive ? 'neg' : 'pos'} />
          <Row label={t('analysis.noTrade')} value={a ? (a.noTrade.active ? (a.noTrade.reason ?? t('analysis.on')) : t('analysis.noTradeNone')) : '—'} tone={a?.noTrade.active ? 'neg' : undefined} />
          <Row label={t('analysis.nextHigh')} value={a?.noTrade.nextHigh ? `${a.noTrade.nextHigh.title} · ${fmtTime(a.noTrade.nextHigh.scheduledAt)}` : '—'} />
          <Row label={t('analysis.atr')} value={pct(c?.atrPct, 2)} tone={(c?.atrPct ?? 0) >= 5 ? 'warn' : undefined} />
          <Row label={t('analysis.exposure')} value={a ? `${num(a.risk.exposureNotional, 0)} $ · ${t('analysis.positions', { n: a.risk.openPositions })}` : '—'} />
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
