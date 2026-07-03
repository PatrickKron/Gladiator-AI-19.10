import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, Loading, NotConnected, PageHeader, Panel } from '../components/ui.js';
import { AssetSelect, getSelectedAsset } from '../components/AssetSelect.js';
import { AssetContextBody, useAssetContext } from '../components/AssetContextPanel.js';

/**
 * Aegis / Hedging (09_ §3.8): GRS-Gauge braucht echte VIX/DXY/US10Y-Daten —
 * bis zur Anbindung ehrlich „nicht verbunden" (kein erfundener Score).
 * Echt heute: die Risk-Schutzschichten (SAFE, adaptive Gates, Kill-Switch).
 */

type Gate = Awaited<ReturnType<typeof trpc.risk.gates.query>>[number];
type Settings = Awaited<ReturnType<typeof trpc.settings.get.query>>;
type Macro = Awaited<ReturnType<typeof trpc.market.macro.query>>;
type Calendar = Awaited<ReturnType<typeof trpc.market.calendar.query>>;

const GRS_COLOR = (label: string) =>
  label === 'risk-off' ? 'var(--color-neg)' : label === 'risk-on' ? 'var(--color-pos)' : 'var(--color-warn)';

export function Aegis() {
  const { t } = useTranslation();
  const [asset, setAsset] = useState(getSelectedAsset());
  const assetCtx = useAssetContext(asset);
  const [gates, setGates] = useState<Gate[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [macro, setMacro] = useState<Macro | null>(null);
  const [calendar, setCalendar] = useState<Calendar | null>(null);

  useEffect(() => {
    void trpc.risk.gates.query().then(setGates).catch(() => setGates([]));
    void trpc.settings.get.query().then(setSettings).catch(() => setSettings(null));
    void trpc.market.macro.query().then(setMacro).catch(() => setMacro(null));
    void trpc.market.calendar.query({ days: 2 }).then(setCalendar).catch(() => setCalendar(null));
  }, []);

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
      <PageHeader title={t('aegis.title')} subtitle={t('aegis.subtitle')} right={<AssetSelect value={asset} onChange={setAsset} />} />

      {/* Asset-Risiko: Aegis bezieht sich auf GENAU dieses Asset */}
      <Panel label={t('assetCtx.title', { symbol: asset })} stagger={1} className="mb-5">
        <AssetContextBody ctx={assetCtx} />
      </Panel>

      <section className="grid gap-5 lg:grid-cols-2">
        {/* GRS-Gauge (Sentinel Eye) — ECHTER Score aus VIX/DXY/US10Y */}
        <Panel label={t('aegis.grsGauge')} stagger={1}>
          <div className="flex flex-col items-center py-5">
            <div className="relative flex h-40 w-40 items-center justify-center">
              <svg viewBox="0 0 120 120" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden="true">
                <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(99,140,255,0.18)" strokeWidth="6" />
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
                  <p className="num mt-0.5 text-[10px] tracking-widest uppercase" style={{ color: GRS_COLOR(grs.label) }}>
                    {grs.label}
                  </p>
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
                    DXY {grs.inputs.dxyChangePct20d >= 0 ? '+' : ''}
                    {grs.inputs.dxyChangePct20d.toFixed(2)} % (20d)
                  </span>
                  <span>{Math.round(grs.components.dxy.score)}</span>
                </li>
                <li className="flex justify-between">
                  <span style={{ color: 'var(--color-mut)' }}>
                    US10Y {grs.inputs.us10yChangeBp20d >= 0 ? '+' : ''}
                    {grs.inputs.us10yChangeBp20d.toFixed(0)} bp (20d)
                  </span>
                  <span>{Math.round(grs.components.us10y.score)}</span>
                </li>
              </ul>
              <p className="mt-3 text-[11px] leading-relaxed" style={{ color: 'var(--color-mut)' }}>
                {t('aegis.grsFormulaHint')}
              </p>
            </>
          ) : (
            <NotConnected detail={t('oracle.syncPending')} />
          )}
          {calendar?.noTrade && (
            <p className="mt-3 rounded-[0.625rem] border p-3 text-xs leading-relaxed" style={{ borderColor: 'rgba(255,92,108,0.45)', color: 'var(--color-neg)' }}>
              {t('aegis.noTradeActive', { reason: calendar.noTrade.reason })}
            </p>
          )}
        </Panel>

        {/* Schutzschichten — echt */}
        <Panel label={t('aegis.whatWorks')} stagger={2}>
          <ul className="mt-4 space-y-3">
            {shieldItems.map((item) => (
              <li key={item.key} className="flex items-start gap-3 rounded-[0.625rem] border p-3" style={{ borderColor: 'var(--color-line)' }}>
                <span
                  className={`neon-dot mt-1 ${item.on ? 'neon-dot--on' : 'neon-dot--off'}`}
                  style={item.key === 'aegis.killSwitch' && item.on ? { background: 'var(--color-neg)', boxShadow: '0 0 8px rgba(255,92,108,0.9)' } : undefined}
                />
                <span className="text-sm leading-relaxed">{t(item.key)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
            {t('aegis.shadowNote')}
          </p>
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
                <li key={g.id} className="rounded-[0.625rem] border p-4" style={{ borderColor: 'rgba(139,92,246,0.3)' }}>
                  <p className="text-sm font-medium">{g.reason}</p>
                  <p className="num label mt-2">
                    {t('aegis.evidence', {
                      trades: ev.trades,
                      expectancy: ev.expectancyR.toFixed(2),
                      winRate: (ev.winRate * 100).toFixed(0),
                    })}
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
