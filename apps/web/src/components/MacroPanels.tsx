import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { EmptyState, LoadFailures, Loading, NotConnected, Panel, useLoadFailures } from './ui.js';
import { Sparkline } from './Sparkline.js';
import { appLocale } from '../lib/locale.js';
import { assetMacroPlan, derivativeState } from '../lib/asset-tabs.js';

/**
 * Makro-Panels (P2.9): GRS-Ring, Pulse (VIX/DXY), Gravity (US10Y), Footprint
 * (Funding/OI), COT (CFTC, echt), DNA (On-Chain: Coin Metrics Community +
 * DefiLlama, fehlende Quelle ehrlich „nicht verbunden“)
 * + GRS-Verlauf (P2.11).
 * Aus Oracle.tsx herausgelöst, damit die Asset-Detailseite dieselbe Ansicht zeigt.
 *
 * Ohne Props (Marktlage): globaler Überblick wie bisher. Mit `symbol` + `venue` (Chart-Seite,
 * Patrick 2026-10-25: „COT nur für das jeweilige Asset"): kompakter, als GLOBAL markierter
 * Marktrahmen (GRS/VIX/DXY/US10Y) und darunter NUR, was zu diesem Asset gehört — COT des
 * eigenen Markts, Funding/OI des eigenen Perps, On-Chain nur für BTC/ETH, Buffett nur für den
 * US-Aktienmarkt, Realzins nur für Rohstoffe. Passt etwas nicht, steht ein ehrlicher Satz da.
 */

type Macro = Awaited<ReturnType<typeof trpc.market.macro.query>>;
type Derivatives = Awaited<ReturnType<typeof trpc.market.derivatives.query>>;
type GrsHist = Awaited<ReturnType<typeof trpc.market.grsHistory.query>>;
type Cot = Awaited<ReturnType<typeof trpc.intelligence.cotSnapshot.query>>;
type Onchain = Awaited<ReturnType<typeof trpc.intelligence.onchain.query>>;
type CotHistory = Awaited<ReturnType<typeof trpc.intelligence.cotHistory.query>>;
type Buffett = Awaited<ReturnType<typeof trpc.intelligence.buffettStatus.query>>;
type Watchlist = Awaited<ReturnType<typeof trpc.market.dataWatchlist.query>>;

/** Farben je MVRV-Zone (unterbewertet = Chance, überhitzt = Warnung). */
const MVRV_COLOR: Record<NonNullable<Onchain['assets'][number]['zone']>, string> = {
  undervalued: 'var(--color-pos)',
  neutral: 'var(--color-mut)',
  elevated: 'var(--color-warn)',
  overheated: 'var(--color-neg)',
};

/** Farben je COT-Status — gleiche Semantik wie im Tab „Entscheidung". */
const COT_COLOR: Record<Cot[number]['positioning']['status'], string> = {
  not_applicable: 'var(--color-mut)',
  neutral: 'var(--color-mut)',
  crowded_long: 'var(--color-warn)',
  crowded_short: 'var(--color-warn)',
  contrarian_alert: 'var(--color-neg)',
};

const GRS_COLOR = (label: string) =>
  label === 'risk-off' ? 'var(--color-neg)' : label === 'risk-on' ? 'var(--color-pos)' : 'var(--color-warn)';

function MetricRow({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-sm" style={{ color: 'var(--color-mut)' }}>{label}</span>
      <span className="text-right">
        <span className="num text-sm font-semibold" style={{ color: color ?? 'var(--color-ink)' }}>{value}</span>
        {sub && <span className="num ml-2 text-xs" style={{ color: 'var(--color-mut)' }}>{sub}</span>}
      </span>
    </div>
  );
}

export function MacroPanels({ symbol, venue }: { symbol?: string; venue?: string } = {}) {
  if (!symbol) return <GlobalMacroPanels />;
  return <AssetMacroPanels key={`${venue ?? 'binance'}:${symbol}`} symbol={symbol} venue={venue ?? 'binance'} />;
}

