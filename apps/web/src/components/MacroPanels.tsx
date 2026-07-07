import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Loading, NotConnected, Panel } from './ui.js';
import { Sparkline } from './Sparkline.js';

/**
 * Makro-Panels (P2.9): GRS-Ring, Pulse (VIX/DXY), Gravity (US10Y), Footprint
 * (Funding/OI), DNA (On-Chain, ehrlich nicht verbunden) + GRS-Verlauf (P2.11).
 * Aus Oracle.tsx herausgelöst, damit die Asset-Detailseite dieselbe Ansicht zeigt.
 */

type Macro = Awaited<ReturnType<typeof trpc.market.macro.query>>;
type Derivatives = Awaited<ReturnType<typeof trpc.market.derivatives.query>>;
type GrsHist = Awaited<ReturnType<typeof trpc.market.grsHistory.query>>;

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

export function MacroPanels() {
  const { t } = useTranslation();
  const [macro, setMacro] = useState<Macro | null>(null);
  const [deriv, setDeriv] = useState<Derivatives>([]);
  const [hist, setHist] = useState<GrsHist>([]);

  useEffect(() => {
    void trpc.market.macro.query().then(setMacro).catch(() => setMacro(null));
    void trpc.market.derivatives.query().then(setDeriv).catch(() => setDeriv([]));
    void trpc.market.grsHistory.query().then(setHist).catch(() => setHist([]));
  }, []);

  const grs = macro?.grs ?? null;
  const pct = (n: number | null | undefined, d = 2) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}`);

  return (
    <div>
      {/* GRS-Zentrum: Ring + Verlauf */}
      <Panel stagger={1} className="relative overflow-hidden">
        {macro === null ? (
          <Loading />
        ) : (
          <div className="flex flex-col items-center py-6">
            <div className="relative flex h-48 w-48 items-center justify-center">
              <svg viewBox="0 0 120 120" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden="true">
                <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(99,140,255,0.15)" strokeWidth="6" />
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
                <circle cx="60" cy="60" r="42" fill="none" stroke="rgba(139,92,246,0.25)" strokeWidth="1" strokeDasharray="2 4" />
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
              <p className="label mt-4">{t('oracle.updated')}: {new Date(macro.vix.ts).toLocaleDateString()}</p>
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
                    <tr key={d.symbol} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
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

        {/* DNA: On-Chain — ehrlich nicht verbunden */}
        <Panel label={t('oracle.dna')} stagger={5}>
          <NotConnected detail={t('oracle.dnaPlanned')} />
        </Panel>
      </section>

      <p className="mt-6 text-center text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('oracle.honest')}</p>
    </div>
  );
}
