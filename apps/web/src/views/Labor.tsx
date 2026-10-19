import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { PageHeader } from '../components/ui.js';
import { BacktestChart } from '../components/BacktestChart.js';
import { loadLabConfig, saveLabConfig, type LabConfig } from '../lib/lab-config.js';
import { CHART_TFS, type ChartTf } from '../lib/chart-url.js';
import { COMPARE_COLORS, EquityChart, MetricCard, MultiEquityChart, fmt } from '../components/EquityChart.js';

/** Schnellstart-Vorlagen (P1.6) — ein Klick füllt die Konfiguration. */
const QUICK_TEMPLATES: { symbol: string; timeframe: ChartTf; setupType: 'scalp' | 'swing' | 'position'; riskPct: number }[] = [
  { symbol: 'BTC/USDT', timeframe: '1h', setupType: 'swing', riskPct: 1 },
  { symbol: 'ETH/USDT', timeframe: '15m', setupType: 'scalp', riskPct: 0.5 },
  { symbol: 'BTC/USDT', timeframe: '4h', setupType: 'position', riskPct: 1 },
];

/**
 * Strategie-Labor (09_ §3.5/§3.15): Backtests auf ECHTEN Kerzen, alles netto.
 * Equity-Kurve, Trade-Liste (inkl. MFE/MAE), RAPS-Gitter (13_), Walk-Forward,
 * Versionen speichern & Läufe vergleichen. Keine Zahl ist erfunden —
 * jede kommt aus der Engine über die eigene DB.
 */

type Metrics = {
  tradeCount: number;
  netPnl: number;
  winRate: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  maxDrawdownPct: number;
  netReturnPct: number;
  sharpe: number | null;
  sortino: number | null;
};
/** Sortierbare Trade-Spalten (Feature C). */
type TradeSortKey = 'r' | 'net' | 'mfe' | 'mae';

type RunResult = Awaited<ReturnType<typeof trpc.lab.runBacktest.mutate>>;
type WfResult = Awaited<ReturnType<typeof trpc.lab.runWalkForward.mutate>>;
type RunRow = Awaited<ReturnType<typeof trpc.lab.runs.query>>[number];
type VersionRow = Awaited<ReturnType<typeof trpc.lab.versions.query>>[number];
type GateRow = Awaited<ReturnType<typeof trpc.risk.gates.query>>[number];
type Bucket = { trades: number; netPnl: number; winRate: number; expectancyR: number };

