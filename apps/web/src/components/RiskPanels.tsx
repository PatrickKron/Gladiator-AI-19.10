import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, EmptyState, LoadFailures, Loading, NotConnected, Panel, useLoadFailures } from './ui.js';
import { appLocale } from '../lib/locale.js';
import { noTradeNoticeKey, priceUnit, safe003State } from '../lib/asset-tabs.js';
import { normalizeRegime, REGIME_COLORS, type RegimeData } from '../lib/regime.js';

/**
 * Risiko-Panels (P2.9): GRS-Gauge mit Komponenten, Schutzschichten (SAFE/Gates/
 * Kill-Switch), adaptive Gates mit Evidenz, No-Trade-Fenster. Aus Aegis.tsx
 * herausgelöst für die zusammengeführte Asset-Detailseite.
 *
 * Ohne Props (Marktlage): globale Risiko-Lage wie bisher. Mit `symbol` + `venue` (Chart-Seite):
 * Termine, Positionen (Agent UND Demo), Volatilität/SAFE-003, Regime und Gates DIESES Assets;
 * Kill-Switch, Modus, Limits und GRS bleiben sichtbar, aber als „gilt global" markiert. Die
 * No-Trade-Sperre der Engine ist global — sie steht IMMER da, auch wenn ihr Termin dieses Asset
 * nicht betrifft (nie „frei" zeigen, wenn die Engine sperrt).
 */

type Gate = Awaited<ReturnType<typeof trpc.risk.gates.query>>[number];
type Settings = Awaited<ReturnType<typeof trpc.settings.get.query>>;
type Macro = Awaited<ReturnType<typeof trpc.market.macro.query>>;
type Calendar = Awaited<ReturnType<typeof trpc.market.calendar.query>>;
type Analysis = Awaited<ReturnType<typeof trpc.market.assetAnalysis.query>>;

const GRS_COLOR = (label: string) =>
  label === 'risk-off' ? 'var(--color-neg)' : label === 'risk-on' ? 'var(--color-pos)' : 'var(--color-warn)';

export function RiskPanels({ symbol, venue }: { symbol?: string; venue?: string } = {}) {
  if (!symbol) return <GlobalRiskPanels />;
  return <AssetRiskPanels key={`${venue ?? 'binance'}:${symbol}`} symbol={symbol} venue={venue ?? 'binance'} />;
}

