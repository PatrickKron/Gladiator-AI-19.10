import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { MetricCard } from './EquityChart.js';
import { appLocale } from '../lib/locale.js';

/**
 * Monte-Carlo über die Trade-Reihenfolge (Repo-Masterliste, Phase 4): die
 * R-Multiples des aktuellen Backtests werden auf dem Server gemischt bzw. mit
 * Zurücklegen gezogen (deterministisch über den Seed). Zeigt Verteilung von
 * Endrendite, Drawdown und Verlustserie plus einen Kapital-Fächer.
 */

type McResult = Awaited<ReturnType<typeof trpc.lab.monteCarlo.mutate>>;

const MIN_TRADES = 10;
const fmt = (n: number, d = 2) => n.toLocaleString(appLocale(), { minimumFractionDigits: d, maximumFractionDigits: d });

function FanChart({ fan, start }: { fan: McResult['fan']; start: number }) {
  const W = 720;
  const H = 220;
  const padL = 56;
  const padR = 12;
  const padT = 10;
  const padB = 22;
  if (fan.length < 2) return null;
  const lo = Math.min(...fan.map((p) => p.p5), start);
  const hi = Math.max(...fan.map((p) => p.p95), start);
  const span = hi - lo || 1;
  const x = (i: number) => padL + ((W - padL - padR) * i) / (fan.length - 1);
  const y = (v: number) => padT + (H - padT - padB) * (1 - (v - lo) / span);
  const band = (upper: keyof McResult['fan'][number], lower: keyof McResult['fan'][number]) =>
    [...fan.map((p, i) => `${x(i)},${y(p[upper] as number)}`), ...fan.map((p, i) => `${x(i)},${y(p[lower] as number)}`).reverse()].join(' ');
  const line = fan.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.p50)}`).join(' ');
  const ticks = [lo, (lo + hi) / 2, hi];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Monte-Carlo">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="rgba(99,140,255,0.12)" />
          <text x={padL - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="#8b94b8" className="num">
            {fmt(v, 0)}
          </text>
        </g>
      ))}
      <line x1={padL} x2={W - padR} y1={y(start)} y2={y(start)} stroke="rgba(139,148,184,0.5)" strokeDasharray="3 3" />
      <polygon points={band('p95', 'p5')} fill="rgba(79,209,255,0.10)" />
      <polygon points={band('p75', 'p25')} fill="rgba(79,209,255,0.22)" />
      <path d={line} fill="none" stroke="#4fd1ff" strokeWidth="1.5" />
      <text x={padL} y={H - 6} fontSize="10" fill="#8b94b8">
        0
      </text>
      <text x={W - padR} y={H - 6} fontSize="10" fill="#8b94b8" textAnchor="end">
        {fan[fan.length - 1]!.index}
      </text>
    </svg>
  );
}

export function MonteCarloPanel({ rMultiples, riskPct, startEquity = 10_000 }: { rMultiples: number[]; riskPct: number; startEquity?: number }) {
  const { t } = useTranslation();
  const [runs, setRuns] = useState(1000);
  const [mode, setMode] = useState<'shuffle' | 'bootstrap'>('shuffle');
  const [seed, setSeed] = useState(42);
  const [risk, setRisk] = useState(riskPct);
  const [res, setRes] = useState<McResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const tooFew = rMultiples.length < MIN_TRADES;

  const simulate = async () => {
    setBusy(true);
    setErr(null);
    try {
      setRes(await trpc.lab.monteCarlo.mutate({ rMultiples, startEquity, riskPct: risk, runs, seed, mode }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const sel = 'field cursor-pointer px-2 py-1 text-xs';
  return (
    <section className="glass mt-6 p-6">
      <h2 className="label">{t('labor.mcTitle')}</h2>
      <p className="mt-2 text-xs" style={{ color: 'var(--color-mut)' }}>
        {t('labor.mcIntro', { n: rMultiples.length })}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-mut)' }}>
          {t('labor.mcRuns')}
          <select value={runs} onChange={(e) => setRuns(Number(e.target.value))} className={sel} aria-label={t('labor.mcRuns')}>
            {[500, 1000, 2000, 5000].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-mut)' }}>
          {t('labor.mcMode')}
          <select value={mode} onChange={(e) => setMode(e.target.value as 'shuffle' | 'bootstrap')} className={sel} aria-label={t('labor.mcMode')}>
            <option value="shuffle">{t('labor.mcShuffle')}</option>
            <option value="bootstrap">{t('labor.mcBootstrap')}</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-mut)' }}>
          {t('labor.mcSeed')}
          <input type="number" min={0} max={2147483647} value={seed} onChange={(e) => setSeed(Math.max(0, Math.floor(Number(e.target.value) || 0)))} className="field num w-24 px-2 py-1 text-xs" aria-label={t('labor.mcSeed')} />
        </label>
        <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-mut)' }}>
          {t('labor.mcRisk')}
          <input type="number" min={0.1} max={5} step={0.1} value={risk} onChange={(e) => setRisk(Math.min(5, Math.max(0.1, Number(e.target.value) || 0.1)))} className="field num w-20 px-2 py-1 text-xs" aria-label={t('labor.mcRisk')} />
        </label>
        <button type="button" onClick={() => void simulate()} disabled={busy || tooFew} className="btn-primary px-4 py-1.5 text-xs disabled:opacity-50">
          {busy ? t('labor.mcRunning') : t('labor.mcRun')}
        </button>
        {tooFew && (
          <span className="text-xs" style={{ color: 'var(--color-warn)' }}>
            {t('labor.mcTooFew', { n: rMultiples.length })}
          </span>
        )}
        {err && (
          <span className="text-xs" style={{ color: 'var(--color-neg)' }}>
            {err}
          </span>
        )}
      </div>

      {res && (
        <>
          <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-5">
            <MetricCard label={t('labor.mcMedianReturn')} value={`${fmt(res.finalReturnPct.p50)} %`} tone={res.finalReturnPct.p50 >= 0 ? 'pos' : 'neg'} hint={t('labor.mcRange', { lo: `${fmt(res.finalReturnPct.p5)} %`, hi: `${fmt(res.finalReturnPct.p95)} %` })} />
            <MetricCard label={t('labor.mcMedianDd')} value={`${fmt(res.maxDrawdownPct.p50)} %`} tone="neg" hint={t('labor.mcP95', { v: `${fmt(res.maxDrawdownPct.p95)} %` })} />
            <MetricCard label={t('labor.mcProbLoss')} value={`${fmt(res.probLoss * 100, 1)} %`} tone={res.probLoss > 0.3 ? 'neg' : undefined} />
            <MetricCard label={t('labor.mcProbDd', { pct: 20 })} value={`${fmt((res.probDrawdownOver.find((p) => p.pct === 20)?.probability ?? 0) * 100, 1)} %`} hint={t('labor.mcProbDd', { pct: 30 }) + `: ${fmt((res.probDrawdownOver.find((p) => p.pct === 30)?.probability ?? 0) * 100, 1)} %`} />
            <MetricCard label={t('labor.mcStreak')} value={String(Math.round(res.longestLossStreak.p50))} hint={t('labor.mcStreakVal', { p50: Math.round(res.longestLossStreak.p50), p95: Math.round(res.longestLossStreak.p95) })} />
          </div>
          {res.probRuin > 0 && (
            <p className="mt-2 text-xs" style={{ color: 'var(--color-neg)' }}>
              {t('labor.mcRuin')}: {fmt(res.probRuin * 100, 1)} %
            </p>
          )}
          <p className="mt-2 text-xs" style={{ color: 'var(--color-mut)' }}>
            {t('labor.mcOriginal', { ret: fmt(res.original.finalReturnPct), dd: fmt(res.original.maxDrawdownPct), streak: res.original.longestLossStreak })}
          </p>
          <h3 className="label mt-4">{t('labor.mcFanTitle')}</h3>
          <div className="mt-2">
            <FanChart fan={res.fan} start={startEquity} />
          </div>
          <p className="mt-2 text-xs" style={{ color: 'var(--color-mut)' }}>
            {t('labor.mcNote')}
          </p>
        </>
      )}
    </section>
  );
}