function GlobalMacroPanels() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [macro, setMacro] = useState<Macro | null>(null);
  const [deriv, setDeriv] = useState<Derivatives>([]);
  const [hist, setHist] = useState<GrsHist>([]);
  const [cot, setCot] = useState<Cot>([]);
  const [onchain, setOnchain] = useState<Onchain | null>(null);

  const { failed, fail, reset } = useLoadFailures();
  const load = useCallback(() => {
    reset();
    void trpc.market.macro.query().then(setMacro).catch(fail('market.macro', () => setMacro(null)));
    void trpc.market.derivatives.query().then(setDeriv).catch(fail('market.derivatives', () => setDeriv([])));
    void trpc.market.grsHistory.query().then(setHist).catch(fail('market.grsHistory', () => setHist([])));
    void trpc.intelligence.cotSnapshot.query({}).then(setCot).catch(fail('intelligence.cotSnapshot', () => setCot([])));
    void trpc.intelligence.onchain.query().then(setOnchain).catch(fail('intelligence.onchain', () => setOnchain(null)));
  }, [fail, reset]);
  useEffect(() => load(), [load]);

  const cotRows = cot.filter((c) => c.weeks > 0);

  const grs = macro?.grs ?? null;
  const pct = (n: number | null | undefined, d = 2) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}`);

  return (
    <div>
      <LoadFailures failed={failed} onRetry={load} />
      {/* GRS-Zentrum: Ring + Verlauf */}
      <Panel stagger={1} className="relative overflow-hidden">
        {macro === null ? (
          <Loading />
        ) : (
          <div className="flex flex-col items-center py-6">
            <div className="relative flex h-48 w-48 items-center justify-center">
              <svg viewBox="0 0 120 120" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden="true">
                <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(148,163,184,0.15)" strokeWidth="6" />
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
                    style={{ filter: `drop-shadow(0 0 10px ${GRS_COLOR(grs.label)})`, transition: 'stroke-dasharray 800ms var(--ease-out-soft)' }}
                  />
                )}
                <circle cx="60" cy="60" r="42" fill="none" stroke="rgba(148,163,184,0.25)" strokeWidth="1" strokeDasharray="2 4" />
              </svg>
              <div className="text-center">
                <p className="num text-4xl font-semibold" style={{ color: grs ? GRS_COLOR(grs.label) : 'var(--color-mut)' }}>
                  {grs ? Math.round(grs.score) : '—'}
                </p>
                <p className="label mt-1">{t('oracle.grs')}</p>
                {grs && (
                  <p className="num mt-1 text-xs tracking-widest uppercase" style={{ color: GRS_COLOR(grs.label) }}>{grs.label}</p>
                )}
              </div>
            </div>
            {!grs && (
              <p className="mt-4 max-w-xl text-center text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('oracle.syncPending')}</p>
            )}
            {/* GRS-Verlauf 30 T (P2.11) */}
            {hist.length >= 2 && (
              <div className="mt-5 w-full max-w-md">
                <p className="label mb-1 text-center">{t('oracle.grsHistory')}</p>
                <Sparkline closes={hist.map((h) => h.score)} id="spark-grs" />
              </div>
            )}
            {macro.vix && (
              <p className="label mt-4">{t('oracle.updated')}: {new Date(macro.vix.ts).toLocaleDateString(appLocale())}</p>
            )}
          </div>
        )}
      </Panel>

      <section className="mt-5 grid gap-5 md:grid-cols-2">
        {/* Pulse: VIX + DXY */}
        <Panel label={t('oracle.pulse')} stagger={2}>
          {macro?.vix ? (
            <div className="mt-3">
              <MetricRow
                label="VIX"
                value={macro.vix.value.toFixed(2)}
                sub={grs ? `Score ${Math.round(grs.components.vix.score)}` : undefined}
                color={macro.vix.value >= 25 ? 'var(--color-neg)' : macro.vix.value >= 18 ? 'var(--color-warn)' : 'var(--color-pos)'}
              />
              <Sparkline closes={macro.series.vix.map((p) => p.value)} id="spark-vix" />
              <MetricRow
                label={`DXY · ${t('oracle.change20d')}`}
                value={`${macro.dxy ? macro.dxy.value.toFixed(2) : '—'}`}
                sub={grs ? `${pct(grs.inputs.dxyChangePct20d)} %` : undefined}
              />
              <Sparkline closes={macro.series.dxy.map((p) => p.value)} id="spark-dxy" />
            </div>
          ) : macro === null ? (
            <Loading />
          ) : (
            <NotConnected detail={t('oracle.syncPending')} />
          )}
        </Panel>

        {/* Gravity: US10Y + FRED-Status */}
        <Panel label={t('oracle.gravity')} stagger={3}>
          {macro?.us10y ? (
            <div className="mt-3">
              <MetricRow
                label={`US10Y (%) · ${t('oracle.change20d')}`}
                value={macro.us10y.value.toFixed(2)}
                sub={grs ? `${pct(grs.inputs.us10yChangeBp20d, 0)} bp` : undefined}
              />
              <Sparkline closes={macro.series.us10y.map((p) => p.value)} id="spark-us10y" />
              <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
                FRED: {macro.fredConfigured ? '✓' : t('common.notConnected')} —{' '}
                {macro.fredConfigured ? 'FRED_API_KEY gesetzt' : 'optional (FRED_API_KEY), VIX/DXY/US10Y laufen ohne.'}
              </p>
            </div>
          ) : macro === null ? (
            <Loading />
          ) : (
            <NotConnected detail={t('oracle.syncPending')} />
          )}
        </Panel>

        {/* Footprint: Funding/OI */}
        <Panel label={t('oracle.footprint')} stagger={4}>
          {deriv.length > 0 && deriv.some((d) => d.fundingRate !== null) ? (
            <div className="mt-3">
              <p className="text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('oracle.footprintLive')}</p>
              <table className="num mt-3 w-full text-sm">
                <thead>
                  <tr className="label text-left">
                    <th className="py-1 pr-3 font-normal">{t('dashboard.symbol')}</th>
                    <th className="py-1 pr-3 text-right font-normal">{t('oracle.fundingRate')}</th>
                    <th className="py-1 text-right font-normal">{t('oracle.oiChange')}</th>
                  </tr>
                </thead>
                <tbody>
                  {deriv.map((d) => (
                    <tr key={d.symbol} style={{ borderTop: '1px solid rgba(148,163,184,0.08)' }}>
                      <td className="py-1.5 pr-3">{d.symbol.replace('/USDT', '')}</td>
                      <td className="py-1.5 pr-3 text-right" style={{ color: (d.fundingRate ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                        {d.fundingRate != null ? `${(d.fundingRate * 100).toFixed(4)} %` : '—'}
                      </td>
                      <td className="py-1.5 text-right" style={{ color: (d.oiChangePct24h ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                        {d.oiChangePct24h != null ? `${pct(d.oiChangePct24h)} %` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <NotConnected detail={t('oracle.syncPending')} />
          )}
        </Panel>

        {/* COT: Large-Speculator-Positionierung (CFTC, echt) — füllt den früheren „COT folgt"-Slot.
            min-w-0: die nowrap-Tabelle darf das Grid nicht aufweiten (Mobile), sie scrollt intern. */}
        <Panel label={t('intel.cotTitle')} stagger={5} className="min-w-0">
          {cotRows.length > 0 ? (
            <div className="mt-3">
              <p className="text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('oracle.cotLive')}</p>
              <div className="overflow-x-auto">
                <table className="num mt-3 w-full text-sm">
                  <thead>
                    <tr className="label text-left">
                      <th className="py-1 pr-3 font-normal">{t('intel.cotMarket')}</th>
                      <th className="py-1 pr-3 text-right font-normal">{t('intel.cotNetRatio')}</th>
                      <th className="py-1 pr-3 text-right font-normal">{t('intel.cotPercentile')}</th>
                      <th className="py-1 font-normal">{t('intel.cotStatus')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cotRows.map((c) => (
                      <tr key={c.market.code} style={{ borderTop: '1px solid rgba(148,163,184,0.08)' }}>
                        <td className="py-1.5 pr-3">{t(`intel.cotMarket_${c.market.label}`)}</td>
                        <td className="py-1.5 pr-3 text-right" style={{ color: c.positioning.netRatio >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                          {pct(c.positioning.netRatio * 100, 1)} %
                        </td>
                        <td className="py-1.5 pr-3 text-right">{Math.round(c.positioning.percentile * 100)}</td>
                        <td className="py-1.5">
                          <span
                            className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
                            style={{ borderColor: COT_COLOR[c.positioning.status], color: COT_COLOR[c.positioning.status] }}
                          >
                            {t(`intel.cotStatus_${c.positioning.status}`)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {cotRows[0]?.reportDate && (
                <p className="label mt-2">{t('intel.cotReportDate')}: {new Date(cotRows[0].reportDate).toLocaleDateString(appLocale())}</p>
              )}
            </div>
          ) : (
            <NotConnected detail={t('intel.cotNotConnected')} />
          )}
        </Panel>

        {/* DNA: On-Chain — echte Tageswerte (Coin Metrics Community, DefiLlama); fehlt eine Quelle, steht ihr Grund da */}
        <Panel label={t('oracle.dna')} stagger={6}>
          {onchain === null ? (
            <Loading />
          ) : onchain.assets.every((a) => a.error) && onchain.stablecoins.error ? (
            <NotConnected detail={[...new Set([...onchain.assets.map((a) => a.error), onchain.stablecoins.error])].join(' · ')} />
          ) : (
            <div className="mt-2">
              {onchain.assets.map((a) =>
                a.error ? (
                  <MetricRow key={a.asset} label={`${a.asset.toUpperCase()} MVRV`} value="—" sub={a.error} />
                ) : (
                  <div key={a.asset}>
                    <MetricRow
                      label={`${a.asset.toUpperCase()} MVRV`}
                      value={a.mvrv === null ? '—' : a.mvrv.toFixed(2)}
                      sub={a.zone ? `${t(`oracle.mvrv_${a.zone}`)}${a.mvrvPercentile !== null ? ` · P${Math.round(a.mvrvPercentile * 100)}` : ''}` : undefined}
                      color={a.zone ? MVRV_COLOR[a.zone] : undefined}
                    />
                    <MetricRow
                      label={t('oracle.activeAddresses', { asset: a.asset.toUpperCase() })}
                      value={a.activeAddresses === null ? '—' : new Intl.NumberFormat(lang).format(Math.round(a.activeAddresses))}
                      sub={a.activeAddresses30dPct === null ? undefined : `${pct(a.activeAddresses30dPct, 1)} % 30 d`}
                    />
                  </div>
                ),
              )}
              <MetricRow
                label={t('oracle.stablecoins')}
                value={onchain.stablecoins.totalUsd === null ? '—' : new Intl.NumberFormat(lang, { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(onchain.stablecoins.totalUsd)}
                sub={onchain.stablecoins.error ?? (onchain.stablecoins.change30dPct === null ? undefined : `${pct(onchain.stablecoins.change30dPct, 1)} % 30 d`)}
              />
              <p className="label mt-2">
                {t('oracle.dnaSource')}
                {onchain.assets[0]?.asOf ? ` · ${new Date(onchain.assets[0].asOf).toLocaleDateString(lang)}` : ''}
              </p>
            </div>
          )}
        </Panel>
      </section>

      <p className="mt-6 text-center text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('oracle.honest')}</p>
    </div>
  );
}

const BUFFETT_COLOR: Record<Buffett['status'], string> = {
  not_applicable: 'var(--color-mut)',
  neutral: 'var(--color-pos)',
  elevated: 'var(--color-warn)',
  extreme: 'var(--color-neg)',
};

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="min-w-0">
      <p className="label truncate">{label}</p>
      <p className="num mt-1 text-lg font-semibold" style={{ color: color ?? 'var(--color-ink)' }}>
        {value}
      </p>
      {sub && (
        <p className="num truncate text-xs" style={{ color: 'var(--color-mut)' }}>
          {sub}
        </p>
      )}
    </div>
  );
}

/** Makro-Tab der Chart-Seite: alles bezogen auf EIN Asset (undefined = lädt, null = Fehler). */
function AssetMacroPanels({ symbol, venue }: { symbol: string; venue: string }) {
  const { t } = useTranslation();
  const plan = useMemo(() => assetMacroPlan(symbol, venue), [symbol, venue]);
  const [macro, setMacro] = useState<Macro | null | undefined>(undefined);
  const [cot, setCot] = useState<Cot | null | undefined>(undefined);
  const [hist, setHist] = useState<CotHistory | undefined>(undefined);
  const [deriv, setDeriv] = useState<Derivatives | null | undefined>(undefined);
  const [onchain, setOnchain] = useState<Onchain | null | undefined>(undefined);
  const [buffett, setBuffett] = useState<Buffett | null | undefined>(undefined);
  const [watch, setWatch] = useState<Watchlist | null | undefined>(undefined);

  const { failed, fail, reset } = useLoadFailures();
  const load = useCallback(() => {
    reset();
    void trpc.market.macro.query().then(setMacro).catch(fail('market.macro', () => setMacro(null)));
    void trpc.intelligence.cotSnapshot.query({ symbol }).then(setCot).catch(fail('intelligence.cotSnapshot', () => setCot(null)));
    void trpc.intelligence.cotHistory.query({ symbol }).then(setHist).catch(fail('intelligence.cotHistory', () => setHist(null)));
    if (plan.derivatives) void trpc.market.derivatives.query({ symbols: [symbol] }).then(setDeriv).catch(fail('market.derivatives', () => setDeriv(null)));
    if (plan.onchain) void trpc.intelligence.onchain.query().then(setOnchain).catch(fail('intelligence.onchain', () => setOnchain(null)));
    if (plan.valuation === 'us') void trpc.intelligence.buffettStatus.query().then(setBuffett).catch(fail('intelligence.buffettStatus', () => setBuffett(null)));
    if (plan.realYield) void trpc.market.dataWatchlist.query().then(setWatch).catch(fail('market.dataWatchlist', () => setWatch(null)));
  }, [fail, reset, symbol, plan]);
  useEffect(() => load(), [load]);

  const loc = appLocale();
  const signed = (n: number, d = 2) => `${n >= 0 ? '+' : ''}${n.toLocaleString(loc, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
  const fixed = (n: number, d = 2) => n.toLocaleString(loc, { minimumFractionDigits: d, maximumFractionDigits: d });
  const day = (iso: string | Date | null | undefined) => (iso ? new Date(iso).toLocaleDateString(loc) : '—');
  const dayTime = (iso: string | Date | null | undefined) => (iso ? new Date(iso).toLocaleString(loc, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

  const grs = macro?.grs ?? null;
  const cotEntry = cot?.[0] ?? null;
  const cotMarket = cotEntry ? t(`intel.cotMarket_${cotEntry.market.label}`) : '';
  const derivEntry = deriv?.find((d) => d.symbol === symbol.toUpperCase()) ?? deriv?.[0] ?? null;
  const dState = derivativeState(derivEntry);
  const onchainAsset = onchain && plan.onchain ? (onchain.assets.find((a) => a.asset === plan.onchain) ?? null) : null;
  const realYield = watch?.find((w) => w.seriesId === 'DFII10') ?? null;

  return (
    <div>
      <LoadFailures failed={failed} onRetry={load} />

      {/* Marktrahmen — ausdrücklich GLOBAL, für jedes Asset gleich */}
      <Panel label={t('oracle.globalTitle')} stagger={1}>
        {macro === undefined ? (
          <Loading />
        ) : !macro || (!grs && !macro.vix) ? (
          <NotConnected detail={t('oracle.syncPending')} />
        ) : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
              <Stat label={t('oracle.grs')} value={grs ? String(Math.round(grs.score)) : '—'} sub={grs?.label} color={grs ? GRS_COLOR(grs.label) : undefined} />
              <Stat
                label="VIX"
                value={macro.vix ? fixed(macro.vix.value) : '—'}
                color={macro.vix ? (macro.vix.value >= 25 ? 'var(--color-neg)' : macro.vix.value >= 18 ? 'var(--color-warn)' : 'var(--color-pos)') : undefined}
              />
              <Stat label="DXY" value={macro.dxy ? fixed(macro.dxy.value) : '—'} sub={grs ? `${signed(grs.inputs.dxyChangePct20d)} % · ${t('oracle.change20d')}` : undefined} />
              <Stat label="US10Y (%)" value={macro.us10y ? fixed(macro.us10y.value) : '—'} sub={grs ? `${signed(grs.inputs.us10yChangeBp20d, 0)} bp · ${t('oracle.change20d')}` : undefined} />
            </div>
            <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
              {t('oracle.globalNote')}{' '}
              <a href="#/marktlage?tab=makro" style={{ color: 'var(--color-cyan)' }}>
                → {t('oracle.globalMore')}
              </a>
            </p>
          </>
        )}
      </Panel>

      <section className="mt-5 grid gap-5 md:grid-cols-2">
        {/* COT — nur der CFTC-Markt DIESES Assets */}
        <Panel label={t('intel.cotTitle')} stagger={2} className="min-w-0">
          {cot === undefined ? (
            <Loading />
          ) : cot === null ? (
            <NotConnected detail={t('intel.cotNotConnected')} />
          ) : !cotEntry ? (
            <EmptyState text={t('oracle.cotNone', { symbol })} />
          ) : cotEntry.weeks === 0 ? (
            <NotConnected detail={t('intel.cotNotConnected')} />
          ) : (
            <div className="mt-3">
              <p className="text-sm font-medium">{cotMarket}</p>
              {plan.etf && (
                <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
                  {t('oracle.cotUnderlying', { market: cotMarket })}
                </p>
              )}
              {cotEntry.inverse && (
                <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--color-warn)' }}>
                  {t('oracle.cotInverse', { symbol, market: cotMarket })}
                </p>
              )}
              <div className="mt-2">
                <MetricRow label={t('intel.cotNetRatio')} value={`${signed(cotEntry.positioning.netRatio * 100, 1)} %`} color={cotEntry.positioning.netRatio >= 0 ? 'var(--color-pos)' : 'var(--color-neg)'} />
                <MetricRow label={t('intel.cotPercentile')} value={String(Math.round(cotEntry.positioning.percentile * 100))} />
                <MetricRow label={t('intel.cotWeekChange')} value={`${signed(cotEntry.positioning.weekChange * 100, 1)} pp`} />
                <div className="flex items-baseline justify-between gap-3 py-1.5">
                  <span className="text-sm" style={{ color: 'var(--color-mut)' }}>
                    {t('intel.cotStatus')}
                  </span>
                  <span
                    className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
                    style={{ borderColor: COT_COLOR[cotEntry.positioning.status], color: COT_COLOR[cotEntry.positioning.status] }}
                  >
                    {t(`intel.cotStatus_${cotEntry.positioning.status}`)}
                  </span>
                </div>
              </div>
              {hist && hist.points.length >= 2 && (
                <div className="mt-3">
                  <p className="label mb-1">{t('oracle.cotHistory')}</p>
                  <Sparkline closes={hist.points.map((p) => p.netRatio)} id="spark-cot-asset" />
                </div>
              )}
              <p className="label mt-2">
                {t('intel.cotReportDate')}: {day(cotEntry.reportDate)}
              </p>
            </div>
          )}
        </Panel>

        {/* Footprint — Funding/OI nur des eigenen Perps */}
        <Panel label={t('oracle.footprint')} stagger={3} className="min-w-0">
          {!plan.derivatives ? (
            <EmptyState text={t('oracle.noPerp', { symbol })} />
          ) : deriv === undefined ? (
            <Loading />
          ) : deriv === null ? (
            <NotConnected detail={t('oracle.syncPending')} />
          ) : dState === 'ok' && derivEntry ? (
            <div className="mt-3">
              <MetricRow
                label={t('oracle.fundingRate')}
                value={`${((derivEntry.fundingRate ?? 0) * 100).toFixed(4)} %`}
                color={(derivEntry.fundingRate ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)'}
              />
              <MetricRow label={t('oracle.oi')} value={derivEntry.openInterest === null ? '—' : derivEntry.openInterest.toLocaleString(loc, { maximumFractionDigits: 0 })} />
              <MetricRow
                label={t('oracle.oiChange')}
                value={derivEntry.oiChangePct24h === null ? '—' : `${signed(derivEntry.oiChangePct24h)} %`}
                color={derivEntry.oiChangePct24h === null ? undefined : derivEntry.oiChangePct24h >= 0 ? 'var(--color-pos)' : 'var(--color-neg)'}
              />
              <p className="label mt-2">
                {t('oracle.updated')}: {dayTime(derivEntry.fundingTs)}
              </p>
            </div>
          ) : dState === 'no_perp' ? (
            <EmptyState text={t('oracle.noPerpListed', { symbol })} />
          ) : dState === 'not_synced' ? (
            <EmptyState text={t('oracle.perpNotSynced', { symbol })} />
          ) : dState === 'pending' ? (
            <NotConnected detail={t('oracle.perpPending')} />
          ) : (
            <NotConnected detail={t('oracle.perpUnknown', { symbol })} />
          )}
        </Panel>

        {/* DNA — On-Chain nur für BTC/ETH */}
        <Panel label={t('oracle.dna')} stagger={4} className="min-w-0">
          {!plan.onchain ? (
            <EmptyState text={t('oracle.onchainNa', { symbol })} />
          ) : onchain === undefined ? (
            <Loading />
          ) : onchain === null || !onchainAsset ? (
            <NotConnected detail={t('oracle.syncPending')} />
          ) : (
            <div className="mt-2">
              {onchainAsset.error ? (
                <MetricRow label={`${onchainAsset.asset.toUpperCase()} MVRV`} value="—" sub={onchainAsset.error} />
              ) : (
                <>
                  <MetricRow
                    label={`${onchainAsset.asset.toUpperCase()} MVRV`}
                    value={onchainAsset.mvrv === null ? '—' : fixed(onchainAsset.mvrv)}
                    sub={onchainAsset.zone ? `${t(`oracle.mvrv_${onchainAsset.zone}`)}${onchainAsset.mvrvPercentile !== null ? ` · P${Math.round(onchainAsset.mvrvPercentile * 100)}` : ''}` : undefined}
                    color={onchainAsset.zone ? MVRV_COLOR[onchainAsset.zone] : undefined}
                  />
                  <MetricRow
                    label={t('oracle.activeAddresses', { asset: onchainAsset.asset.toUpperCase() })}
                    value={onchainAsset.activeAddresses === null ? '—' : Math.round(onchainAsset.activeAddresses).toLocaleString(loc)}
                    sub={onchainAsset.activeAddresses30dPct === null ? undefined : `${signed(onchainAsset.activeAddresses30dPct, 1)} % 30 d`}
                  />
                </>
              )}
              <MetricRow
                label={t('oracle.stablecoins')}
                value={
                  onchain.stablecoins.totalUsd === null
                    ? '—'
                    : new Intl.NumberFormat(loc, { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(onchain.stablecoins.totalUsd)
                }
                sub={onchain.stablecoins.error ?? (onchain.stablecoins.change30dPct === null ? undefined : `${signed(onchain.stablecoins.change30dPct, 1)} % 30 d`)}
              />
              <p className="label mt-2">
                {t('oracle.dnaSource')}
                {onchainAsset.asOf ? ` · ${day(onchainAsset.asOf)}` : ''}
              </p>
            </div>
          )}
        </Panel>

        {/* Bewertung — Buffett-Indikator nur für den US-Aktienmarkt */}
        {plan.valuation && (
          <Panel label={t('intel.buffettTitle')} stagger={5} className="min-w-0">
            {plan.valuation === 'non_us' ? (
              <EmptyState text={t('oracle.buffettNa', { symbol })} />
            ) : buffett === undefined ? (
              <Loading />
            ) : buffett === null || !buffett.connected ? (
              <NotConnected detail={t('intel.buffettNotConnected')} />
            ) : (
              <div className="mt-3">
                <MetricRow label={t('oracle.buffettRatio')} value={buffett.ratio === null ? '—' : `${fixed(buffett.ratio * 100, 0)} %`} color={BUFFETT_COLOR[buffett.status]} />
                <MetricRow
                  label={t('intel.cotStatus')}
                  value={t(`intel.buffettStatus_${buffett.status}`)}
                  color={BUFFETT_COLOR[buffett.status]}
                  sub={t('intel.buffettPercentile', { n: Math.round(buffett.percentile * 100) })}
                />
                <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
                  {t('intel.buffettHint')}
                </p>
                <p className="label mt-2">{t('intel.buffettAsOf', { date: day(buffett.ts) })}</p>
              </div>
            )}
          </Panel>
        )}

        {/* Realzins — nur Rohstoffe, nur wenn DFII10 schon synchronisiert ist (keine neue Serie still anlegen) */}
        {plan.realYield && (
          <Panel label={t('oracle.realYieldTitle')} stagger={6} className="min-w-0">
            {watch === undefined ? (
              <Loading />
            ) : !realYield ? (
              <EmptyState text={t('oracle.realYieldNone')} actionLabel={t('oracle.realYieldAdd')} href="#/marktlage?tab=daten" />
            ) : (
              <div className="mt-3">
                <MetricRow
                  label="DFII10 (%)"
                  value={fixed(realYield.latest)}
                  sub={realYield.previous === null ? undefined : `${signed((realYield.latest - realYield.previous) * 100, 0)} bp`}
                />
                {realYield.series.length >= 2 && <Sparkline closes={realYield.series.map((p) => p.value)} id="spark-dfii10" />}
                <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
                  {t('oracle.realYieldHint')}
                </p>
                <p className="label mt-2">
                  {t('oracle.updated')}: {day(realYield.latestTs)}
                </p>
              </div>
            )}
          </Panel>
        )}
      </section>

      <p className="mt-6 text-center text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('oracle.assetHonest', { symbol })}
      </p>
    </div>
  );
}