function BucketTable({ title, rows }: { title: string; rows: [string, Bucket][] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <h3 className="label">{title}</h3>
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="label text-left">
            <th className="py-1 pr-3 font-normal">Bucket</th>
            <th className="py-1 pr-3 text-right font-normal">Trades</th>
            <th className="py-1 pr-3 text-right font-normal">WinRate</th>
            <th className="py-1 pr-3 text-right font-normal">Expectancy R</th>
            <th className="py-1 text-right font-normal">Netto $</th>
          </tr>
        </thead>
        <tbody className="num">
          {rows.map(([name, b]) => (
            <tr key={name} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
              <td className="py-1 pr-3">{name}</td>
              <td className="py-1 pr-3 text-right">{b.trades}</td>
              <td className="py-1 pr-3 text-right">{fmt(b.winRate * 100, 1)} %</td>
              <td className="py-1 pr-3 text-right" style={{ color: b.expectancyR >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                {fmt(b.expectancyR)}
              </td>
              <td className="py-1 text-right" style={{ color: b.netPnl >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>{fmt(b.netPnl)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Alle unterstützten Timeframes (Feature A). Der Backtest verlangt ≥250 echte
 *  Kerzen; fehlen sie (z. B. 1w/1M mit kurzer Historie), meldet das Backend das
 *  ehrlich als Fehler — es wird nichts geraten. */
const TIMEFRAMES = CHART_TFS;
const SETUPS = ['scalp', 'swing', 'position'] as const;

/** Vergleichslauf im Labor: geteilte ComparableRun-Felder + Kennzahlen fürs Gitter. */
type StrategyRun = {
  key: string;
  label: string;
  color: string;
  metrics: Metrics;
  equityCurve: { ts: string; equity: number }[];
};

export function Labor() {
  const { t } = useTranslation();
  const [symbol, setSymbol] = useState<string>('BTC/USDT');

  const [strategyId, setStrategyId] = useState<string>('builtin');
  const [dslStrategies, setDslStrategies] = useState<{ id: string; name: string; slug: string }[]>([]);
  const [universe, setUniverse] = useState<string[]>(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
  useEffect(() => {
    void trpc.strategies.list
      .query()
      .then((rows) => setDslStrategies(rows.filter((r) => r.kind === 'dsl').map((r) => ({ id: r.id, name: r.name, slug: r.slug }))))
      .catch(() => setDslStrategies([]));
    void trpc.market.scanUniverse.query().then(setUniverse).catch(() => undefined);
  }, []);
  const [timeframe, setTimeframe] = useState<(typeof TIMEFRAMES)[number]>('1h');
  const [setupType, setSetupType] = useState<(typeof SETUPS)[number]>('swing');
  const [from, setFrom] = useState('2024-06-01');
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [rsiLookbackBars, setRsiLookback] = useState(5);
  const [retestWindowBars, setRetestWindow] = useState(12);
  const [emaProximityPct, setEmaProximity] = useState(2);
  const [riskPct, setRiskPct] = useState(1);
  const [versionId, setVersionId] = useState<string>('');

  const [busy, setBusy] = useState<'bt' | 'wf' | 'save' | 'cal' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastConfig] = useState<LabConfig | null>(() => loadLabConfig());

  function applyConfig(c: { symbol: string; timeframe: string; setupType: string; riskPct: number }) {
    setStrategyId('builtin');
    setSymbol(c.symbol as typeof symbol);
    setTimeframe(c.timeframe as typeof timeframe);
    setSetupType(c.setupType as typeof setupType);
    setRiskPct(c.riskPct);
  }
  const [run, setRun] = useState<RunResult | null>(null);
  const [runWindow, setRunWindow] = useState<{ from: string; to: string } | null>(null);
  const [selectedTrade, setSelectedTrade] = useState<number | null>(null);
  // Trades-Tabelle sortierbar (Feature C) — Default null = chronologisch wie geliefert.
  const [tradeSort, setTradeSort] = useState<{ key: TradeSortKey; dir: 'asc' | 'desc' } | null>(null);
  const [wf, setWf] = useState<WfResult | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [gates, setGates] = useState<GateRow[]>([]);
  const [compare, setCompare] = useState<string[]>([]);
  const [compareSel, setCompareSel] = useState<string[]>(['builtin']);
  const [strategyRuns, setStrategyRuns] = useState<StrategyRun[]>([]);
  const [busyCompare, setBusyCompare] = useState(false);
  const [compareErr, setCompareErr] = useState<string | null>(null);

  async function refreshLists() {
    const [r, v, g] = await Promise.all([
      trpc.lab.runs.query({ limit: 25 }),
      trpc.lab.versions.query(),
      trpc.risk.gates.query(),
    ]);
    setRuns(r);
    setVersions(v);
    setGates(g);
  }
  useEffect(() => {
    void refreshLists().catch(() => {});
  }, []);

  const paramOverrides = { rsiLookbackBars, retestWindowBars, emaProximityPct };

  async function onRun() {
    setBusy('bt');
    setError(null);
    saveLabConfig({ symbol, timeframe, setupType, riskPct }); // „Letzte Konfiguration" merken
    try {
      const fromIso = new Date(from).toISOString();
      const toIso = new Date(`${to}T23:59:59Z`).toISOString();
      const res = await trpc.lab.runBacktest.mutate({
        strategyId: strategyId === 'builtin' ? undefined : strategyId,
        symbol,
        timeframe,
        setupType,
        from: fromIso,
        to: toIso,
        params: paramOverrides,
        versionId: versionId || undefined,
        riskPctPerTrade: riskPct,
      });
      setRun(res);
      setRunWindow({ from: fromIso, to: toIso });
      setSelectedTrade(res.trades.length > 0 ? res.trades.length - 1 : null);
      await refreshLists();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backtest fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  }

  async function onWalkForward() {
    setBusy('wf');
    setError(null);
    try {
      const grid = [3, 5, 8].flatMap((rsi) => [8, 12, 16].map((rw) => ({ rsiLookbackBars: rsi, retestWindowBars: rw })));
      const res = await trpc.lab.runWalkForward.mutate({
        symbol,
        timeframe,
        setupType,
        from: new Date(from).toISOString(),
        to: new Date(`${to}T23:59:59Z`).toISOString(),
        isBars: ['5m', '15m'].includes(timeframe) ? 4000 : ['30m', '1h'].includes(timeframe) ? 2000 : 800,
        oosBars: ['5m', '15m'].includes(timeframe) ? 1000 : ['30m', '1h'].includes(timeframe) ? 500 : 200,
        grid,
        riskPctPerTrade: riskPct,
      });
      setWf(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Walk-Forward fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  }

  async function onCalibrate() {
    setBusy('cal');
    setError(null);
    try {
      await trpc.lab.calibrateRisk.mutate({
        symbol,
        timeframe,
        setupType,
        from: new Date(from).toISOString(),
        to: new Date(`${to}T23:59:59Z`).toISOString(),
        params: paramOverrides,
      });
      await refreshLists();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kalibrierung fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Feature 3: mehrere Strategien über DASSELBE Fenster backtesten und
   * nebeneinander vergleichen. Builtin SMC nutzt Symbol/TF/Setup oben;
   * DSL-Strategien bringen ihr eigenes Symbol/TF mit (ehrlich beschriftet).
   * Läuft sequenziell, damit Fehler je Strategie sauber zugeordnet werden.
   */
  async function onCompareStrategies() {
    if (compareSel.length < 2) {
      setCompareErr('Mindestens zwei Strategien auswählen.');
      return;
    }
    setBusyCompare(true);
    setCompareErr(null);
    const fromIso = new Date(from).toISOString();
    const toIso = new Date(`${to}T23:59:59Z`).toISOString();
    const results: StrategyRun[] = [];
    const errors: string[] = [];
    for (let idx = 0; idx < compareSel.length; idx++) {
      const sel = compareSel[idx]!;
      const isBuiltin = sel === 'builtin';
      const dsl = dslStrategies.find((d) => d.id === sel);
      const label = isBuiltin ? `SMC Core · ${symbol} ${timeframe}` : `DSL: ${dsl?.slug ?? sel}`;
      try {
        const res = await trpc.lab.runBacktest.mutate({
          strategyId: isBuiltin ? undefined : sel,
          symbol,
          timeframe,
          setupType,
          from: fromIso,
          to: toIso,
          params: paramOverrides,
          riskPctPerTrade: riskPct,
        });
        results.push({
          key: sel,
          label,
          color: COMPARE_COLORS[idx % COMPARE_COLORS.length]!,
          metrics: res.metrics as Metrics,
          equityCurve: res.equityCurve,
        });
      } catch (err) {
        errors.push(`${label}: ${err instanceof Error ? err.message : 'Fehler'}`);
      }
    }
    setStrategyRuns(results);
    if (errors.length > 0) setCompareErr(errors.join(' · '));
    setBusyCompare(false);
    await refreshLists();
  }

  async function onToggleGate(id: string, active: boolean) {
    await trpc.risk.toggleGate.mutate({ id, active });
    await refreshLists();
  }

  async function onSaveVersion() {
    setBusy('save');
    setError(null);
    try {
      await trpc.lab.saveVersion.mutate({ params: paramOverrides });
      await refreshLists();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  }

  const m = run?.metrics as Metrics | undefined;
  const compareRows = runs.filter((r) => compare.includes(r.id));

  // ── Feature C: Trades sortierbar (Klick auf Header). Der Original-Index `i`
  // bleibt erhalten (für Chart-Fokus + Zeilennummer); null = chronologisch.
  function toggleTradeSort(key: TradeSortKey) {
    setTradeSort((prev) => (prev?.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));
  }
  const sortArrow = (key: TradeSortKey) => (tradeSort?.key === key ? (tradeSort.dir === 'asc' ? ' ▲' : ' ▼') : '');
  const tradeRows = useMemo(() => {
    const base = (run?.trades ?? []).map((t, i) => ({ t, i }));
    if (!tradeSort) return base;
    const pick = (x: (typeof base)[number]) =>
      tradeSort.key === 'r' ? x.t.rMultiple : tradeSort.key === 'net' ? x.t.netPnl : tradeSort.key === 'mfe' ? x.t.mfeR : x.t.maeR;
    const sign = tradeSort.dir === 'asc' ? 1 : -1;
    return [...base].sort((a, b) => (pick(a) - pick(b)) * sign);
  }, [run?.trades, tradeSort]);

  /**
   * Feature D: Backtest-Trades als CSV herunterladen — rein client-seitig
   * (Blob + anchor.click), keine Server-Runde. Metriken stehen als
   * Kommentarzeilen (`#`) oben; Zahlen mit Punkt-Dezimal (maschinenlesbar).
   * Exportiert wird die aktuell angezeigte (ggf. sortierte) Reihenfolge.
   */
  function exportTradesCsv() {
    if (!run || !m) return;
    const parts = run.raps.clusterKey.split('|');
    const csvSymbol = parts[1] ?? symbol;
    const csvTf = parts[3] ?? timeframe;
    const esc = (v: string | number): string => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const pct = (x: number | null) => (x === null ? '' : (x * 100).toFixed(2));
    const comments = [
      `# Gladiator AI · Backtest-Export`,
      `# Symbol: ${csvSymbol} · Timeframe: ${csvTf} · Zeitraum: ${from} bis ${to}`,
      `# Netto-PnL $: ${m.netPnl} · Netto-Return %: ${m.netReturnPct} · Max-Drawdown %: ${m.maxDrawdownPct}`,
      `# WinRate %: ${pct(m.winRate)} · Profit-Factor: ${m.profitFactor ?? ''} · Expectancy R: ${m.expectancy ?? ''}`,
      `# Sharpe: ${m.sharpe ?? ''} · Sortino: ${m.sortino ?? ''} · Trades: ${m.tradeCount}`,
    ];
    const header = ['#', 'Entry-Zeit', 'Direction', 'Symbol', 'TF', 'R', 'Netto $', 'MFE R', 'MAE R', 'Kosten $', 'Exit-Zeit'];
    const lines = tradeRows.map(({ t, i }) =>
      [
        i + 1,
        new Date(t.entryTs).toISOString(),
        t.direction,
        csvSymbol,
        csvTf,
        t.rMultiple,
        t.netPnl,
        t.mfeR,
        t.maeR,
        Math.round((t.fees + t.funding) * 100) / 100,
        new Date(t.exitTs).toISOString(),
      ]
        .map(esc)
        .join(','),
    );
    const csv = [...comments, header.map(esc).join(','), ...lines].join('\n');
    // UTF-8-BOM voran, damit Excel Umlaute/Sonderzeichen korrekt erkennt.
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backtest_${csvSymbol.replace('/', '-')}_${csvTf}_${from}_${to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <PageHeader title={t('ia.page_lab')} subtitle={t('ia.desc_lab')} />

      {/* ── Lauf-Konfiguration ── */}
      <section className="glass reveal p-6" style={{ '--stagger': 1 } as React.CSSProperties}>
        <h2 className="label">Backtest · netto nach Gebühren/Slippage/Funding</h2>

        {/* Schnellstart-Vorlagen (P1.6): ein Klick füllt die Konfiguration */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="label">{t('lab.quickStart')}:</span>
          {QUICK_TEMPLATES.map((tpl, i) => (
            <button
              key={i}
              onClick={() => applyConfig(tpl)}
              className="num rounded-[0.625rem] border px-3 py-1.5 text-xs"
              style={{ borderColor: 'rgba(139,92,246,0.4)', color: 'var(--color-violet)' }}
            >
              {tpl.setupType} · {tpl.symbol} · {tpl.timeframe}
            </button>
          ))}
          {lastConfig && (
            <button
              onClick={() => applyConfig(lastConfig)}
              className="rounded-[0.625rem] border px-3 py-1.5 text-xs"
              style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
            >
              ↻ {t('lab.lastConfig')}
            </button>
          )}
        </div>
        {strategyId !== 'builtin' && (
          <p className="mt-2 text-xs" style={{ color: 'var(--color-violet)' }}>{t('lab.dslNote')}</p>
        )}
        <div className="mt-4 grid gap-4 md:grid-cols-4">
          <label className="text-sm">
            <span className="label">{t('lab.strategyLabel')}</span>
            <select value={strategyId} onChange={(e) => setStrategyId(e.target.value)} className="field mt-1.5 w-full px-3 py-2">
              <option value="builtin">{t('lab.builtinSmc')}</option>
              {dslStrategies.map((d) => (
                <option key={d.id} value={d.id}>DSL: {d.slug}</option>
              ))}
            </select>
          </label>
          <label className="text-sm" style={{ opacity: strategyId === 'builtin' ? 1 : 0.5 }}>
            <span className="label">Symbol</span>
            <select disabled={strategyId !== 'builtin'} value={symbol} onChange={(e) => setSymbol(e.target.value as typeof symbol)} className="field mt-1.5 w-full px-3 py-2">
              {universe.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="text-sm" style={{ opacity: strategyId === 'builtin' ? 1 : 0.5 }}>
            <span className="label">Timeframe</span>
            <select disabled={strategyId !== 'builtin'} value={timeframe} onChange={(e) => setTimeframe(e.target.value as typeof timeframe)} className="field mt-1.5 w-full px-3 py-2">
              {TIMEFRAMES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="text-sm" style={{ opacity: strategyId === 'builtin' ? 1 : 0.5 }}>
            <span className="label">Setup</span>
            <select disabled={strategyId !== 'builtin'} value={setupType} onChange={(e) => setSetupType(e.target.value as typeof setupType)} className="field mt-1.5 w-full px-3 py-2">
              {SETUPS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="label">Risiko %/Trade</span>
            <input type="number" min={0.1} max={5} step={0.1} value={riskPct} onChange={(e) => setRiskPct(Number(e.target.value))} className="field num mt-1.5 w-full px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="label">Von</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="field num mt-1.5 w-full px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="label">Bis</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="field num mt-1.5 w-full px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="label">Gespeicherte Version</span>
            <select value={versionId} onChange={(e) => setVersionId(e.target.value)} className="field mt-1.5 w-full px-3 py-2">
              <option value="">v1 (Standard) + Overrides</option>
              {versions.map((v) => <option key={v.id} value={v.id}>v{v.version} · {v.status}</option>)}
            </select>
          </label>
        </div>

        <h3 className="label mt-6">Parameter-Experiment (Overrides)</h3>
        <div className="mt-3 grid gap-4 md:grid-cols-3">
          <label className="text-sm">
            <span className="label">RSI-Lookback (Bars)</span>
            <input type="number" min={1} max={20} value={rsiLookbackBars} onChange={(e) => setRsiLookback(Number(e.target.value))} className="field num mt-1.5 w-full px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="label">Retest-Fenster (Bars)</span>
            <input type="number" min={2} max={60} value={retestWindowBars} onChange={(e) => setRetestWindow(Number(e.target.value))} className="field num mt-1.5 w-full px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="label">EMA-Nähe (%)</span>
            <input type="number" min={0.1} max={10} step={0.1} value={emaProximityPct} onChange={(e) => setEmaProximity(Number(e.target.value))} className="field num mt-1.5 w-full px-3 py-2" />
          </label>
        </div>

        {error && <p className="mt-4 text-sm" style={{ color: 'var(--color-neg)' }}>{error}</p>}

        <div className="mt-5 flex flex-wrap gap-3">
          <button onClick={() => void onRun()} disabled={busy !== null} className="btn-primary px-5 py-2.5 text-sm">
            {busy === 'bt' ? 'Backtest läuft …' : 'Backtest starten'}
          </button>
          <button onClick={() => void onWalkForward()} disabled={busy !== null} className="btn-primary px-5 py-2.5 text-sm">
            {busy === 'wf' ? 'Walk-Forward läuft …' : 'Walk-Forward (Grid 9)'}
          </button>
          <button onClick={() => void onCalibrate()} disabled={busy !== null} className="btn-primary px-5 py-2.5 text-sm">
            {busy === 'cal' ? 'Kalibriere …' : 'Risk-Engine kalibrieren'}
          </button>
          <button
            onClick={() => void onSaveVersion()}
            disabled={busy !== null}
            className="rounded-[0.625rem] border px-5 py-2.5 text-sm"
            style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
          >
            {busy === 'save' ? 'Speichere …' : 'Als neue Version speichern'}
          </button>
        </div>
      </section>

      {/* ── Backtest-Ergebnis ── */}
      {run && m && (
        <>
          <section className="mt-6 grid gap-3 md:grid-cols-3 xl:grid-cols-5">
            <MetricCard label="Netto-PnL" value={`${fmt(m.netPnl)} $`} tone={m.netPnl >= 0 ? 'pos' : 'neg'} />
            <MetricCard label="Netto-Return" value={`${fmt(m.netReturnPct)} %`} tone={m.netReturnPct >= 0 ? 'pos' : 'neg'} />
            <MetricCard label="Max-Drawdown" value={`${fmt(m.maxDrawdownPct)} %`} tone="neg" />
            <MetricCard label="Sharpe" value={fmt(m.sharpe)} />
            <MetricCard label="Sortino" value={fmt(m.sortino)} />
            <MetricCard label="WinRate" value={m.winRate === null ? '—' : `${fmt(m.winRate * 100, 1)} %`} />
            <MetricCard label="Profit-Factor" value={fmt(m.profitFactor)} />
            <MetricCard label="Erwartungswert" value={m.expectancy === null ? '—' : `${fmt(m.expectancy)} R`} />
            <MetricCard label="Trades" value={String(m.tradeCount)} />
            <MetricCard label="Kerzen" value={fmt(run.candles, 0)} />
          </section>

          <section className="glass mt-6 p-6">
            <h2 className="label">Equity-Kurve · Start 10.000 $ · netto</h2>
            <div className="mt-4"><EquityChart points={run.equityCurve} emptyText="Zu wenig Punkte." /></div>
          </section>

          {runWindow && run.trades.length > 0 && (() => {
            // Symbol/Timeframe aus dem RAPS-clusterKey (`slug|symbol|setup|tf|all|all`) —
            // robust für builtin SMC und DSL-Strategien gleichermaßen.
            const parts = run.raps.clusterKey.split('|');
            const chartSymbol = parts[1] ?? symbol;
            const chartTf = parts[3] ?? timeframe;
            return (
              <section className="glass mt-6 p-6">
                <h2 className="label">Visuelles Backtesting · {chartSymbol} · {chartTf} · Entry/Exit + SL/TP im Chart</h2>
                <div className="mt-4">
                  <BacktestChart
                    symbol={chartSymbol}
                    timeframe={chartTf}
                    from={runWindow.from}
                    to={runWindow.to}
                    trades={run.trades}
                    selected={selectedTrade}
                    onSelect={setSelectedTrade}
                  />
                </div>
              </section>
            );
          })()}

          <section className="glass mt-6 p-6">
            <h2 className="label">RAPS-Gitter (Hebel × TP-Schema, 13_) · {run.raps.explanation}</h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-center text-sm">
                <thead>
                  <tr className="label">
                    <th className="py-1.5 text-left font-normal">Hebel</th>
                    {['A 50/30/20', 'B 60/30/10', 'C 100 % TP1', 'D Runner'].map((h) => <th key={h} className="py-1.5 font-normal">{h}</th>)}
                  </tr>
                </thead>
                <tbody className="num">
                  {[1, 2, 3, 5, 7, 10].map((lev) => (
                    <tr key={lev} style={{ borderTop: '1px solid rgba(99,140,255,0.1)' }}>
                      <td className="py-1.5 text-left">{lev}×</td>
                      {(['A', 'B', 'C', 'D'] as const).map((s) => {
                        const cell = run.raps.grid.find((g) => g.leverage === lev && g.tpSchema === s);
                        const isBest = run.raps.best && cell && run.raps.best.leverage === lev && run.raps.best.tpSchema === s;
                        return (
                          <td
                            key={s}
                            className="py-1.5"
                            style={{
                              color: cell?.excluded ? 'var(--color-neg)' : isBest ? 'var(--color-pos)' : 'var(--color-ink)',
                              opacity: cell?.excluded ? 0.5 : 1,
                              textShadow: isBest ? '0 0 12px rgba(61,220,151,0.6)' : 'none',
                            }}
                            title={cell?.excluded ? `Liquidations-Quote ${(cell.liquidationRate * 100).toFixed(1)} %` : ''}
                          >
                            {cell ? fmt(cell.rapsScore, 3) : '—'}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="glass mt-6 p-6">
            <h2 className="label">Rundum-Analyse · Session / EMA200-Regime / Marktphase / Confluence</h2>
            <div className="mt-4 grid gap-6 lg:grid-cols-2">
              <BucketTable title="Nach Session (Asia · London · Overlap · NY · Off)" rows={Object.entries(run.analysis.bySession)} />
              <BucketTable
                title="Richtung × EMA200-Regime (z. B. Longs unter EMA200)"
                rows={Object.entries(run.analysis.byDirectionRegime).map(([k, v]) => [
                  k.replace('|above', ' · über EMA200').replace('|below', ' · unter EMA200'),
                  v,
                ])}
              />
              <BucketTable
                title="Nach Marktphase (Struktur bull/bear)"
                rows={Object.entries(run.analysis.byPhase).filter((e): e is [string, Bucket] => e[1] !== undefined)}
              />
              <div>
                <h3 className="label">Confluence-Faktoren einzeln (Δ Expectancy mit vs. ohne)</h3>
                <table className="mt-2 w-full text-sm">
                  <thead>
                    <tr className="label text-left">
                      <th className="py-1 pr-3 font-normal">Faktor</th>
                      <th className="py-1 pr-3 text-right font-normal">mit (n)</th>
                      <th className="py-1 pr-3 text-right font-normal">mit R</th>
                      <th className="py-1 pr-3 text-right font-normal">ohne R</th>
                      <th className="py-1 text-right font-normal">Δ R</th>
                    </tr>
                  </thead>
                  <tbody className="num">
                    {Object.entries(run.analysis.byConfluence).map(([tag, c]) => (
                      <tr key={tag} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                        <td className="py-1 pr-3">{tag}</td>
                        <td className="py-1 pr-3 text-right">{c.withTrades}</td>
                        <td className="py-1 pr-3 text-right">{fmt(c.withExpectancyR)}</td>
                        <td className="py-1 pr-3 text-right">{c.withoutTrades > 0 ? fmt(c.withoutExpectancyR) : '—'}</td>
                        <td className="py-1 text-right" style={{ color: c.deltaR >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>{fmt(c.deltaR)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {run.turningPoints.length > 0 && (
              <div className="mt-6">
                <h3 className="label">Letzte Trendwenden (CHoCH) & Fortsetzungen (BOS) im Zeitraum</h3>
                <div className="mt-2 flex flex-wrap gap-2">
                  {run.turningPoints.map((tp, i) => (
                    <span
                      key={i}
                      className="num rounded border px-2 py-1 text-xs"
                      style={{
                        borderColor: 'var(--color-line)',
                        color: tp.direction === 'bullish' ? 'var(--color-pos)' : 'var(--color-neg)',
                      }}
                    >
                      {tp.kind} {tp.direction === 'bullish' ? '▲' : '▼'} {new Date(tp.ts).toLocaleDateString('de-DE')}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="glass mt-6 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="label">Trades ({run.trades.length}) · inkl. MFE/MAE in R · Zeile anklicken → im Chart fokussieren</h2>
              <button
                onClick={exportTradesCsv}
                disabled={run.trades.length === 0}
                className="rounded-[0.625rem] border px-3 py-1.5 text-xs disabled:opacity-40"
                style={{ borderColor: 'var(--color-line)', color: 'var(--color-cyan)' }}
              >
                ↓ {t('lab.exportCsv')}
              </button>
            </div>
            <div className="mt-4 max-h-96 overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="label text-left">
                    <th className="py-1.5 pr-3 font-normal">#</th>
                    <th className="py-1.5 pr-3 font-normal">Entry</th>
                    <th className="py-1.5 pr-3 font-normal">Richtung</th>
                    {(
                      [
                        ['r', 'R'],
                        ['net', 'Netto $'],
                        ['mfe', 'MFE R'],
                        ['mae', 'MAE R'],
                      ] as [TradeSortKey, string][]
                    ).map(([key, lbl]) => (
                      <th
                        key={key}
                        onClick={() => toggleTradeSort(key)}
                        title={t('lab.sortHint')}
                        className="cursor-pointer select-none py-1.5 pr-3 text-right font-normal"
                        style={{ color: tradeSort?.key === key ? 'var(--color-cyan)' : undefined }}
                      >
                        {lbl}
                        {sortArrow(key)}
                      </th>
                    ))}
                    <th className="py-1.5 pr-3 text-right font-normal">Kosten $</th>
                    <th className="py-1.5 font-normal">Exit</th>
                  </tr>
                </thead>
                <tbody className="num">
                  {tradeRows.map(({ t, i }) => (
                    <tr
                      key={i}
                      onClick={() => setSelectedTrade(i === selectedTrade ? null : i)}
                      className="cursor-pointer"
                      style={{
                        borderTop: '1px solid rgba(99,140,255,0.08)',
                        background: i === selectedTrade ? 'rgba(79,209,255,0.1)' : 'transparent',
                      }}
                    >
                      <td className="py-1.5 pr-3" style={{ color: 'var(--color-mut)' }}>{i + 1}</td>
                      <td className="py-1.5 pr-3">{new Date(t.entryTs).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</td>
                      <td className="py-1.5 pr-3" style={{ color: t.direction === 'long' ? 'var(--color-pos)' : 'var(--color-neg)' }}>{t.direction}</td>
                      <td className="py-1.5 pr-3 text-right" style={{ color: t.rMultiple >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>{fmt(t.rMultiple)}</td>
                      <td className="py-1.5 pr-3 text-right">{fmt(t.netPnl)}</td>
                      <td className="py-1.5 pr-3 text-right">{fmt(t.mfeR)}</td>
                      <td className="py-1.5 pr-3 text-right">{fmt(t.maeR)}</td>
                      <td className="py-1.5 pr-3 text-right">{fmt(t.fees + t.funding)}</td>
                      <td className="py-1.5">{t.exitReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {/* ── Walk-Forward ── */}
      {wf && (
        <section className="glass mt-6 p-6">
          <h2 className="label">
            Walk-Forward · OOS kombiniert: {fmt(wf.combinedOos.netPnl)} $ netto · {wf.combinedOos.tradeCount} Trades ·
            Expectancy {fmt(wf.combinedOos.expectancy)} R
          </h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="label text-left">
                  <th className="py-1.5 pr-3 font-normal">Fenster</th>
                  <th className="py-1.5 pr-3 font-normal">Beste Parameter (IS)</th>
                  <th className="py-1.5 pr-3 text-right font-normal">IS-PnL</th>
                  <th className="py-1.5 pr-3 text-right font-normal">OOS-PnL</th>
                  <th className="py-1.5 text-right font-normal">OOS-Trades</th>
                </tr>
              </thead>
              <tbody className="num">
                {wf.windows.map((w, i) => (
                  <tr key={i} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                    <td className="py-1.5 pr-3">#{i + 1} · Bars {w.oosStart}–{w.oosEnd}</td>
                    <td className="py-1.5 pr-3">{JSON.stringify(w.bestParams)}</td>
                    <td className="py-1.5 pr-3 text-right">{fmt(w.isNetPnl)}</td>
                    <td className="py-1.5 pr-3 text-right" style={{ color: w.oosNetPnl >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>{fmt(w.oosNetPnl)}</td>
                    <td className="py-1.5 text-right">{w.oosTrades}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs" style={{ color: 'var(--color-mut)' }}>
            In-Sample wird optimiert, Out-of-Sample nur validiert — eine Strategie zählt nur, wenn sie auf UNGESEHENEN Daten netto besteht (08_ §4).
          </p>
        </section>
      )}

      {/* ── Multi-Strategie-Vergleich (Feature 3) ── */}
      <section className="glass mt-6 p-6">
        <h2 className="label">Multi-Strategie-Vergleich · gleiche Periode ({from} – {to}) · netto</h2>
        <p className="mt-2 text-xs" style={{ color: 'var(--color-mut)' }}>
          Strategien auswählen und über dasselbe Zeitfenster gegeneinander backtesten. Builtin SMC nutzt Symbol/Timeframe/Setup oben;
          DSL-Strategien bringen ihr eigenes Symbol/Timeframe mit.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {[{ id: 'builtin', slug: `SMC Core (${symbol} ${timeframe})` }, ...dslStrategies.map((d) => ({ id: d.id, slug: `DSL: ${d.slug}` }))].map((s) => {
            const on = compareSel.includes(s.id);
            return (
              <button
                key={s.id}
                onClick={() => setCompareSel((prev) => (on ? prev.filter((x) => x !== s.id) : [...prev, s.id]))}
                className="rounded border px-3 py-1.5 text-xs transition-colors"
                style={{
                  borderColor: on ? 'rgba(79,209,255,0.5)' : 'var(--color-line)',
                  color: on ? 'var(--color-cyan)' : 'var(--color-mut)',
                  background: on ? 'rgba(79,209,255,0.08)' : 'transparent',
                }}
              >
                {on ? '✓ ' : ''}{s.slug}
              </button>
            );
          })}
        </div>
        <div className="mt-4">
          <button onClick={() => void onCompareStrategies()} disabled={busyCompare || compareSel.length < 2} className="btn-primary px-5 py-2.5 text-sm disabled:opacity-50">
            {busyCompare ? 'Vergleiche …' : `${compareSel.length} Strategien vergleichen`}
          </button>
        </div>
        {compareErr && <p className="mt-3 text-sm" style={{ color: 'var(--color-neg)' }}>{compareErr}</p>}

        {strategyRuns.length > 0 && (
          <>
            <div className="mt-6 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="label text-left">
                    <th className="py-1.5 pr-3 font-normal">Strategie</th>
                    <th className="py-1.5 pr-3 text-right font-normal">Netto-PnL $</th>
                    <th className="py-1.5 pr-3 text-right font-normal">Return %</th>
                    <th className="py-1.5 pr-3 text-right font-normal">Max-DD %</th>
                    <th className="py-1.5 pr-3 text-right font-normal">Sharpe</th>
                    <th className="py-1.5 pr-3 text-right font-normal">Sortino</th>
                    <th className="py-1.5 pr-3 text-right font-normal">WinRate</th>
                    <th className="py-1.5 pr-3 text-right font-normal">PF</th>
                    <th className="py-1.5 pr-3 text-right font-normal">Expectancy R</th>
                    <th className="py-1.5 text-right font-normal">Trades</th>
                  </tr>
                </thead>
                <tbody className="num">
                  {strategyRuns.map((r) => (
                    <tr key={r.key} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                      <td className="py-1.5 pr-3">
                        <span className="inline-block h-2 w-3 rounded" style={{ background: r.color, marginRight: 6 }} />
                        {r.label}
                      </td>
                      <td className="py-1.5 pr-3 text-right" style={{ color: r.metrics.netPnl >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>{fmt(r.metrics.netPnl)}</td>
                      <td className="py-1.5 pr-3 text-right" style={{ color: r.metrics.netReturnPct >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>{fmt(r.metrics.netReturnPct)}</td>
                      <td className="py-1.5 pr-3 text-right">{fmt(r.metrics.maxDrawdownPct)}</td>
                      <td className="py-1.5 pr-3 text-right">{fmt(r.metrics.sharpe)}</td>
                      <td className="py-1.5 pr-3 text-right">{fmt(r.metrics.sortino)}</td>
                      <td className="py-1.5 pr-3 text-right">{r.metrics.winRate === null ? '—' : `${fmt(r.metrics.winRate * 100, 1)} %`}</td>
                      <td className="py-1.5 pr-3 text-right">{fmt(r.metrics.profitFactor)}</td>
                      <td className="py-1.5 pr-3 text-right">{r.metrics.expectancy === null ? '—' : fmt(r.metrics.expectancy)}</td>
                      <td className="py-1.5 text-right">{r.metrics.tradeCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-6">
              <h3 className="label">Equity-Overlay · %-Return ab Start · netto</h3>
              <div className="mt-3"><MultiEquityChart runs={strategyRuns} emptyText="Zu wenig Punkte." /></div>
            </div>
          </>
        )}
      </section>

      {/* ── Adaptive Risk-Gates (Selbst-Kalibrierung) ── */}
      <section className="glass mt-6 p-6">
        <h2 className="label">Adaptive Risk-Gates · nur verschärfend · jedes Gate abschaltbar (Mensch im Loop)</h2>
        {gates.length === 0 ? (
          <p className="mt-3 text-sm" style={{ color: 'var(--color-mut)' }}>
            Noch keine Gates. „Risk-Engine kalibrieren" leitet aus dem gewählten Zeitraum evidenzbasierte
            Sperren ab (z. B. „keine Longs unter EMA200") — nur wenn ≥ 30 Trades sie belegen.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {gates.map((g) => (
              <li key={g.id} className="flex items-start justify-between gap-4 rounded-xl border p-3" style={{ borderColor: 'var(--color-line)', opacity: g.isActive ? 1 : 0.5 }}>
                <div>
                  <p className="text-sm">{g.reason}</p>
                  <p className="label mt-1">
                    Scope: {g.symbol ?? 'alle'} · {g.timeframe ?? 'alle TF'} · Quelle: {g.source} ·{' '}
                    {new Date(g.createdAt as unknown as string).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}
                  </p>
                </div>
                <button
                  onClick={() => void onToggleGate(g.id, !g.isActive)}
                  className="shrink-0 rounded border px-3 py-1.5 text-xs"
                  style={{
                    borderColor: g.isActive ? 'rgba(61,220,151,0.4)' : 'var(--color-line)',
                    color: g.isActive ? 'var(--color-pos)' : 'var(--color-mut)',
                  }}
                >
                  {g.isActive ? 'aktiv — klick zum Deaktivieren' : 'inaktiv — klick zum Aktivieren'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Lauf-Verlauf + Vergleich ── */}
      <section className="glass mt-6 p-6">
        <h2 className="label">Lauf-Verlauf · zum Vergleich zwei Läufe anhaken</h2>
        {runs.length === 0 ? (
          <p className="mt-3 text-sm" style={{ color: 'var(--color-mut)' }}>Noch keine Läufe.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="label text-left">
                  <th className="py-1.5 pr-3 font-normal"></th>
                  <th className="py-1.5 pr-3 font-normal">Zeit</th>
                  <th className="py-1.5 pr-3 font-normal">Lauf</th>
                  <th className="py-1.5 pr-3 text-right font-normal">Return %</th>
                  <th className="py-1.5 pr-3 text-right font-normal">MaxDD %</th>
                  <th className="py-1.5 pr-3 text-right font-normal">PF</th>
                  <th className="py-1.5 text-right font-normal">Trades</th>
                </tr>
              </thead>
              <tbody className="num">
                {runs.map((r) => (
                  <tr key={r.id} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                    <td className="py-1.5 pr-3">
                      <input
                        type="checkbox"
                        checked={compare.includes(r.id)}
                        onChange={(e) =>
                          setCompare((prev) => (e.target.checked ? [...prev.slice(-1), r.id] : prev.filter((x) => x !== r.id)))
                        }
                      />
                    </td>
                    <td className="py-1.5 pr-3">{new Date(r.createdAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</td>
                    <td className="py-1.5 pr-3">v{r.version} · {r.symbol} {r.timeframe} · {(r.config as { setupType?: string })?.setupType}</td>
                    <td className="py-1.5 pr-3 text-right" style={{ color: Number(r.netReturn) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>{fmt(Number(r.netReturn))}</td>
                    <td className="py-1.5 pr-3 text-right">{fmt(Number(r.maxDrawdown))}</td>
                    <td className="py-1.5 pr-3 text-right">{r.profitFactor === null ? '—' : fmt(Number(r.profitFactor))}</td>
                    <td className="py-1.5 text-right">{fmt(Number(r.tradeCount), 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {compareRows.length === 2 && (
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            {compareRows.map((r) => (
              <div key={r.id} className="rounded-xl border p-4" style={{ borderColor: 'var(--color-line)' }}>
                <p className="label">v{r.version} · {r.symbol} {r.timeframe} · {new Date(r.createdAt).toLocaleDateString('de-DE')}</p>
                <ul className="num mt-3 space-y-1.5 text-sm">
                  <li className="flex justify-between"><span style={{ color: 'var(--color-mut)' }}>Netto-Return</span><span>{fmt(Number(r.netReturn))} %</span></li>
                  <li className="flex justify-between"><span style={{ color: 'var(--color-mut)' }}>Max-Drawdown</span><span>{fmt(Number(r.maxDrawdown))} %</span></li>
                  <li className="flex justify-between"><span style={{ color: 'var(--color-mut)' }}>Sharpe</span><span>{r.sharpe === null ? '—' : fmt(Number(r.sharpe))}</span></li>
                  <li className="flex justify-between"><span style={{ color: 'var(--color-mut)' }}>WinRate</span><span>{r.winRate === null ? '—' : `${fmt(Number(r.winRate) * 100, 1)} %`}</span></li>
                  <li className="flex justify-between"><span style={{ color: 'var(--color-mut)' }}>Profit-Factor</span><span>{r.profitFactor === null ? '—' : fmt(Number(r.profitFactor))}</span></li>
                  <li className="flex justify-between"><span style={{ color: 'var(--color-mut)' }}>Expectancy</span><span>{r.expectancy === null ? '—' : `${fmt(Number(r.expectancy))} R`}</span></li>
                  <li className="flex justify-between"><span style={{ color: 'var(--color-mut)' }}>Trades</span><span>{fmt(Number(r.tradeCount), 0)}</span></li>
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <footer className="mt-10 text-center text-xs" style={{ color: 'var(--color-mut)' }}>
        Jede Kennzahl ist netto (Gebühren, Slippage, Funding) und stammt aus echten Binance-Kerzen der eigenen DB.
      </footer>
    </div>
  );
}
