import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { PageHeader } from '../components/ui.js';
import { BacktestChart } from '../components/BacktestChart.js';
import { loadLabConfig, saveLabConfig, type LabConfig } from '../lib/lab-config.js';
import { CHART_TFS, type ChartTf } from '../lib/chart-url.js';
import {
  COMPARE_COLORS,
  EquityChart,
  MetricCard,
  MultiEquityChart,
  fmt,
  type ComparableRun,
} from '../components/EquityChart.js';
import { MonteCarloPanel } from '../components/MonteCarloPanel.js';
import { OptimizationProposals } from '../components/OptimizationProposals.js';
import { appLocale } from '../lib/locale.js';

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
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  return (
    <div>
      <h3 className="label">{title}</h3>
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="label text-left">
            <th className="py-1 pr-3 font-normal">{t('labor.bucket')}</th>
            <th className="py-1 pr-3 text-right font-normal">{t('labor.trades')}</th>
            <th className="py-1 pr-3 text-right font-normal">{t('labor.winRate')}</th>
            <th className="py-1 pr-3 text-right font-normal">{t('labor.expectancyR')}</th>
            <th className="py-1 text-right font-normal">{t('labor.netUsd')}</th>
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
type StrategyRun = ComparableRun & { metrics: Metrics };

/** Datenqualitäts-Hinweise (08_ §3b) — gleiche Box für Backtest und Walk-Forward. */
function DataQualityWarnings({ warnings, as: Tag }: { warnings: string[]; as: 'section' | 'div' }) {
  const { t } = useTranslation();
  if (warnings.length === 0) return null;
  return (
    <Tag
      className={`${Tag === 'section' ? 'mt-6' : 'mt-4'} rounded-[0.625rem] border p-4 text-sm`}
      style={{ borderColor: 'var(--color-warn)', color: 'var(--color-warn)' }}
    >
      <p className="font-medium">{t('labor.dataQuality')}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {warnings.map((w) => <li key={w}>{w}</li>)}
      </ul>
    </Tag>
  );
}

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
  // Trailing-Stop in % (leer = aus). DSL-Strategien mit eigenem trailingStop behalten ihren Wert.
  const [trailPctInput, setTrailPctInput] = useState('');
  const trailPct = (() => {
    const n = Number(trailPctInput.replace(',', '.'));
    return trailPctInput.trim() !== '' && n >= 0.1 && n <= 50 ? n : undefined;
  })();
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
        ...(trailPct !== undefined ? { trailPct } : {}),
      });
      setRun(res);
      setRunWindow({ from: fromIso, to: toIso });
      setSelectedTrade(res.trades.length > 0 ? res.trades.length - 1 : null);
      await refreshLists();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('labor.errBacktest'));
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
        ...(trailPct !== undefined ? { trailPct } : {}),
      });
      setWf(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('labor.errWf'));
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
      setError(err instanceof Error ? err.message : t('labor.errCalibrate'));
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
      setCompareErr(t('labor.compareMinTwo'));
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
          ...(trailPct !== undefined ? { trailPct } : {}),
        });
        results.push({
          key: sel,
          label,
          color: COMPARE_COLORS[idx % COMPARE_COLORS.length]!,
          metrics: res.metrics as Metrics,
          equityCurve: res.equityCurve,
        });
      } catch (err) {
        errors.push(`${label}: ${err instanceof Error ? err.message : t('labor.errGeneric')}`);
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
      setError(err instanceof Error ? err.message : t('labor.errSave'));
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
    // Zahlen als String übergeben: i18next interpoliert dann exakt wie zuvor das Template-Literal.
    const s = (v: number | null) => (v === null ? '' : String(v));
    const comments = [
      `# ${t('labor.csvTitle')}`,
      `# ${t('labor.csvLine1', { symbol: csvSymbol, tf: csvTf, from, to })}`,
      `# ${t('labor.csvLine2', { pnl: s(m.netPnl), ret: s(m.netReturnPct), dd: s(m.maxDrawdownPct) })}`,
      `# ${t('labor.csvLine3', { wr: pct(m.winRate), pf: s(m.profitFactor), exp: s(m.expectancy) })}`,
      `# ${t('labor.csvLine4', { sharpe: s(m.sharpe), sortino: s(m.sortino), n: s(m.tradeCount) })}`,
    ];
    // Spaltennamen bewusst sprachunabhängig fest: CSV-Importe in andere Werkzeuge dürfen nicht brechen.
    const header = ['#', 'Entry-Zeit', 'Direction', 'Symbol', 'TF', 'R', 'Netto $', 'MFE R', 'MAE R', 'Kosten $', 'Exit-Zeit'];
    const lines = tradeRows.map(({ t: tr, i }) =>
      [
        i + 1,
        new Date(tr.entryTs).toISOString(),
        tr.direction,
        csvSymbol,
        csvTf,
        tr.rMultiple,
        tr.netPnl,
        tr.mfeR,
        tr.maeR,
        Math.round((tr.fees + tr.funding) * 100) / 100,
        new Date(tr.exitTs).toISOString(),
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
        <h2 className="label">{t('labor.backtestTitle')}</h2>

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
            <span className="label">{t('labor.symbol')}</span>
            <select disabled={strategyId !== 'builtin'} value={symbol} onChange={(e) => setSymbol(e.target.value as typeof symbol)} className="field mt-1.5 w-full px-3 py-2">
              {universe.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="text-sm" style={{ opacity: strategyId === 'builtin' ? 1 : 0.5 }}>
            <span className="label">{t('labor.timeframe')}</span>
            <select disabled={strategyId !== 'builtin'} value={timeframe} onChange={(e) => setTimeframe(e.target.value as typeof timeframe)} className="field mt-1.5 w-full px-3 py-2">
              {TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
            </select>
          </label>
          <label className="text-sm" style={{ opacity: strategyId === 'builtin' ? 1 : 0.5 }}>
            <span className="label">{t('labor.setup')}</span>
            <select disabled={strategyId !== 'builtin'} value={setupType} onChange={(e) => setSetupType(e.target.value as typeof setupType)} className="field mt-1.5 w-full px-3 py-2">
              {SETUPS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="label">{t('labor.riskPerTrade')}</span>
            <input type="number" min={0.1} max={5} step={0.1} value={riskPct} onChange={(e) => setRiskPct(Number(e.target.value))} className="field num mt-1.5 w-full px-3 py-2" />
          </label>
          <label className="text-sm" title={t('labor.trailHint')}>
            <span className="label">{t('labor.trailLabel')}</span>
            <input
              id="lab-trail"
              type="number"
              min={0.1}
              max={50}
              step={0.1}
              placeholder={t('labor.off')}
              value={trailPctInput}
              onChange={(e) => setTrailPctInput(e.target.value)}
              className="field num mt-1.5 w-full px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="label">{t('labor.from')}</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="field num mt-1.5 w-full px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="label">{t('labor.to')}</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="field num mt-1.5 w-full px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="label">{t('labor.savedVersion')}</span>
            <select value={versionId} onChange={(e) => setVersionId(e.target.value)} className="field mt-1.5 w-full px-3 py-2">
              <option value="">{t('labor.defaultVersion')}</option>
              {versions.map((v) => <option key={v.id} value={v.id}>v{v.version} · {v.status}</option>)}
            </select>
          </label>
        </div>

        <h3 className="label mt-6">{t('labor.paramExperiment')}</h3>
        <div className="mt-3 grid gap-4 md:grid-cols-3">
          <label className="text-sm">
            <span className="label">{t('labor.rsiLookback')}</span>
            <input type="number" min={1} max={20} value={rsiLookbackBars} onChange={(e) => setRsiLookback(Number(e.target.value))} className="field num mt-1.5 w-full px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="label">{t('labor.retestWindow')}</span>
            <input type="number" min={2} max={60} value={retestWindowBars} onChange={(e) => setRetestWindow(Number(e.target.value))} className="field num mt-1.5 w-full px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="label">{t('labor.emaProximity')}</span>
            <input type="number" min={0.1} max={10} step={0.1} value={emaProximityPct} onChange={(e) => setEmaProximity(Number(e.target.value))} className="field num mt-1.5 w-full px-3 py-2" />
          </label>
        </div>

        {error && <p className="mt-4 text-sm" style={{ color: 'var(--color-neg)' }}>{error}</p>}

        <div className="mt-5 flex flex-wrap gap-3">
          <button onClick={() => void onRun()} disabled={busy !== null} className="btn-primary px-5 py-2.5 text-sm">
            {busy === 'bt' ? t('labor.runningBacktest') : t('labor.runBacktest')}
          </button>
          <button onClick={() => void onWalkForward()} disabled={busy !== null} className="btn-primary px-5 py-2.5 text-sm">
            {busy === 'wf' ? t('labor.runningWf') : t('labor.runWf')}
          </button>
          <button onClick={() => void onCalibrate()} disabled={busy !== null} className="btn-primary px-5 py-2.5 text-sm">
            {busy === 'cal' ? t('labor.calibrating') : t('labor.calibrate')}
          </button>
          <button
            onClick={() => void onSaveVersion()}
            disabled={busy !== null}
            className="rounded-[0.625rem] border px-5 py-2.5 text-sm"
            style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
          >
            {busy === 'save' ? t('labor.saving') : t('labor.saveVersion')}
          </button>
        </div>
      </section>

      {/* ── Backtest-Ergebnis ── */}
      {run && m && (
        <>
          {/* Datenqualität (08_ §3b): Auffälligkeiten ehrlich VOR den Kennzahlen zeigen */}
          <DataQualityWarnings warnings={run.dataQuality.warnings} as="section" />

          <section className="mt-6 grid gap-3 md:grid-cols-3 xl:grid-cols-5">
            <MetricCard label={t('labor.netPnl')} value={`${fmt(m.netPnl)} $`} tone={m.netPnl >= 0 ? 'pos' : 'neg'} />
            <MetricCard label={t('labor.netReturn')} value={`${fmt(m.netReturnPct)} %`} tone={m.netReturnPct >= 0 ? 'pos' : 'neg'} />
            <MetricCard label={t('labor.maxDrawdown')} value={`${fmt(m.maxDrawdownPct)} %`} tone="neg" />
            <MetricCard label="Sharpe" value={fmt(m.sharpe)} />
            <MetricCard label="Sortino" value={fmt(m.sortino)} />
            <MetricCard label={t('labor.winRate')} value={m.winRate === null ? '—' : `${fmt(m.winRate * 100, 1)} %`} />
            <MetricCard label={t('labor.profitFactor')} value={fmt(m.profitFactor)} />
            <MetricCard label={t('labor.expectedValue')} value={m.expectancy === null ? '—' : `${fmt(m.expectancy)} R`} />
            <MetricCard label={t('labor.trades')} value={String(m.tradeCount)} />
            <MetricCard label={t('labor.candles')} value={fmt(run.candles, 0)} />
          </section>

          {/* Kostenmodell inkl. Funding-Herkunft (08_ §3a) — historisch nur bei vollständigen echten Settlements */}
          <p className="mt-3 text-xs" style={{ color: 'var(--color-mut)' }}>
            {t('labor.costLine', {
              taker: fmt(run.costModel.takerFeeRate * 100, 3),
              slippage: fmt(run.costModel.slippageBps, 1),
              funding:
                run.fundingSource === 'historical'
                  ? t('labor.fundingHistorical')
                  : t('labor.fundingModelRate', { rate: fmt(run.costModel.fundingRatePer8h * 100, 3) }),
            })}
          </p>

          <section className="glass mt-6 p-6">
            <h2 className="label">{t('labor.equityTitle', { start: fmt(10000, 0) })}</h2>
            <div className="mt-4"><EquityChart points={run.equityCurve} emptyText={t('labor.tooFewPoints')} step /></div>
          </section>

          {/* Monte-Carlo über die Trade-Reihenfolge (Repo-Masterliste, Phase 4) */}
          <MonteCarloPanel key={run.backtestId} rMultiples={run.rMultiples} riskPct={riskPct} />

          {runWindow && run.trades.length > 0 && (() => {
            // Symbol/Timeframe aus dem RAPS-clusterKey (`slug|symbol|setup|tf|all|all`) —
            // robust für builtin SMC und DSL-Strategien gleichermaßen.
            const parts = run.raps.clusterKey.split('|');
            const chartSymbol = parts[1] ?? symbol;
            const chartTf = parts[3] ?? timeframe;
            return (
              <section className="glass mt-6 p-6">
                <h2 className="label">{t('labor.visualTitle', { symbol: chartSymbol, tf: chartTf })}</h2>
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
            <h2 className="label">{t('labor.rapsTitle', { explanation: run.raps.explanation })}</h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-center text-sm">
                <thead>
                  <tr className="label">
                    <th className="py-1.5 text-left font-normal">{t('labor.leverage')}</th>
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
                            title={cell?.excluded ? t('labor.liqRate', { pct: (cell.liquidationRate * 100).toFixed(1) }) : ''}
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
            <h2 className="label">{t('labor.analysisTitle')}</h2>
            <div className="mt-4 grid gap-6 lg:grid-cols-2">
              <BucketTable title={t('labor.bySession')} rows={Object.entries(run.analysis.bySession)} />
              <BucketTable
                title={t('labor.byDirectionRegime')}
                rows={Object.entries(run.analysis.byDirectionRegime).map(([k, v]) => [
                  k.replace('|above', ` · ${t('labor.aboveEma200')}`).replace('|below', ` · ${t('labor.belowEma200')}`),
                  v,
                ])}
              />
              <BucketTable
                title={t('labor.byPhase')}
                rows={Object.entries(run.analysis.byPhase).filter((e): e is [string, Bucket] => e[1] !== undefined)}
              />
              <div>
                <h3 className="label">{t('labor.confluenceTitle')}</h3>
                <table className="mt-2 w-full text-sm">
                  <thead>
                    <tr className="label text-left">
                      <th className="py-1 pr-3 font-normal">{t('labor.factor')}</th>
                      <th className="py-1 pr-3 text-right font-normal">{t('labor.withN')}</th>
                      <th className="py-1 pr-3 text-right font-normal">{t('labor.withR')}</th>
                      <th className="py-1 pr-3 text-right font-normal">{t('labor.withoutR')}</th>
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
                <h3 className="label">{t('labor.turningPoints')}</h3>
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
                      {tp.kind} {tp.direction === 'bullish' ? '▲' : '▼'} {new Date(tp.ts).toLocaleDateString(appLocale())}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="glass mt-6 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="label">{t('labor.tradesTitle', { n: run.trades.length })}</h2>
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
                    <th className="py-1.5 pr-3 font-normal">{t('labor.entry')}</th>
                    <th className="py-1.5 pr-3 font-normal">{t('labor.direction')}</th>
                    {(
                      [
                        ['r', 'R'],
                        ['net', t('labor.netUsd')],
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
                    <th className="py-1.5 pr-3 text-right font-normal">{t('labor.costsUsd')}</th>
                    <th className="py-1.5 font-normal">{t('labor.exit')}</th>
                  </tr>
                </thead>
                <tbody className="num">
                  {tradeRows.map(({ t: tr, i }) => (
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
                      <td className="py-1.5 pr-3">{new Date(tr.entryTs).toLocaleString(appLocale(), { dateStyle: 'short', timeStyle: 'short' })}</td>
                      <td className="py-1.5 pr-3" style={{ color: tr.direction === 'long' ? 'var(--color-pos)' : 'var(--color-neg)' }}>{tr.direction}</td>
                      <td className="py-1.5 pr-3 text-right" style={{ color: tr.rMultiple >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>{fmt(tr.rMultiple)}</td>
                      <td className="py-1.5 pr-3 text-right">{fmt(tr.netPnl)}</td>
                      <td className="py-1.5 pr-3 text-right">{fmt(tr.mfeR)}</td>
                      <td className="py-1.5 pr-3 text-right">{fmt(tr.maeR)}</td>
                      <td className="py-1.5 pr-3 text-right">{fmt(tr.fees + tr.funding)}</td>
                      <td className="py-1.5">{tr.exitReason}</td>
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
            {t('labor.wfTitle', {
              pnl: fmt(wf.combinedOos.netPnl),
              trades: wf.combinedOos.tradeCount,
              expectancy: fmt(wf.combinedOos.expectancy),
            })}
          </h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="label text-left">
                  <th className="py-1.5 pr-3 font-normal">{t('labor.wfWindow')}</th>
                  <th className="py-1.5 pr-3 font-normal">{t('labor.wfBestParams')}</th>
                  <th className="py-1.5 pr-3 text-right font-normal">IS-PnL</th>
                  <th className="py-1.5 pr-3 text-right font-normal">OOS-PnL</th>
                  <th className="py-1.5 text-right font-normal">OOS-Trades</th>
                </tr>
              </thead>
              <tbody className="num">
                {wf.windows.map((w, i) => (
                  <tr key={i} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                    <td className="py-1.5 pr-3">{t('labor.wfWindowRow', { n: i + 1, start: w.oosStart, end: w.oosEnd })}</td>
                    <td className="py-1.5 pr-3">{JSON.stringify(w.bestParams)}</td>
                    <td className="py-1.5 pr-3 text-right">{fmt(w.isNetPnl)}</td>
                    <td className="py-1.5 pr-3 text-right" style={{ color: w.oosNetPnl >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>{fmt(w.oosNetPnl)}</td>
                    <td className="py-1.5 text-right">{w.oosTrades}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Datenqualität + Funding-Herkunft — dieselben Prüfungen wie beim Backtest (08_ §3a/§3b) */}
          <DataQualityWarnings warnings={wf.dataQuality.warnings} as="div" />
          <p className="mt-3 text-xs" style={{ color: 'var(--color-mut)' }}>
            {t('labor.wfNote', {
              funding: wf.fundingSource === 'historical' ? t('labor.fundingHistorical') : t('labor.fundingModel'),
              trail: wf.trailPct !== null ? ` · ${t('labor.trailSuffix', { pct: fmt(wf.trailPct, 1) })}` : '',
            })}
          </p>
        </section>
      )}

      {/* ── Optimierungs-Vorschläge der Nacht-Optimierung (08_ §5, Mensch im Loop) ── */}
      <OptimizationProposals />

      {/* ── Multi-Strategie-Vergleich (Feature 3) ── */}
      <section className="glass mt-6 p-6">
        <h2 className="label">{t('labor.compareTitle', { from, to })}</h2>
        <p className="mt-2 text-xs" style={{ color: 'var(--color-mut)' }}>
          {t('labor.compareHint')}
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
            {busyCompare ? t('labor.comparing') : t('labor.compareN', { n: compareSel.length })}
          </button>
        </div>
        {compareErr && <p className="mt-3 text-sm" style={{ color: 'var(--color-neg)' }}>{compareErr}</p>}

        {strategyRuns.length > 0 && (
          <>
            <div className="mt-6 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="label text-left">
                    <th className="py-1.5 pr-3 font-normal">{t('labor.strategy')}</th>
                    <th className="py-1.5 pr-3 text-right font-normal">{t('labor.netPnlUsd')}</th>
                    <th className="py-1.5 pr-3 text-right font-normal">{t('labor.returnPct')}</th>
                    <th className="py-1.5 pr-3 text-right font-normal">{t('labor.maxDdPct')}</th>
                    <th className="py-1.5 pr-3 text-right font-normal">Sharpe</th>
                    <th className="py-1.5 pr-3 text-right font-normal">Sortino</th>
                    <th className="py-1.5 pr-3 text-right font-normal">{t('labor.winRate')}</th>
                    <th className="py-1.5 pr-3 text-right font-normal">PF</th>
                    <th className="py-1.5 pr-3 text-right font-normal">{t('labor.expectancyR')}</th>
                    <th className="py-1.5 text-right font-normal">{t('labor.trades')}</th>
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
              <h3 className="label">{t('labor.overlayTitle')}</h3>
              <div className="mt-3"><MultiEquityChart runs={strategyRuns} emptyText={t('labor.tooFewPoints')} /></div>
            </div>
          </>
        )}
      </section>

      {/* ── Adaptive Risk-Gates (Selbst-Kalibrierung) ── */}
      <section className="glass mt-6 p-6">
        <h2 className="label">{t('labor.gatesTitle')}</h2>
        {gates.length === 0 ? (
          <p className="mt-3 text-sm" style={{ color: 'var(--color-mut)' }}>
            {t('labor.gatesEmpty')}
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {gates.map((g) => (
              <li key={g.id} className="flex items-start justify-between gap-4 rounded-xl border p-3" style={{ borderColor: 'var(--color-line)', opacity: g.isActive ? 1 : 0.5 }}>
                <div>
                  <p className="text-sm">{g.reason}</p>
                  <p className="label mt-1">
                    {t('labor.gateScope', {
                      symbol: g.symbol ?? t('labor.all'),
                      tf: g.timeframe ?? t('labor.allTf'),
                      source: g.source,
                      date: new Date(g.createdAt as unknown as string).toLocaleString(appLocale(), { dateStyle: 'short', timeStyle: 'short' }),
                    })}
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
                  {g.isActive ? t('labor.gateActive') : t('labor.gateInactive')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Lauf-Verlauf + Vergleich ── */}
      <section className="glass mt-6 p-6">
        <h2 className="label">{t('labor.historyTitle')}</h2>
        {runs.length === 0 ? (
          <p className="mt-3 text-sm" style={{ color: 'var(--color-mut)' }}>{t('labor.noRuns')}</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="label text-left">
                  <th className="py-1.5 pr-3 font-normal"></th>
                  <th className="py-1.5 pr-3 font-normal">{t('labor.time')}</th>
                  <th className="py-1.5 pr-3 font-normal">{t('labor.run')}</th>
                  <th className="py-1.5 pr-3 text-right font-normal">{t('labor.returnPct')}</th>
                  <th className="py-1.5 pr-3 text-right font-normal">{t('labor.maxDdPctShort')}</th>
                  <th className="py-1.5 pr-3 text-right font-normal">PF</th>
                  <th className="py-1.5 text-right font-normal">{t('labor.trades')}</th>
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
                    <td className="py-1.5 pr-3">{new Date(r.createdAt).toLocaleString(appLocale(), { dateStyle: 'short', timeStyle: 'short' })}</td>
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
                <p className="label">v{r.version} · {r.symbol} {r.timeframe} · {new Date(r.createdAt).toLocaleDateString(appLocale())}</p>
                <ul className="num mt-3 space-y-1.5 text-sm">
                  <li className="flex justify-between"><span style={{ color: 'var(--color-mut)' }}>{t('labor.netReturn')}</span><span>{fmt(Number(r.netReturn))} %</span></li>
                  <li className="flex justify-between"><span style={{ color: 'var(--color-mut)' }}>{t('labor.maxDrawdown')}</span><span>{fmt(Number(r.maxDrawdown))} %</span></li>
                  <li className="flex justify-between"><span style={{ color: 'var(--color-mut)' }}>Sharpe</span><span>{r.sharpe === null ? '—' : fmt(Number(r.sharpe))}</span></li>
                  <li className="flex justify-between"><span style={{ color: 'var(--color-mut)' }}>{t('labor.winRate')}</span><span>{r.winRate === null ? '—' : `${fmt(Number(r.winRate) * 100, 1)} %`}</span></li>
                  <li className="flex justify-between"><span style={{ color: 'var(--color-mut)' }}>{t('labor.profitFactor')}</span><span>{r.profitFactor === null ? '—' : fmt(Number(r.profitFactor))}</span></li>
                  <li className="flex justify-between"><span style={{ color: 'var(--color-mut)' }}>{t('labor.expectancy')}</span><span>{r.expectancy === null ? '—' : `${fmt(Number(r.expectancy))} R`}</span></li>
                  <li className="flex justify-between"><span style={{ color: 'var(--color-mut)' }}>{t('labor.trades')}</span><span>{fmt(Number(r.tradeCount), 0)}</span></li>
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <footer className="mt-10 text-center text-xs" style={{ color: 'var(--color-mut)' }}>
        {t('labor.footer')}
      </footer>
    </div>
  );
}
