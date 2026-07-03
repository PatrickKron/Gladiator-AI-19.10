import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, Loading, NotConnected, PageHeader, Panel } from '../components/ui.js';

/**
 * Aegis / Hedging (09_ §3.8): GRS-Gauge braucht echte VIX/DXY/US10Y-Daten —
 * bis zur Anbindung ehrlich „nicht verbunden" (kein erfundener Score).
 * Echt heute: die Risk-Schutzschichten (SAFE, adaptive Gates, Kill-Switch).
 */

type Gate = Awaited<ReturnType<typeof trpc.risk.gates.query>>[number];
type Settings = Awaited<ReturnType<typeof trpc.settings.get.query>>;

export function Aegis() {
  const { t } = useTranslation();
  const [gates, setGates] = useState<Gate[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    void trpc.risk.gates.query().then(setGates).catch(() => setGates([]));
    void trpc.settings.get.query().then(setSettings).catch(() => setSettings(null));
  }, []);

  const activeGates = (gates ?? []).filter((g) => g.isActive);

  const shieldItems = [
    { key: 'aegis.riskEngine', on: true },
    { key: 'aegis.safeSwitches', on: true },
    { key: 'aegis.adaptiveGates', on: activeGates.length > 0 },
    { key: 'aegis.killSwitch', on: settings?.killSwitchActive ?? false },
  ];

  return (
    <div>
      <PageHeader title={t('aegis.title')} subtitle={t('aegis.subtitle')} />

      <section className="grid gap-5 lg:grid-cols-2">
        {/* GRS-Gauge (Sentinel Eye) — ehrlich ohne Wert */}
        <Panel label={t('aegis.grsGauge')} stagger={1}>
          <div className="flex flex-col items-center py-5">
            <div className="relative flex h-40 w-40 items-center justify-center">
              <svg viewBox="0 0 120 120" className="absolute inset-0 h-full w-full" aria-hidden="true">
                <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(99,140,255,0.18)" strokeWidth="6" />
                <circle
                  cx="60"
                  cy="60"
                  r="52"
                  fill="none"
                  stroke="url(#aegisGrad)"
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeDasharray="70 260"
                  opacity="0.5"
                />
                <defs>
                  <linearGradient id="aegisGrad" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#2e7cf6" />
                    <stop offset="100%" stopColor="#8b5cf6" />
                  </linearGradient>
                </defs>
              </svg>
              <div className="text-center">
                <p className="num text-3xl font-semibold" style={{ color: 'var(--color-mut)' }}>
                  —
                </p>
                <p className="label mt-1">GRS</p>
              </div>
            </div>
          </div>
          <NotConnected detail={t('aegis.grsDisconnected')} />
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