function GlobalRiskPanels() {
  const { t } = useTranslation();
  const [gates, setGates] = useState<Gate[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [macro, setMacro] = useState<Macro | null>(null);
  const [calendar, setCalendar] = useState<Calendar | null>(null);

  const { failed, fail, reset } = useLoadFailures();
  const load = useCallback(() => {
    reset();
    void trpc.risk.gates.query().then(setGates).catch(fail('risk.gates', () => setGates([])));
    void trpc.settings.get.query().then(setSettings).catch(fail('settings', () => setSettings(null)));
    void trpc.market.macro.query().then(setMacro).catch(fail('market.macro', () => setMacro(null)));
    void trpc.market.calendar.query({ days: 2 }).then(setCalendar).catch(fail('market.calendar', () => setCalendar(null)));
  }, [fail, reset]);
  useEffect(() => load(), [load]);

  const grs = macro?.grs ?? null;
  const activeGates = (gates ?? []).filter((g) => g.isActive);
  const shieldItems = [
    { key: 'aegis.riskEngine', on: true },
    { key: 'aegis.safeSwitches', on: true },
    { key: 'aegis.adaptiveGates', on: activeGates.length > 0 },
    { key: 'aegis.killSwitch', on: settings?.killSwitchActive ?? false },
  ];

  return (
    <div>
      <LoadFailures failed={failed} onRetry={load} />
      <section className="grid gap-5 lg:grid-cols-2">
        {/* GRS-Gauge + Komponenten */}
        <Panel label={t('aegis.grsGauge')} stagger={1}>
          <div className="flex flex-col items-center py-5">
            <div className="relative flex h-40 w-40 items-center justify-center">
              <svg viewBox="0 0 120 120" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden="true">
                <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(148,163,184,0.18)" strokeWidth="6" />
                {grs && (
                  <circle
                    cx="60"
                    cy="60"
                    r="52"
                    fill="none"
                    stroke={GRS_COLOR(grs.label)}
                    strokeWidth="6"
                    strokeLinecap="round"
                    strokeDasharray={`${(grs.score / 100) * 2 * Math.PI * 52} ${2 * Math.PI * 52}`}
                    style={{ filter: `drop-shadow(0 0 10px ${GRS_COLOR(grs.label)})` }}
                  />
                )}
              </svg>
              <div className="text-center">
                <p className="num text-3xl font-semibold" style={{ color: grs ? GRS_COLOR(grs.label) : 'var(--color-mut)' }}>
                  {grs ? Math.round(grs.score) : '—'}
                </p>
                <p className="label mt-1">GRS</p>
                {grs && (
                  <p className="num mt-0.5 text-[10px] tracking-widest uppercase" style={{ color: GRS_COLOR(grs.label) }}>{grs.label}</p>
                )}
              </div>
            </div>
          </div>
          {grs ? (
            <>
              <p className="label">{t('aegis.grsComponents')}</p>
              <ul className="num mt-2 space-y-1.5 text-sm">
                <li className="flex justify-between">
                  <span style={{ color: 'var(--color-mut)' }}>VIX {grs.inputs.vix.toFixed(1)}</span>
                  <span>{Math.round(grs.components.vix.score)}</span>
                </li>
                <li className="flex justify-between">
                  <span style={{ color: 'var(--color-mut)' }}>
                    DXY {grs.inputs.dxyChangePct20d >= 0 ? '+' : ''}{grs.inputs.dxyChangePct20d.toFixed(2)} % (20d)
                  </span>
                  <span>{Math.round(grs.components.dxy.score)}</span>
                </li>
                <li className="flex justify-between">
                  <span style={{ color: 'var(--color-mut)' }}>
                    US10Y {grs.inputs.us10yChangeBp20d >= 0 ? '+' : ''}{grs.inputs.us10yChangeBp20d.toFixed(0)} bp (20d)
                  </span>
                  <span>{Math.round(grs.components.us10y.score)}</span>
                </li>
              </ul>
              <p className="mt-3 text-[11px] leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('aegis.grsFormulaHint')}</p>
            </>
          ) : (
            <NotConnected detail={t('oracle.syncPending')} />
          )}
          {calendar?.noTrade && (
            <p className="mt-3 rounded-[0.625rem] border p-3 text-xs leading-relaxed" style={{ borderColor: 'rgba(239,68,68,0.45)', color: 'var(--color-neg)' }}>
              {t('aegis.noTradeActive', { reason: calendar.noTrade.reason })}
            </p>
          )}
        </Panel>

        {/* Schutzschichten */}
        <Panel label={t('aegis.whatWorks')} stagger={2}>
          <ul className="mt-4 space-y-3">
            {shieldItems.map((item) => (
              <li key={item.key} className="flex items-start gap-3 rounded-[0.625rem] border p-3" style={{ borderColor: 'var(--color-line)' }}>
                <span
                  className={`neon-dot mt-1 ${item.on ? 'neon-dot--on' : 'neon-dot--off'}`}
                  style={item.key === 'aegis.killSwitch' && item.on ? { background: 'var(--color-neg)' } : undefined}
                />
                <span className="text-sm leading-relaxed">{t(item.key)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('aegis.shadowNote')}</p>
        </Panel>
      </section>

      {/* Adaptive Gates mit Evidenz */}
      <Panel label={t('aegis.gatesTitle')} stagger={3} className="mt-5">
        {gates === null ? (
          <Loading />
        ) : activeGates.length === 0 ? (
          <Empty text={t('aegis.noGates')} />
        ) : (
          <ul className="mt-4 space-y-3">
            {activeGates.map((g) => {
              const ev = g.evidence as { trades: number; expectancyR: number; winRate: number };
              return (
                <li key={g.id} className="rounded-[0.625rem] border p-4" style={{ borderColor: 'rgba(148,163,184,0.3)' }}>
                  <p className="text-sm font-medium">{g.reason}</p>
                  <p className="num label mt-2">
                    {t('aegis.evidence', { trades: ev.trades, expectancy: ev.expectancyR.toFixed(2), winRate: (ev.winRate * 100).toFixed(0) })}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
        <a href="#/einstellungen" className="mt-4 inline-block text-xs" style={{ color: 'var(--color-cyan)' }}>
          → {t('settings.gatesTitle')}
        </a>
      </Panel>
    </div>
  );
}

function Row({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <li className="flex items-baseline justify-between gap-3 py-1">
      <span className="min-w-0 text-sm" style={{ color: 'var(--color-mut)' }}>
        {label}
      </span>
      <span className="text-right">
        <span className="num text-sm font-semibold" style={{ color: color ?? 'var(--color-ink)' }}>
          {value}
        </span>
        {sub && (
          <span className="num block text-[11px]" style={{ color: 'var(--color-mut)' }}>
            {sub}
          </span>
        )}
      </span>
    </li>
  );
}

const SAFE_COLOR = { ok: 'var(--color-pos)', breach: 'var(--color-neg)', unknown: 'var(--color-mut)', na: 'var(--color-mut)' } as const;

/** Risiko-Tab der Chart-Seite: alles bezogen auf EIN Asset; Globales sichtbar als global markiert. */
function AssetRiskPanels({ symbol, venue }: { symbol: string; venue: string }) {
  const { t } = useTranslation();
  const [a, setA] = useState<Analysis | null | undefined>(undefined);
  const [gates, setGates] = useState<Gate[] | null | undefined>(undefined);
  const [regime, setRegime] = useState<RegimeData | null | undefined>(undefined);

  const { failed, fail, reset } = useLoadFailures();
  const load = useCallback(() => {
    reset();
    void trpc.market.assetAnalysis.query({ symbol, venue }).then(setA).catch(fail('market.assetAnalysis', () => setA(null)));
    void trpc.risk.gates.query({ symbol }).then(setGates).catch(fail('risk.gates', () => setGates(null)));
    void trpc.ml.regime
      .query({ symbol, timeframe: '1h', venue })
      .then((r) => setRegime(normalizeRegime(r)))
      .catch(fail('ml.regime', () => setRegime(null)));
  }, [fail, reset, symbol, venue]);
  useEffect(() => load(), [load]);

  const loc = appLocale();
  const pct = (n: number | null | undefined, d = 2) => (n == null ? '—' : `${n.toLocaleString(loc, { minimumFractionDigits: d, maximumFractionDigits: d })} %`);
  const when = (iso: string) => new Date(iso).toLocaleString(loc, { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const unit = priceUnit(a?.profile?.quoteCurrency ?? null);
  const money = (n: number) => `${n.toLocaleString(loc, { maximumFractionDigits: 0 })}${unit ? ` ${unit}` : ''}`;
  const notice = a ? noTradeNoticeKey(a.noTrade.scope) : null;
  const activeGates = (gates ?? []).filter((g) => g.isActive);
  const grs = a?.macro.grs ?? null;
  const v = a?.volatility ?? null;
  const btcState = v ? safe003State(v.safe003.btcMovePct, v.safe003.btcMaxPct) : 'unknown';
  const ethState = v ? safe003State(v.safe003.ethMovePct, v.safe003.ethMaxPct) : 'unknown';

  return (
    <div>
      <LoadFailures failed={failed} onRetry={load} />

      {/* Engine-Sperre (global) — immer zuerst, nie verschwiegen */}
      {a && notice && (
        <p className="mb-4 rounded-[0.625rem] border p-3 text-sm leading-relaxed" style={{ borderColor: 'rgba(239,68,68,0.45)', color: 'var(--color-neg)' }} role="alert">
          {t(notice, { reason: a.noTrade.reason ?? '', symbol })}
        </p>
      )}

      <section className="grid gap-5 lg:grid-cols-2">
        {/* Termine dieses Assets */}
        <Panel label={t('aegis.eventsTitle', { symbol })} stagger={1} className="min-w-0">
          {a === undefined ? (
            <Loading />
          ) : a === null ? (
            <NotConnected detail={t('analysis.calendarNone')} />
          ) : !a.noTrade.calendarConnected ? (
            <NotConnected detail={t('analysis.calendarNone')} />
          ) : (
            <>
              <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
                {a.noTrade.filter === 'asset' && a.noTrade.currencies?.length
                  ? t('aegis.eventsFilter', { currencies: a.noTrade.currencies.join('/') })
                  : t('aegis.eventsAll', { symbol })}
              </p>
              {a.noTrade.upcoming.length === 0 ? (
                <Empty text={t('aegis.eventsNone', { symbol })} />
              ) : (
                <ul className="mt-3 space-y-2">
                  {a.noTrade.upcoming.map((e) => (
                    <li key={`${e.scheduledAt}-${e.title}`} className="flex items-baseline justify-between gap-3 border-t pt-2 text-sm" style={{ borderColor: 'var(--color-line)' }}>
                      <span className="min-w-0 break-words">
                        {e.title}
                        {e.currency && (
                          <span className="num ml-1.5 text-xs" style={{ color: 'var(--color-mut)' }}>
                            {e.currency}
                          </span>
                        )}
                      </span>
                      <span className="num shrink-0 text-xs" style={{ color: 'var(--color-mut)' }}>
                        {when(e.scheduledAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {!a.noTrade.active && (
                <p className="label mt-3" style={{ color: 'var(--color-pos)' }}>
                  {t('aegis.noTradeNone')}
                </p>
              )}
            </>
          )}
        </Panel>

        {/* Positionen in diesem Asset — Agent und Demo getrennt */}
        <Panel label={t('aegis.exposureTitle', { symbol })} stagger={2} className="min-w-0">
          {a === undefined ? (
            <Loading />
          ) : a === null ? (
            <NotConnected detail={t('common.notConnected')} />
          ) : (
            <ul className="mt-3">
              <Row label={t('aegis.exposureAgent')} value={t('aegis.exposureValue', { n: a.risk.agent.positions, notional: money(a.risk.agent.notional) })} />
              <Row label={t('aegis.exposureDemo')} value={t('aegis.exposureValue', { n: a.risk.demo.positions, notional: money(a.risk.demo.notional) })} />
            </ul>
          )}
        </Panel>

        {/* Volatilität, SAFE-003 (global an BTC/ETH), Regime */}
        <Panel label={t('aegis.volTitle', { symbol })} stagger={3} className="min-w-0">
          {a === undefined ? (
            <Loading />
          ) : a === null || !v ? (
            <NotConnected detail={t('common.notConnected')} />
          ) : (
            <>
              <ul className="mt-3">
                <Row label={t('aegis.atr')} value={pct(v.atrPct)} color={(v.atrPct ?? 0) >= 5 ? 'var(--color-warn)' : undefined} />
                <Row
                  label={t('aegis.intraday')}
                  value={v.safe003.assetMaxPct === null ? pct(v.intradayMovePct) : `${pct(v.intradayMovePct)} / ${v.safe003.assetMaxPct} %`}
                  color={v.safe003.assetMaxPct === null ? undefined : SAFE_COLOR[safe003State(v.intradayMovePct, v.safe003.assetMaxPct)]}
                />
                <Row
                  label={t('aegis.regimeTitle')}
                  value={regime === undefined ? '…' : regime === null ? '—' : t(`regime.${regime.regime}`)}
                  color={regime ? REGIME_COLORS[regime.regime] : undefined}
                  sub={regime ? `${Math.round(regime.confidence * 100)} % ${t('regime.confidence')}` : regime === null ? t('aegis.regimeNone') : undefined}
                />
              </ul>
              <p className="label mt-4">{t('aegis.safe003Title')}</p>
              <ul className="mt-1">
                <Row label={t('aegis.safe003Major', { asset: 'BTC', max: v.safe003.btcMaxPct })} value={pct(v.safe003.btcMovePct)} color={SAFE_COLOR[btcState]} />
                <Row label={t('aegis.safe003Major', { asset: 'ETH', max: v.safe003.ethMaxPct })} value={pct(v.safe003.ethMovePct)} color={SAFE_COLOR[ethState]} />
              </ul>
              {(btcState === 'breach' || ethState === 'breach') && (
                <p className="mt-2 text-xs" style={{ color: 'var(--color-neg)' }}>
                  {t('aegis.safe003Breach')}
                </p>
              )}
              <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
                {v.safe003.assetMaxPct === null ? t('aegis.safe003None', { symbol }) : t('aegis.safe003AssetLimit', { symbol, max: v.safe003.assetMaxPct })}
              </p>
            </>
          )}
        </Panel>

        {/* Adaptive Gates: ohne Symbol-Bindung oder genau dieses Symbol */}
        <Panel label={t('aegis.gatesAssetTitle', { symbol })} stagger={4} className="min-w-0">
          {gates === undefined ? (
            <Loading />
          ) : gates === null ? (
            <NotConnected detail={t('common.notConnected')} />
          ) : activeGates.length === 0 ? (
            <EmptyState text={t('aegis.noGatesAsset', { symbol })} actionLabel={t('settings.gatesTitle')} href="#/einstellungen" />
          ) : (
            <ul className="mt-4 space-y-3">
              {activeGates.map((g) => {
                const ev = g.evidence as { trades: number; expectancyR: number; winRate: number };
                return (
                  <li key={g.id} className="rounded-[0.625rem] border p-3" style={{ borderColor: 'rgba(148,163,184,0.3)' }}>
                    <p className="text-sm font-medium">{g.reason}</p>
                    <p className="num label mt-1">{t('aegis.evidence', { trades: ev.trades, expectancy: ev.expectancyR.toFixed(2), winRate: (ev.winRate * 100).toFixed(0) })}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </section>

      {/* Gilt global — Kill-Switch, Modus, Limits, GRS */}
      <Panel label={t('aegis.globalTitle')} stagger={5} className="mt-5">
        {a === undefined ? (
          <Loading />
        ) : a === null ? (
          <NotConnected detail={t('common.notConnected')} />
        ) : (
          <>
            <ul className="mt-3 grid gap-x-8 md:grid-cols-2">
              <Row label={t('analysis.killSwitch')} value={a.risk.killSwitchActive ? t('analysis.on') : t('analysis.off')} color={a.risk.killSwitchActive ? 'var(--color-neg)' : 'var(--color-pos)'} />
              <Row label={t('analysis.mode')} value={a.risk.mode} />
              <Row label="GRS" value={grs ? `${Math.round(grs.score)} · ${t(`analysis.grs_${grs.label}`)}` : '—'} color={grs ? GRS_COLOR(grs.label) : undefined} />
              <Row
                label={t('analysis.limits')}
                value=""
                sub={t('analysis.limitsValue', {
                  risk: a.risk.riskPctPerTrade.toLocaleString(loc, { maximumFractionDigits: 1 }),
                  lev: a.risk.maxLeverage.toLocaleString(loc, { maximumFractionDigits: 0 }),
                  exp: a.risk.maxExposurePctPerAsset.toLocaleString(loc, { maximumFractionDigits: 0 }),
                  day: a.risk.dailyLossLimitPct.toLocaleString(loc, { maximumFractionDigits: 1 }),
                })}
              />
            </ul>
            <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
              {t('aegis.globalHint')}{' '}
              <a href="#/marktlage?tab=risiko" style={{ color: 'var(--color-cyan)' }}>
                → {t('ia.page_marketState')}
              </a>
            </p>
          </>
        )}
      </Panel>
    </div>
  );
}
