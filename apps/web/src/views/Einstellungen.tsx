import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader, Panel } from '../components/ui.js';

/**
 * Trading-Einstellungen (09_ §3.10): Werte greifen DIREKT in die Risk-Engine.
 * Plus: adaptive Gates einzeln (de)aktivieren (Mensch im Loop).
 */

type Settings = Awaited<ReturnType<typeof trpc.settings.get.query>>;
type Gate = Awaited<ReturnType<typeof trpc.risk.gates.query>>[number];

const FIELDS: { name: keyof Omit<Settings, 'killSwitchActive' | 'mode' | 'updatedAt'>; key: string; step: string }[] = [
  { name: 'riskPctPerTrade', key: 'settings.riskPctPerTrade', step: '0.1' },
  { name: 'maxLeverage', key: 'settings.maxLeverage', step: '1' },
  { name: 'maxOpenPositions', key: 'settings.maxOpenPositions', step: '1' },
  { name: 'maxExposurePctPerAsset', key: 'settings.maxExposurePctPerAsset', step: '1' },
  { name: 'dailyLossLimitPct', key: 'settings.dailyLossLimitPct', step: '0.5' },
  { name: 'weeklyLossLimitPct', key: 'settings.weeklyLossLimitPct', step: '0.5' },
  { name: 'maxDrawdownPct', key: 'settings.maxDrawdownPct', step: '1' },
];

export function Einstellungen() {
  const { t } = useTranslation();
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [mode, setMode] = useState<string>('paper');
  const [gates, setGates] = useState<Gate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const [s, g] = await Promise.all([trpc.settings.get.query(), trpc.risk.gates.query()]);
      setForm({
        riskPctPerTrade: String(s.riskPctPerTrade),
        maxLeverage: String(s.maxLeverage),
        maxOpenPositions: String(s.maxOpenPositions),
        maxExposurePctPerAsset: String(s.maxExposurePctPerAsset),
        dailyLossLimitPct: String(s.dailyLossLimitPct),
        weeklyLossLimitPct: String(s.weeklyLossLimitPct),
        maxDrawdownPct: String(s.maxDrawdownPct),
      });
      setMode(s.mode);
      setGates(g);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    if (!form) return;
    setSaving(true);
    setSaved(false);
    try {
      const numbers = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, Number(v.replace(',', '.'))]));
      if (Object.values(numbers).some((n) => !Number.isFinite(n))) {
        setError(t('settings.invalid'));
        return;
      }
      await trpc.settings.update.mutate({
        riskPctPerTrade: numbers.riskPctPerTrade!,
        maxLeverage: numbers.maxLeverage!,
        maxOpenPositions: Math.round(numbers.maxOpenPositions!),
        maxExposurePctPerAsset: numbers.maxExposurePctPerAsset!,
        dailyLossLimitPct: numbers.dailyLossLimitPct!,
        weeklyLossLimitPct: numbers.weeklyLossLimitPct!,
        maxDrawdownPct: numbers.maxDrawdownPct!,
      });
      setSaved(true);
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setSaving(false);
    }
  }

  async function toggleGate(gate: Gate) {
    try {
      await trpc.risk.toggleGate.mutate({ id: gate.id, active: !gate.isActive });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    }
  }

  return (
    <div>
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
      {error && <ErrorBox message={error} />}

      <Panel stagger={1}>
        {form === null ? (
          <Loading />
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {FIELDS.map((f) => (
                <label key={f.name} className="flex flex-col gap-1.5">
                  <span className="label">{t(f.key)}</span>
                  <input
                    type="number"
                    step={f.step}
                    value={form[f.name] ?? ''}
                    onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}
                    className="field num px-3 py-2 text-sm"
                  />
                </label>
              ))}
              <label className="flex flex-col gap-1.5">
                <span className="label">{t('settings.mode')}</span>
                <input value={`${mode.toUpperCase()} — ${t('settings.modePaperOnly')}`} disabled className="field px-3 py-2 text-sm opacity-60" />
              </label>
            </div>
            <div className="mt-6 flex items-center gap-4">
              <button onClick={() => void save()} disabled={saving} className="btn-primary px-5 py-2 text-sm disabled:opacity-50">
                {saving ? t('common.saving') : t('common.save')}
              </button>
              {saved && (
                <span className="text-sm" style={{ color: 'var(--color-pos)' }}>
                  ✓ {t('common.saved')}
                </span>
              )}
              <span className="text-xs" style={{ color: 'var(--color-mut)' }}>
                {t('settings.saveHint')}
              </span>
            </div>
          </>
        )}
      </Panel>

      <Panel label={t('settings.gatesTitle')} stagger={2} className="mt-5">
        {gates === null ? (
          <Loading />
        ) : gates.length === 0 ? (
          <Empty text={t('aegis.noGates')} />
        ) : (
          <ul className="mt-4 space-y-3">
            {gates.map((g) => {
              const ev = g.evidence as { trades: number; expectancyR: number; winRate: number };
              return (
                <li
                  key={g.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[0.625rem] border p-4"
                  style={{ borderColor: g.isActive ? 'rgba(139,92,246,0.35)' : 'var(--color-line)', opacity: g.isActive ? 1 : 0.6 }}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{g.reason}</p>
                    <p className="num label mt-1">
                      {t('aegis.evidence', {
                        trades: ev.trades,
                        expectancy: ev.expectancyR.toFixed(2),
                        winRate: (ev.winRate * 100).toFixed(0),
                      })}
                    </p>
                  </div>
                  <button
                    onClick={() => void toggleGate(g)}
                    className="shrink-0 rounded-[0.625rem] border px-3 py-1.5 text-xs transition-all"
                    style={
                      g.isActive
                        ? { borderColor: 'rgba(139,92,246,0.5)', color: 'var(--color-violet)' }
                        : { borderColor: 'var(--color-line)', color: 'var(--color-mut)' }
                    }
                  >
                    {g.isActive ? t('settings.gateActive') : t('settings.gateDisabled')}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
