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

type SecretStatus = Awaited<ReturnType<typeof trpc.secrets.list.query>>[number];

/**
 * API-Keys & Secrets (Phase 7+): Patrick pflegt Keys OHNE SSH — Vault-
 * verschlüsselt in der DB, maskierte Anzeige, echter Funktionstest je Key,
 * Neustart-Button für Boot-Time-Keys (Börsen-Venues).
 */
function SecretsPanel() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SecretStatus[] | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [restartArmed, setRestartArmed] = useState(false);
  const [restarting, setRestarting] = useState(false);

  async function load() {
    try {
      setStatus(await trpc.secrets.list.query());
    } catch {
      setStatus([]);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const msg = (key: string, ok: boolean, text: string) => setMessages((m) => ({ ...m, [key]: { ok, text } }));

  async function save(key: SecretStatus['key']) {
    const value = inputs[key]?.trim();
    if (!value) return;
    setBusy(key);
    try {
      const res = await trpc.secrets.set.mutate({ key, value });
      msg(key, true, res.immediate ? t('secrets.savedImmediate') : t('secrets.savedRestart'));
      setInputs((i) => ({ ...i, [key]: '' }));
      await load();
    } catch (err) {
      msg(key, false, err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(null);
    }
  }

  async function test(key: SecretStatus['key']) {
    setBusy(key);
    msg(key, true, t('secrets.testing'));
    try {
      const res = await trpc.secrets.test.mutate({ key });
      msg(key, res.ok, res.detail);
    } catch (err) {
      msg(key, false, err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(null);
    }
  }

  async function remove(key: SecretStatus['key']) {
    setBusy(key);
    try {
      await trpc.secrets.remove.mutate({ key });
      msg(key, true, t('secrets.deleted'));
      await load();
    } catch (err) {
      msg(key, false, err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(null);
    }
  }

  async function restart() {
    if (!restartArmed) {
      setRestartArmed(true);
      return;
    }
    setRestarting(true);
    try {
      await trpc.secrets.restartService.mutate();
    } catch {
      /* Verbindung reißt beim Exit ab — erwartet */
    }
    window.setTimeout(() => window.location.reload(), 15_000);
  }

  const needsRestart = (status ?? []).some((s) => !s.immediate && s.source === 'db');

  return (
    <Panel label={t('secrets.title')} stagger={3} className="mt-5">
      <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('secrets.subtitle')}
      </p>
      {status === null ? (
        <Loading />
      ) : (
        <ul className="mt-4 space-y-4">
          {status.map((s) => {
            const m = messages[s.key];
            return (
              <li key={s.key} className="rounded-[0.625rem] border p-4" style={{ borderColor: s.source ? 'rgba(79,209,255,0.3)' : 'var(--color-line)' }}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="num text-sm font-medium">{s.key}</p>
                  <span className="label flex items-center gap-2">
                    {s.source ? (
                      <>
                        <span className="num" style={{ color: 'var(--color-cyan)' }}>{s.masked}</span>
                        <span className="rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--color-line)' }}>
                          {s.source === 'db' ? t('secrets.sourceDb') : t('secrets.sourceEnv')}
                        </span>
                      </>
                    ) : (
                      <span>{t('secrets.notSet')}</span>
                    )}
                    <span
                      className="rounded border px-1.5 py-0.5"
                      style={s.immediate ? { borderColor: 'rgba(61,220,151,0.4)', color: 'var(--color-pos)' } : { borderColor: 'rgba(232,184,75,0.4)', color: 'var(--color-warn)' }}
                    >
                      {s.immediate ? t('secrets.immediate') : t('secrets.needsRestart')}
                    </span>
                  </span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
                  {t(`secrets.desc_${s.key}`)}
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <input
                    type="password"
                    autoComplete="off"
                    value={inputs[s.key] ?? ''}
                    onChange={(e) => setInputs((i) => ({ ...i, [s.key]: e.target.value }))}
                    placeholder={t('secrets.value')}
                    className="field num min-w-56 flex-1 px-3 py-1.5 text-xs"
                  />
                  <button
                    onClick={() => void save(s.key)}
                    disabled={busy !== null || !(inputs[s.key] ?? '').trim()}
                    className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
                  >
                    {t('secrets.save')}
                  </button>
                  {s.testable && s.source && (
                    <button
                      onClick={() => void test(s.key)}
                      disabled={busy !== null}
                      className="rounded-[0.625rem] border px-3 py-1.5 text-xs disabled:opacity-50"
                      style={{ borderColor: 'rgba(79,209,255,0.4)', color: 'var(--color-cyan)' }}
                    >
                      {busy === s.key ? t('secrets.testing') : t('secrets.test')}
                    </button>
                  )}
                  {s.source === 'db' && (
                    <button
                      onClick={() => void remove(s.key)}
                      disabled={busy !== null}
                      className="rounded-[0.625rem] border px-3 py-1.5 text-xs disabled:opacity-50"
                      style={{ borderColor: 'rgba(255,92,108,0.4)', color: 'var(--color-neg)' }}
                    >
                      {t('secrets.delete')}
                    </button>
                  )}
                </div>
                {m && (
                  <p className="mt-2 text-xs leading-relaxed" style={{ color: m.ok ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                    {m.text}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {(needsRestart || restartArmed) && (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            onClick={() => void restart()}
            disabled={restarting}
            className="rounded-[0.625rem] border px-4 py-2 text-sm disabled:opacity-50"
            style={{ borderColor: 'rgba(232,184,75,0.5)', color: 'var(--color-warn)' }}
          >
            {restarting ? t('secrets.restarting') : t('secrets.restartBtn')}
          </button>
          {restartArmed && !restarting && (
            <span className="text-xs" style={{ color: 'var(--color-warn)' }}>
              {t('secrets.restartConfirm')}
            </span>
          )}
        </div>
      )}
    </Panel>
  );
}

type TwelveStatus = Awaited<ReturnType<typeof trpc.market.twelveDataStatus.query>>;

/**
 * Aktien-/ETF-/Forex-Daten via Twelve Data (Feature 4): Symbol + Auflösungen
 * wählen, echte Kerzen in die DB laden. Ein Timeframe je Aufruf mit
 * clientseitigem Pacing (Free-Plan: 8 Calls/min). Nichts erfunden — bei
 * fehlendem Key oder API-Fehler ehrliche Meldung je Auflösung.
 */
function StockDataPanel() {
  const [status, setStatus] = useState<TwelveStatus | null>(null);
  const [symbol, setSymbol] = useState('AAPL');
  const [selTf, setSelTf] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ tf: string; ok: boolean; text: string }[]>([]);

  async function load() {
    try {
      setStatus(await trpc.market.twelveDataStatus.query());
    } catch {
      setStatus(null);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function ingest() {
    const tfs = selTf.length > 0 ? selTf : (status?.timeframes ?? []);
    const sym = symbol.trim().toUpperCase();
    if (!sym || tfs.length === 0) return;
    setBusy(true);
    setProgress([]);
    for (let i = 0; i < tfs.length; i++) {
      const tf = tfs[i]!;
      try {
        const res = await trpc.market.ingestStock.mutate({ symbol: sym, timeframe: tf });
        setProgress((p) => [...p, { tf, ok: true, text: `${res.inserted} neu · ${res.fetched} geladen · ${res.rejected} verworfen` }]);
      } catch (err) {
        setProgress((p) => [...p, { tf, ok: false, text: err instanceof Error ? err.message : 'Fehler' }]);
      }
      // Free-Plan: 8 Calls/min → ~7,5 s Abstand
      if (i < tfs.length - 1) await new Promise((r) => window.setTimeout(r, 7500));
    }
    setBusy(false);
    await load();
  }

  return (
    <Panel label="Aktien / ETF / Forex · Twelve Data" stagger={4} className="mt-5">
      <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        Echte Kerzen für Aktien, ETFs und Forex — alle verfügbaren Auflösungen. Voraussetzung: TWELVE_DATA_API_KEY oben eintragen
        (800 Calls/Tag gratis auf twelvedata.com). Ein Timeframe je Aufruf, ~7,5 s Abstand (8 Calls/min-Limit).
      </p>
      {status && !status.configured && (
        <p className="mt-3 text-xs" style={{ color: 'var(--color-warn)' }}>
          Noch kein Key gesetzt — trage TWELVE_DATA_API_KEY oben ein, dann hier laden.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="label">Symbol (z. B. AAPL, MSFT, EUR/USD)</span>
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} className="field num mt-1.5 w-48 px-3 py-2 text-sm" />
        </label>
      </div>

      <p className="label mt-4">Auflösungen (leer = alle)</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {(status?.timeframes ?? []).map((tf) => {
          const on = selTf.includes(tf);
          return (
            <button
              key={tf}
              onClick={() => setSelTf((prev) => (on ? prev.filter((x) => x !== tf) : [...prev, tf]))}
              className="num rounded border px-2.5 py-1 text-xs transition-colors"
              style={{
                borderColor: on ? 'rgba(79,209,255,0.5)' : 'var(--color-line)',
                color: on ? 'var(--color-cyan)' : 'var(--color-mut)',
                background: on ? 'rgba(79,209,255,0.08)' : 'transparent',
              }}
            >
              {tf}
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        <button
          onClick={() => void ingest()}
          disabled={busy || !status?.configured}
          className="btn-primary px-5 py-2.5 text-sm disabled:opacity-50"
        >
          {busy ? 'Lade Kerzen …' : `${symbol.trim().toUpperCase() || 'Symbol'} laden (${selTf.length > 0 ? selTf.length : (status?.timeframes.length ?? 0)} TF)`}
        </button>
      </div>

      {progress.length > 0 && (
        <ul className="num mt-4 space-y-1 text-xs">
          {progress.map((p, i) => (
            <li key={i} style={{ color: p.ok ? 'var(--color-pos)' : 'var(--color-neg)' }}>
              {p.tf}: {p.text}
            </li>
          ))}
        </ul>
      )}

      {status && status.symbols.length > 0 && (
        <div className="mt-5 overflow-x-auto">
          <p className="label">In der DB (venue=twelvedata)</p>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="label text-left">
                <th className="py-1 pr-3 font-normal">Symbol</th>
                <th className="py-1 pr-3 font-normal">TF</th>
                <th className="py-1 pr-3 text-right font-normal">Kerzen</th>
                <th className="py-1 pr-3 font-normal">Von</th>
                <th className="py-1 font-normal">Bis</th>
              </tr>
            </thead>
            <tbody className="num">
              {status.symbols.map((s, i) => (
                <tr key={i} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                  <td className="py-1 pr-3">{s.symbol}</td>
                  <td className="py-1 pr-3">{s.timeframe}</td>
                  <td className="py-1 pr-3 text-right">{s.candles}</td>
                  <td className="py-1 pr-3">{new Date(s.from_ts).toLocaleDateString('de-DE')}</td>
                  <td className="py-1">{new Date(s.to_ts).toLocaleDateString('de-DE')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

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

      <SecretsPanel />
      <StockDataPanel />
    </div>
  );
}
