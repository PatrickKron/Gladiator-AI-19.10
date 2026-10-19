import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader, Panel } from '../components/ui.js';
import { COMPARE_COLORS, EquityChart, MetricCard, MultiEquityChart, fmt } from '../components/EquityChart.js';
import { CHART_TFS } from '../lib/chart-url.js';

/**
 * Strategie-Workshop (Session 2): Pine-Script einfügen → KI-Analyse →
 * interaktiver Dialog → Agent-Konfiguration (alle Felder editierbar) →
 * Draft-Backtests (echte Kerzen, netto) mit Parameter-Set-Vergleich →
 * Version speichern → Paper-Deploy über das bestehende Validitäts-Gate.
 * Kein Fake: jede Zahl kommt aus der Engine, jeder LLM-Vorschlag wird erst
 * nach Zod-Validierung UND explizitem Klick zum Entwurf.
 */

type SessionRow = Awaited<ReturnType<typeof trpc.workshop.list.query>>[number];
type SessionDetail = Awaited<ReturnType<typeof trpc.workshop.get.query>>;
type Message = SessionDetail['messages'][number];
type BacktestRow = Awaited<ReturnType<typeof trpc.workshop.backtests.query>>[number];
type VersionRow = Awaited<ReturnType<typeof trpc.workshop.versions.query>>[number];
type RunResult = Awaited<ReturnType<typeof trpc.workshop.runBacktest.mutate>>;
type TradeRow = RunResult['trades'][number];
type Metrics = RunResult['metrics'];
type Analysis = {
  strategyType: string;
  strategyTypeDetail?: string;
  direction: string;
  timeframeHint?: string | null;
  indicators: { name: string; params?: string; role?: string }[];
  entryConditions: string[];
  exitConditions: string[];
  parameters: { name: string; value?: string; description?: string }[];
  notTranslatable: string[];
  summary: string;
};

// ── Client-Spiegel der Instruction-DSL (Server validiert via Zod — eine Wahrheit) ──
type Cond =
  | { signal: 'BOS' | 'CHoCH' }
  | { indicator: 'RSI'; lt?: number; gt?: number; period?: number }
  | { trend: 'EMA200_up' | 'EMA200_down' }
  | { maCross: { kind: 'EMA' | 'SMA'; fast: number; slow: number; cross: 'bullish' | 'bearish'; withinBars?: number } }
  | { priceVs: { kind: 'EMA' | 'SMA'; period: number; is: 'above' | 'below' } }
  | { macd: { fast?: number; slow?: number; signal?: number; event: 'bullish_cross' | 'bearish_cross' | 'histogram_positive' | 'histogram_negative'; withinBars?: number } }
  | { bollinger: { period?: number; mult?: number; event: 'close_below_lower' | 'close_above_upper' | 'close_above_middle' | 'close_below_middle' } }
  | { stochastic: { kPeriod?: number; dPeriod?: number; smoothK?: number; kLt?: number; kGt?: number; cross?: 'bullish' | 'bearish'; withinBars?: number } }
  | { adx: { period?: number; gt?: number; lt?: number } }
  | { supertrend: { period?: number; mult?: number; direction: 'up' | 'down' } };

type Dsl = {
  id: string;
  symbol: string;
  timeframe: string;
  venueType: 'cex' | 'dex';
  direction: 'long' | 'short';
  setupType: 'scalp' | 'swing' | 'position';
  when: { session?: 'asia' | 'london' | 'overlap' | 'newyork' | 'off'; all: Cond[] };
  entry: string;
  stopLoss: { type: 'ATR'; mult: number } | { type: 'pct'; pct: number };
  takeProfits: { rr: number }[];
  /** Optional: Trailing-Stop im %-Abstand (gleiche Logik in Backtest und Live). */
  trailingStop?: { pct: number };
  risk: { maxLeveragePerTrade: number; riskPctPerTrade: number };
};

const COND_TYPES = ['signal', 'rsi', 'trend', 'maCross', 'priceVs', 'macd', 'bollinger', 'stochastic', 'adx', 'supertrend'] as const;
type CondType = (typeof COND_TYPES)[number];

function condType(c: Cond): CondType {
  if ('signal' in c) return 'signal';
  if ('indicator' in c) return 'rsi';
  if ('trend' in c) return 'trend';
  if ('maCross' in c) return 'maCross';
  if ('priceVs' in c) return 'priceVs';
  if ('macd' in c) return 'macd';
  if ('bollinger' in c) return 'bollinger';
  if ('stochastic' in c) return 'stochastic';
  if ('adx' in c) return 'adx';
  return 'supertrend';
}

function newCond(type: CondType): Cond {
  switch (type) {
    case 'signal': return { signal: 'BOS' };
    case 'rsi': return { indicator: 'RSI', lt: 30 };
    case 'trend': return { trend: 'EMA200_up' };
    case 'maCross': return { maCross: { kind: 'EMA', fast: 20, slow: 50, cross: 'bullish', withinBars: 3 } };
    case 'priceVs': return { priceVs: { kind: 'EMA', period: 200, is: 'above' } };
    case 'macd': return { macd: { event: 'bullish_cross', withinBars: 3 } };
    case 'bollinger': return { bollinger: { event: 'close_below_lower' } };
    case 'stochastic': return { stochastic: { kLt: 20 } };
    case 'adx': return { adx: { gt: 20 } };
    case 'supertrend': return { supertrend: { direction: 'up' } };
  }
}

function defaultDsl(): Dsl {
  return {
    id: 'workshop-strategie',
    symbol: 'BTC/USDT',
    timeframe: '1h',
    venueType: 'cex',
    direction: 'long',
    setupType: 'swing',
    when: { all: [{ priceVs: { kind: 'EMA', period: 200, is: 'above' } }] },
    entry: 'market',
    stopLoss: { type: 'ATR', mult: 2 },
    takeProfits: [{ rr: 1.5 }, { rr: 3 }],
    risk: { maxLeveragePerTrade: 2, riskPctPerTrade: 1 },
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Kleine Form-Bausteine ───────────────────────────────────────────────────

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="field px-3 py-2 text-sm" />
    </label>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="field px-3 py-2 text-sm">
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

/** Zahlenfeld: leer = undefined (optionale Parameter bleiben ehrlich weg). */
function NumBox({ label, value, onChange, step = 1, className = 'w-24' }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void; step?: number; className?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-mut)' }}>{label}</span>
      <input
        type="number"
        step={step}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        className={`field px-2 py-1.5 text-sm ${className}`}
      />
    </label>
  );
}

function MiniSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-mut)' }}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="field px-2 py-1.5 text-sm">
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}

const secondaryBtn = 'rounded-[0.625rem] border px-3 py-1.5 text-xs transition-all';
const secondaryStyle = { borderColor: 'rgba(139,92,246,0.4)', color: 'var(--color-violet)' } as const;
const ghostStyle = { borderColor: 'var(--color-line)', color: 'var(--color-mut)' } as const;

// ── Bedingungs-Editor ───────────────────────────────────────────────────────

function CondRow({ cond, onChange, onRemove }: { cond: Cond; onChange: (c: Cond) => void; onRemove: () => void }) {
  const { t } = useTranslation();
  const type = condType(cond);
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-[0.625rem] border p-3" style={{ borderColor: 'var(--color-line)' }}>
      <MiniSelect label={t('sw.condType')} value={type} options={[...COND_TYPES]} onChange={(v) => onChange(newCond(v as CondType))} />
      {type === 'signal' && 'signal' in cond && (
        <MiniSelect label={t('sw.condSignal')} value={cond.signal} options={['BOS', 'CHoCH']} onChange={(v) => onChange({ signal: v as 'BOS' | 'CHoCH' })} />
      )}
      {type === 'rsi' && 'indicator' in cond && (
        <>
          <NumBox label="lt" value={cond.lt} onChange={(v) => onChange({ ...cond, lt: v })} />
          <NumBox label="gt" value={cond.gt} onChange={(v) => onChange({ ...cond, gt: v })} />
          <NumBox label={t('sw.period')} value={cond.period} onChange={(v) => onChange({ ...cond, period: v })} />
        </>
      )}
      {type === 'trend' && 'trend' in cond && (
        <MiniSelect label="EMA200" value={cond.trend} options={['EMA200_up', 'EMA200_down']} onChange={(v) => onChange({ trend: v as 'EMA200_up' | 'EMA200_down' })} />
      )}
      {type === 'maCross' && 'maCross' in cond && (
        <>
          <MiniSelect label="MA" value={cond.maCross.kind} options={['EMA', 'SMA']} onChange={(v) => onChange({ maCross: { ...cond.maCross, kind: v as 'EMA' | 'SMA' } })} />
          <NumBox label="fast" value={cond.maCross.fast} onChange={(v) => onChange({ maCross: { ...cond.maCross, fast: v ?? 20 } })} />
          <NumBox label="slow" value={cond.maCross.slow} onChange={(v) => onChange({ maCross: { ...cond.maCross, slow: v ?? 50 } })} />
          <MiniSelect label="cross" value={cond.maCross.cross} options={['bullish', 'bearish']} onChange={(v) => onChange({ maCross: { ...cond.maCross, cross: v as 'bullish' | 'bearish' } })} />
          <NumBox label={t('sw.withinBars')} value={cond.maCross.withinBars} onChange={(v) => onChange({ maCross: { ...cond.maCross, withinBars: v } })} />
        </>
      )}
      {type === 'priceVs' && 'priceVs' in cond && (
        <>
          <MiniSelect label="MA" value={cond.priceVs.kind} options={['EMA', 'SMA']} onChange={(v) => onChange({ priceVs: { ...cond.priceVs, kind: v as 'EMA' | 'SMA' } })} />
          <NumBox label={t('sw.period')} value={cond.priceVs.period} onChange={(v) => onChange({ priceVs: { ...cond.priceVs, period: v ?? 200 } })} />
          <MiniSelect label={t('sw.position')} value={cond.priceVs.is} options={['above', 'below']} onChange={(v) => onChange({ priceVs: { ...cond.priceVs, is: v as 'above' | 'below' } })} />
        </>
      )}
      {type === 'macd' && 'macd' in cond && (
        <>
          <MiniSelect
            label="Event"
            value={cond.macd.event}
            options={['bullish_cross', 'bearish_cross', 'histogram_positive', 'histogram_negative']}
            onChange={(v) => onChange({ macd: { ...cond.macd, event: v as Cond extends never ? never : 'bullish_cross' } })}
          />
          <NumBox label="fast" value={cond.macd.fast} onChange={(v) => onChange({ macd: { ...cond.macd, fast: v } })} />
          <NumBox label="slow" value={cond.macd.slow} onChange={(v) => onChange({ macd: { ...cond.macd, slow: v } })} />
          <NumBox label="signal" value={cond.macd.signal} onChange={(v) => onChange({ macd: { ...cond.macd, signal: v } })} />
          <NumBox label={t('sw.withinBars')} value={cond.macd.withinBars} onChange={(v) => onChange({ macd: { ...cond.macd, withinBars: v } })} />
        </>
      )}
      {type === 'bollinger' && 'bollinger' in cond && (
        <>
          <MiniSelect
            label="Event"
            value={cond.bollinger.event}
            options={['close_below_lower', 'close_above_upper', 'close_above_middle', 'close_below_middle']}
            onChange={(v) => onChange({ bollinger: { ...cond.bollinger, event: v as 'close_below_lower' } })}
          />
          <NumBox label={t('sw.period')} value={cond.bollinger.period} onChange={(v) => onChange({ bollinger: { ...cond.bollinger, period: v } })} />
          <NumBox label="mult" step={0.1} value={cond.bollinger.mult} onChange={(v) => onChange({ bollinger: { ...cond.bollinger, mult: v } })} />
        </>
      )}
      {type === 'stochastic' && 'stochastic' in cond && (
        <>
          <NumBox label="K lt" value={cond.stochastic.kLt} onChange={(v) => onChange({ stochastic: { ...cond.stochastic, kLt: v } })} />
          <NumBox label="K gt" value={cond.stochastic.kGt} onChange={(v) => onChange({ stochastic: { ...cond.stochastic, kGt: v } })} />
          <MiniSelect
            label="cross"
            value={cond.stochastic.cross ?? '—'}
            options={['—', 'bullish', 'bearish']}
            onChange={(v) => onChange({ stochastic: { ...cond.stochastic, cross: v === '—' ? undefined : (v as 'bullish' | 'bearish') } })}
          />
          <NumBox label="K" value={cond.stochastic.kPeriod} onChange={(v) => onChange({ stochastic: { ...cond.stochastic, kPeriod: v } })} />
          <NumBox label="D" value={cond.stochastic.dPeriod} onChange={(v) => onChange({ stochastic: { ...cond.stochastic, dPeriod: v } })} />
        </>
      )}
      {type === 'adx' && 'adx' in cond && (
        <>
          <NumBox label="gt" value={cond.adx.gt} onChange={(v) => onChange({ adx: { ...cond.adx, gt: v } })} />
          <NumBox label="lt" value={cond.adx.lt} onChange={(v) => onChange({ adx: { ...cond.adx, lt: v } })} />
          <NumBox label={t('sw.period')} value={cond.adx.period} onChange={(v) => onChange({ adx: { ...cond.adx, period: v } })} />
        </>
      )}
      {type === 'supertrend' && 'supertrend' in cond && (
        <>
          <MiniSelect label={t('sw.direction')} value={cond.supertrend.direction} options={['up', 'down']} onChange={(v) => onChange({ supertrend: { ...cond.supertrend, direction: v as 'up' | 'down' } })} />
          <NumBox label={t('sw.period')} value={cond.supertrend.period} onChange={(v) => onChange({ supertrend: { ...cond.supertrend, period: v } })} />
          <NumBox label="mult" step={0.1} value={cond.supertrend.mult} onChange={(v) => onChange({ supertrend: { ...cond.supertrend, mult: v } })} />
        </>
      )}
      <button onClick={onRemove} className={secondaryBtn} style={{ borderColor: 'rgba(255,92,108,0.4)', color: 'var(--color-neg)' }}>
        ✕
      </button>
    </div>
  );
}

// ── Entwurfs-Editor (alle DSL-Felder editierbar) ────────────────────────────

function DraftEditor({ sessionId, draft, universe, onSaved }: { sessionId: string; draft: Dsl | null; universe: string[]; onSaved: (dsl: Dsl) => void }) {
  const { t } = useTranslation();
  const [d, setD] = useState<Dsl>(draft ?? defaultDsl());
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => {
    setD(draft ?? defaultDsl());
    setErrors([]);
  }, [draft]);

  const set = (patch: Partial<Dsl>) => setD((prev) => ({ ...prev, ...patch }));
  const entryRetest = d.entry.startsWith('retest@EMA');
  const symbols = useMemo(() => (universe.includes(d.symbol) ? universe : [d.symbol, ...universe]), [universe, d.symbol]);

  async function save(dsl: Dsl) {
    setBusy(true);
    setErrors([]);
    setSavedAt(null);
    try {
      const res = await trpc.workshop.updateDraft.mutate({ id: sessionId, dsl });
      if (!res.ok) {
        setErrors(res.errors);
        return;
      }
      setD(res.dsl as Dsl);
      setSavedAt(Date.now());
      onSaved(res.dsl as Dsl);
    } catch (err) {
      setErrors([err instanceof Error ? err.message : t('common.error')]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel label={t('sw.draftTitle')} stagger={3}>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('sw.draftHint')}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={() => {
            if (!jsonMode) setJsonText(JSON.stringify(d, null, 2));
            setJsonMode(!jsonMode);
          }}
          className={secondaryBtn}
          style={jsonMode ? secondaryStyle : ghostStyle}
        >
          {jsonMode ? t('sw.formMode') : t('sw.jsonMode')}
        </button>
      </div>

      {jsonMode ? (
        <div className="mt-4">
          <textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} rows={16} spellCheck={false} className="field w-full px-3 py-2 font-mono text-xs" />
          <div className="mt-3">
            <button
              onClick={() => {
                try {
                  void save(JSON.parse(jsonText) as Dsl);
                } catch {
                  setErrors([t('sw.jsonInvalid')]);
                }
              }}
              disabled={busy}
              className="btn-primary px-4 py-2 text-sm"
            >
              {busy ? t('common.loading') : t('sw.saveDraft')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <Field label={t('sw.slug')} value={d.id} onChange={(v) => set({ id: v })} placeholder="meine-strategie" />
            <Select label={t('sw.symbol')} value={d.symbol} options={symbols.map((s) => ({ value: s, label: s }))} onChange={(v) => set({ symbol: v })} />
            <Select label={t('sw.timeframe')} value={d.timeframe} options={CHART_TFS.map((tf) => ({ value: tf, label: tf }))} onChange={(v) => set({ timeframe: v })} />
            <Select
              label={t('sw.direction')}
              value={d.direction}
              options={[{ value: 'long', label: 'Long' }, { value: 'short', label: 'Short' }]}
              onChange={(v) => set({ direction: v as Dsl['direction'] })}
            />
            <Select
              label={t('sw.setupType')}
              value={d.setupType}
              options={['scalp', 'swing', 'position'].map((s) => ({ value: s, label: s }))}
              onChange={(v) => set({ setupType: v as Dsl['setupType'] })}
            />
            <Select
              label={t('sw.session')}
              value={d.when.session ?? ''}
              options={[{ value: '', label: t('sw.sessionAny') }, ...['asia', 'london', 'overlap', 'newyork', 'off'].map((s) => ({ value: s, label: s }))]}
              onChange={(v) => set({ when: { ...d.when, session: v === '' ? undefined : (v as NonNullable<Dsl['when']['session']>) } })}
            />
          </div>

          <div className="mt-5">
            <p className="label mb-2">{t('sw.conditions')}</p>
            <div className="flex flex-col gap-2">
              {d.when.all.map((c, i) => (
                <CondRow
                  key={i}
                  cond={c}
                  onChange={(nc) => set({ when: { ...d.when, all: d.when.all.map((x, j) => (j === i ? nc : x)) } })}
                  onRemove={() => set({ when: { ...d.when, all: d.when.all.filter((_, j) => j !== i) } })}
                />
              ))}
            </div>
            <button
              onClick={() => set({ when: { ...d.when, all: [...d.when.all, newCond('rsi')] } })}
              className={`${secondaryBtn} mt-2`}
              style={secondaryStyle}
              disabled={d.when.all.length >= 10}
            >
              + {t('sw.addCondition')}
            </button>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-3">
            <div className="flex flex-wrap items-end gap-3">
              <MiniSelect
                label={t('sw.entry')}
                value={entryRetest ? 'retest' : 'market'}
                options={['market', 'retest']}
                onChange={(v) => set({ entry: v === 'market' ? 'market' : 'retest@EMA50' })}
              />
              {entryRetest && (
                <NumBox
                  label="EMA"
                  value={Number(d.entry.slice('retest@EMA'.length)) || 50}
                  onChange={(v) => set({ entry: `retest@EMA${v ?? 50}` })}
                />
              )}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <MiniSelect
                label={t('sw.stopLoss')}
                value={d.stopLoss.type}
                options={['ATR', 'pct']}
                onChange={(v) => set({ stopLoss: v === 'ATR' ? { type: 'ATR', mult: 2 } : { type: 'pct', pct: 2 } })}
              />
              {d.stopLoss.type === 'ATR' ? (
                <NumBox label="mult" step={0.1} value={d.stopLoss.mult} onChange={(v) => set({ stopLoss: { type: 'ATR', mult: v ?? 2 } })} />
              ) : (
                <NumBox label="%" step={0.1} value={d.stopLoss.pct} onChange={(v) => set({ stopLoss: { type: 'pct', pct: v ?? 2 } })} />
              )}
              <NumBox
                label={`${t('position.trailing')} %`}
                step={0.1}
                value={d.trailingStop?.pct}
                onChange={(v) => set({ trailingStop: v === undefined || v <= 0 ? undefined : { pct: v } })}
                className="w-28"
              />
            </div>
            <div className="flex flex-wrap items-end gap-3">
              {d.takeProfits.map((tp, i) => (
                <NumBox
                  key={i}
                  label={`TP${i + 1} (R)`}
                  step={0.1}
                  value={tp.rr}
                  onChange={(v) => set({ takeProfits: d.takeProfits.map((x, j) => (j === i ? { rr: v ?? 1 } : x)) })}
                />
              ))}
              <button
                onClick={() => set({ takeProfits: [...d.takeProfits, { rr: (d.takeProfits[d.takeProfits.length - 1]?.rr ?? 1) + 1 }] })}
                className={secondaryBtn}
                style={secondaryStyle}
                disabled={d.takeProfits.length >= 5}
              >
                +TP
              </button>
              <button
                onClick={() => set({ takeProfits: d.takeProfits.slice(0, -1) })}
                className={secondaryBtn}
                style={ghostStyle}
                disabled={d.takeProfits.length <= 1}
              >
                −TP
              </button>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-end gap-3">
            <NumBox label={t('sw.maxLeverage')} step={0.5} value={d.risk.maxLeveragePerTrade} onChange={(v) => set({ risk: { ...d.risk, maxLeveragePerTrade: v ?? 1 } })} className="w-28" />
            <NumBox label={t('sw.riskPct')} step={0.1} value={d.risk.riskPctPerTrade} onChange={(v) => set({ risk: { ...d.risk, riskPctPerTrade: v ?? 1 } })} className="w-28" />
            <MiniSelect label="Venue" value={d.venueType} options={['cex', 'dex']} onChange={(v) => set({ venueType: v as Dsl['venueType'] })} />
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button onClick={() => void save(d)} disabled={busy} className="btn-primary px-4 py-2 text-sm">
              {busy ? t('common.loading') : t('sw.saveDraft')}
            </button>
            {savedAt && <span className="text-xs" style={{ color: 'var(--color-pos)' }}>{t('sw.draftSaved')}</span>}
          </div>
        </>
      )}

      {errors.length > 0 && (
        <div className="mt-3">
          <ErrorBox message={errors.join(' · ')} />
        </div>
      )}
      <p className="mt-3 text-[11px] leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('sw.noTrailingHint')}</p>
    </Panel>
  );
}

// ── Pine + Analyse ──────────────────────────────────────────────────────────

function AnalysisView({ analysis }: { analysis: Analysis }) {
  const { t } = useTranslation();
  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      <div>
        <p className="label">{t('sw.analysisSummary')}</p>
        <p className="mt-1 text-sm leading-relaxed">{analysis.summary}</p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border px-3 py-1" style={{ borderColor: 'rgba(79,209,255,0.5)', color: 'var(--color-ink)' }}>
            {t(`sw.type_${analysis.strategyType}`, analysis.strategyType)}
          </span>
          <span className="rounded-full border px-3 py-1" style={ghostStyle}>{analysis.direction}</span>
          {analysis.timeframeHint && <span className="rounded-full border px-3 py-1" style={ghostStyle}>{analysis.timeframeHint}</span>}
        </div>
        {analysis.indicators.length > 0 && (
          <div className="mt-4">
            <p className="label">{t('sw.analysisIndicators')}</p>
            <table className="mt-1 w-full text-sm">
              <tbody>
                {analysis.indicators.map((ind, i) => (
                  <tr key={i} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                    <td className="py-1 pr-3 font-medium">{ind.name}</td>
                    <td className="num py-1 pr-3 text-xs" style={{ color: 'var(--color-mut)' }}>{ind.params ?? ''}</td>
                    <td className="py-1 text-xs" style={{ color: 'var(--color-mut)' }}>{ind.role ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {analysis.parameters.length > 0 && (
          <div className="mt-4">
            <p className="label">{t('sw.analysisParams')}</p>
            <table className="mt-1 w-full text-sm">
              <tbody>
                {analysis.parameters.map((p, i) => (
                  <tr key={i} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                    <td className="py-1 pr-3">{p.name}</td>
                    <td className="num py-1 pr-3">{p.value ?? '—'}</td>
                    <td className="py-1 text-xs" style={{ color: 'var(--color-mut)' }}>{p.description ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div>
        <p className="label">{t('sw.analysisEntries')}</p>
        <ul className="mt-1 list-disc pl-5 text-sm leading-relaxed">
          {analysis.entryConditions.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
        <p className="label mt-4">{t('sw.analysisExits')}</p>
        <ul className="mt-1 list-disc pl-5 text-sm leading-relaxed">
          {analysis.exitConditions.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
        {analysis.notTranslatable.length > 0 && (
          <div className="mt-4 rounded-[0.625rem] border border-dashed p-3" style={{ borderColor: 'rgba(139,92,246,0.35)' }}>
            <p className="text-xs font-medium" style={{ color: 'var(--color-violet)' }}>{t('sw.analysisNotTranslatable')}</p>
            <ul className="mt-1 list-disc pl-5 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
              {analysis.notTranslatable.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function PinePanel({ session, onChanged }: { session: SessionDetail['session']; onChanged: () => void }) {
  const { t } = useTranslation();
  const [pine, setPine] = useState(session.pineSource ?? '');
  const [instructions, setInstructions] = useState(session.instructions ?? '');
  const [busy, setBusy] = useState<'save' | 'analyze' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const analysis = session.analysis as Analysis | null;
  useEffect(() => {
    setPine(session.pineSource ?? '');
    setInstructions(session.instructions ?? '');
  }, [session.id, session.pineSource, session.instructions]);

  async function saveMeta() {
    setBusy('save');
    setError(null);
    try {
      await trpc.workshop.update.mutate({ id: session.id, pineSource: pine || null, instructions: instructions || null });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(null);
    }
  }

  async function analyze() {
    setBusy('analyze');
    setError(null);
    try {
      if (pine !== (session.pineSource ?? '') || instructions !== (session.instructions ?? '')) {
        await trpc.workshop.update.mutate({ id: session.id, pineSource: pine || null, instructions: instructions || null });
      }
      const res = await trpc.workshop.analyze.mutate({ id: session.id });
      if (!res.ok) {
        setError(`${t('sw.analyzeFailed')}: ${res.errors.join(' · ')}`);
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel label={t('sw.pineTitle')} stagger={1}>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('sw.pineHint')}</p>
      <textarea
        value={pine}
        onChange={(e) => setPine(e.target.value)}
        rows={10}
        spellCheck={false}
        placeholder={'//@version=5\nstrategy("Meine Strategie", overlay=true)\n…'}
        className="field mt-3 w-full px-3 py-2 font-mono text-xs"
      />
      <label className="mt-4 flex flex-col gap-1.5">
        <span className="label">{t('sw.instructions')}</span>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={2}
          placeholder={t('sw.instructionsPlaceholder')}
          className="field px-3 py-2 text-sm"
        />
      </label>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button onClick={() => void saveMeta()} disabled={busy !== null} className={secondaryBtn} style={secondaryStyle}>
          {busy === 'save' ? t('common.loading') : t('common.save')}
        </button>
        <button onClick={() => void analyze()} disabled={busy !== null || pine.trim().length < 10} className="btn-primary px-4 py-2 text-sm">
          {busy === 'analyze' ? t('sw.analyzing') : t('sw.analyze')}
        </button>
        <span className="text-[11px]" style={{ color: 'var(--color-mut)' }}>{t('sw.analyzeCostHint')}</span>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorBox message={error} />
        </div>
      )}
      {analysis && <AnalysisView analysis={analysis} />}
    </Panel>
  );
}

// ── Dialog ──────────────────────────────────────────────────────────────────

function ChatPanel({ session, messages, onChanged }: { session: SessionDetail['session']; messages: Message[]; onChanged: () => void }) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const message = input.trim();
    if (!message) return;
    setBusy(true);
    setError(null);
    try {
      const res = await trpc.workshop.chat.mutate({ id: session.id, message });
      setInput('');
      if (res.dslErrors.length > 0) setError(`${t('sw.proposalInvalid')}: ${res.dslErrors.join(' · ')}`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function apply(messageId: string) {
    setApplyBusy(messageId);
    setError(null);
    try {
      await trpc.workshop.applyProposal.mutate({ id: session.id, messageId });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setApplyBusy(null);
    }
  }

  return (
    <Panel label={t('sw.chatTitle')} stagger={2}>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('sw.chatHint')}</p>
      <div className="mt-4 flex max-h-[28rem] flex-col gap-3 overflow-y-auto pr-1">
        {messages.length === 0 && <Empty text={t('sw.chatEmpty')} />}
        {messages.map((m) => (
          <div key={m.id} className={`max-w-[85%] ${m.role === 'user' ? 'self-end' : 'self-start'}`}>
            <div
              className="rounded-[0.875rem] border px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap"
              style={
                m.role === 'user'
                  ? { borderColor: 'rgba(79,209,255,0.35)', background: 'rgba(46,124,246,0.12)' }
                  : { borderColor: 'rgba(139,92,246,0.35)', background: 'rgba(139,92,246,0.08)' }
              }
            >
              {m.content}
            </div>
            {m.role === 'assistant' && m.proposedDsl != null && (
              <div className="mt-1.5 flex items-center gap-2">
                <button onClick={() => void apply(m.id)} disabled={applyBusy !== null} className={secondaryBtn} style={secondaryStyle}>
                  {applyBusy === m.id ? t('common.loading') : t('sw.applyProposal')}
                </button>
                <span className="text-[10px]" style={{ color: 'var(--color-mut)' }}>{t('sw.proposalHint')}</span>
              </div>
            )}
          </div>
        ))}
        {busy && <p className="label animate-pulse self-start">{t('sw.coachThinking')}</p>}
      </div>
      {error && (
        <div className="mt-3">
          <ErrorBox message={error} />
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder={t('sw.chatPlaceholder')}
          className="field flex-1 px-3 py-2 text-sm"
        />
        <button onClick={() => void send()} disabled={busy || input.trim().length === 0} className="btn-primary self-end px-4 py-2 text-sm">
          {t('sw.send')}
        </button>
      </div>
    </Panel>
  );
}

// ── Backtest + Vergleich ────────────────────────────────────────────────────

function TradesTable({ trades }: { trades: TradeRow[] }) {
  const { t } = useTranslation();
  if (trades.length === 0) return <Empty text={t('sw.noTrades')} />;
  return (
    <div className="mt-3 max-h-80 overflow-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="label text-left">
            <th className="py-1 pr-3 font-normal">{t('sw.thEntry')}</th>
            <th className="py-1 pr-3 font-normal">{t('sw.thDirection')}</th>
            <th className="py-1 pr-3 text-right font-normal">R</th>
            <th className="py-1 pr-3 text-right font-normal">{t('sw.thNet')}</th>
            <th className="py-1 pr-3 text-right font-normal">{t('sw.thFees')}</th>
            <th className="py-1 font-normal">{t('sw.thExit')}</th>
          </tr>
        </thead>
        <tbody className="num">
          {trades.slice().reverse().map((tr, i) => (
            <tr key={i} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
              <td className="py-1 pr-3">{new Date(tr.entryTs).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</td>
              <td className="py-1 pr-3">{tr.direction}</td>
              <td className="py-1 pr-3 text-right" style={{ color: tr.rMultiple >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>{fmt(tr.rMultiple)}</td>
              <td className="py-1 pr-3 text-right" style={{ color: tr.netPnl >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>{fmt(tr.netPnl)} $</td>
              <td className="py-1 pr-3 text-right">{fmt(tr.fees)} $</td>
              <td className="py-1">{tr.exitReason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function metricsCards(m: Metrics, t: (k: string) => string) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <MetricCard label={t('sw.mNetReturn')} value={`${fmt(m.netReturnPct, 1)} %`} tone={m.netReturnPct >= 0 ? 'pos' : 'neg'} />
      <MetricCard label={t('sw.mWinRate')} value={m.winRate === null ? '—' : `${fmt(m.winRate * 100, 1)} %`} />
      <MetricCard label="Sharpe" value={fmt(m.sharpe)} />
      <MetricCard label={t('sw.mMaxDd')} value={`${fmt(m.maxDrawdownPct, 1)} %`} tone="neg" />
      <MetricCard label={t('sw.mTrades')} value={String(m.tradeCount)} />
    </div>
  );
}

function BacktestPanel({
  session,
  draft,
  universe,
  runs,
  onChanged,
}: {
  session: SessionDetail['session'];
  draft: Dsl | null;
  universe: string[];
  runs: BacktestRow[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [symbol, setSymbol] = useState(draft?.symbol ?? 'BTC/USDT');
  const [timeframe, setTimeframe] = useState(draft?.timeframe ?? '1h');
  const [from, setFrom] = useState(isoDate(new Date(Date.now() - 180 * 86_400_000)));
  const [to, setTo] = useState(isoDate(new Date()));
  const [riskPct, setRiskPct] = useState(1);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [compare, setCompare] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (draft) {
      setSymbol(draft.symbol);
      setTimeframe(draft.timeframe);
    }
  }, [draft?.symbol, draft?.timeframe]);

  const symbols = useMemo(() => (universe.includes(symbol) ? universe : [symbol, ...universe]), [universe, symbol]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await trpc.workshop.runBacktest.mutate({
        id: session.id,
        label: label || undefined,
        symbol,
        timeframe: timeframe as never,
        from: new Date(`${from}T00:00:00Z`).toISOString(),
        to: new Date(`${to}T23:59:59Z`).toISOString(),
        riskPctPerTrade: riskPct,
      });
      setResult(res);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const doneRuns = runs.filter((r) => r.status === 'done');
  const compared = doneRuns
    .filter((r) => compare[r.id])
    .map((r, i) => ({
      key: r.id,
      label: r.label ?? `${r.symbol}@${r.timeframe} ${new Date(r.createdAt).toLocaleDateString('de-DE')}`,
      color: COMPARE_COLORS[i % COMPARE_COLORS.length]!,
      equityCurve: (r.equityCurve ?? []) as { ts: string; equity: number }[],
    }));

  return (
    <Panel label={t('sw.backtestTitle')} stagger={4}>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('sw.backtestHint')}</p>
      {!draft && <Empty text={t('sw.backtestNeedsDraft')} />}
      {draft && (
        <>
          <div className="mt-4 grid gap-4 md:grid-cols-3 lg:grid-cols-6">
            <Select label={t('sw.symbol')} value={symbol} options={symbols.map((s) => ({ value: s, label: s }))} onChange={setSymbol} />
            <Select label={t('sw.timeframe')} value={timeframe} options={CHART_TFS.map((tf) => ({ value: tf, label: tf }))} onChange={setTimeframe} />
            <label className="flex flex-col gap-1.5">
              <span className="label">{t('sw.from')}</span>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="field px-3 py-2 text-sm" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="label">{t('sw.to')}</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="field px-3 py-2 text-sm" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="label">{t('sw.riskPct')}</span>
              <input type="number" step={0.1} min={0.1} max={5} value={riskPct} onChange={(e) => setRiskPct(Number(e.target.value) || 1)} className="field px-3 py-2 text-sm" />
            </label>
            <Field label={t('sw.runLabel')} value={label} onChange={setLabel} placeholder={t('sw.runLabelPlaceholder')} />
          </div>
          <div className="mt-4">
            <button onClick={() => void run()} disabled={busy} className="btn-primary px-4 py-2 text-sm">
              {busy ? t('sw.backtestRunning') : t('sw.runBacktest')}
            </button>
          </div>
          {error && (
            <div className="mt-3">
              <ErrorBox message={error} />
            </div>
          )}
          {result && (
            <div className="mt-5">
              {metricsCards(result.metrics, t)}
              <div className="mt-4">
                <EquityChart points={result.equityCurve} emptyText={t('sw.tooFewPoints')} />
              </div>
              <TradesTable trades={result.trades} />
            </div>
          )}

          {doneRuns.length > 0 && (
            <div className="mt-6">
              <p className="label">{t('sw.compareTitle')}</p>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="label text-left">
                      <th className="py-1 pr-2 font-normal" />
                      <th className="py-1 pr-3 font-normal">{t('sw.runLabel')}</th>
                      <th className="py-1 pr-3 font-normal">{t('sw.symbol')}</th>
                      <th className="py-1 pr-3 text-right font-normal">{t('sw.mNetReturn')}</th>
                      <th className="py-1 pr-3 text-right font-normal">{t('sw.mWinRate')}</th>
                      <th className="py-1 pr-3 text-right font-normal">Sharpe</th>
                      <th className="py-1 pr-3 text-right font-normal">{t('sw.mMaxDd')}</th>
                      <th className="py-1 text-right font-normal">{t('sw.mTrades')}</th>
                    </tr>
                  </thead>
                  <tbody className="num">
                    {doneRuns.map((r) => {
                      const m = r.metrics as Metrics | null;
                      return (
                        <tr key={r.id} style={{ borderTop: '1px solid rgba(99,140,255,0.08)' }}>
                          <td className="py-1 pr-2">
                            <input type="checkbox" checked={compare[r.id] ?? false} onChange={(e) => setCompare({ ...compare, [r.id]: e.target.checked })} />
                          </td>
                          <td className="py-1 pr-3">{r.label ?? new Date(r.createdAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</td>
                          <td className="py-1 pr-3">{r.symbol}@{r.timeframe}</td>
                          <td className="py-1 pr-3 text-right" style={{ color: (m?.netReturnPct ?? 0) >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                            {fmt(m?.netReturnPct, 1)} %
                          </td>
                          <td className="py-1 pr-3 text-right">{m?.winRate == null ? '—' : `${fmt(m.winRate * 100, 1)} %`}</td>
                          <td className="py-1 pr-3 text-right">{fmt(m?.sharpe)}</td>
                          <td className="py-1 pr-3 text-right">{fmt(m?.maxDrawdownPct, 1)} %</td>
                          <td className="py-1 text-right">{m?.tradeCount ?? '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {compared.length > 0 && (
                <div className="mt-4">
                  <MultiEquityChart runs={compared} emptyText={t('sw.tooFewPoints')} />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

// ── Versionen + Deploy ──────────────────────────────────────────────────────

function VersionsPanel({
  session,
  draft,
  versions,
  onChanged,
}: {
  session: SessionDetail['session'];
  draft: Dsl | null;
  versions: VersionRow[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  type Validity = Awaited<ReturnType<typeof trpc.strategies.validity.query>>;
  const [validity, setValidity] = useState<Record<string, Validity>>({});

  async function saveVersion() {
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      const res = await trpc.workshop.saveVersion.mutate({ id: session.id });
      setNotice(t('sw.versionSaved', { n: res.version }));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(null);
    }
  }

  async function restore(versionId: string) {
    setBusy(versionId);
    setError(null);
    try {
      const res = await trpc.workshop.restoreVersion.mutate({ id: session.id, versionId });
      setNotice(t('sw.versionRestored', { n: res.version }));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(null);
    }
  }

  async function checkValidity(versionId: string) {
    setBusy(`validity-${versionId}`);
    setError(null);
    try {
      const v = await trpc.strategies.validity.query({ versionId });
      setValidity((prev) => ({ ...prev, [versionId]: v }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(null);
    }
  }

  async function officialBacktest(versionId: string) {
    if (!session.strategyId || !draft) return;
    setBusy(`bt-${versionId}`);
    setError(null);
    setNotice(null);
    try {
      // Offizieller Labor-Backtest an der Version (Symbol/TF/Setup kommen aus der DSL der Version).
      await trpc.lab.runBacktest.mutate({
        strategyId: session.strategyId,
        symbol: draft.symbol,
        timeframe: draft.timeframe as never,
        setupType: draft.setupType,
        from: new Date(Date.now() - 365 * 86_400_000).toISOString(),
        to: new Date().toISOString(),
        riskPctPerTrade: draft.risk.riskPctPerTrade,
      });
      await checkValidity(versionId);
      setNotice(t('sw.officialBacktestDone'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(null);
    }
  }

  async function promote(versionId: string) {
    setBusy(`promote-${versionId}`);
    setError(null);
    setNotice(null);
    try {
      await trpc.strategies.promote.mutate({ versionId });
      setNotice(t('sw.promoted'));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(null);
    }
  }

  const STATUS_COLOR: Record<string, string> = {
    draft: 'var(--color-mut)',
    paper: 'var(--color-warn)',
    live: 'var(--color-pos)',
    retired: 'var(--color-neg)',
  };

  return (
    <Panel label={t('sw.versionsTitle')} stagger={5}>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('sw.versionsHint')}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button onClick={() => void saveVersion()} disabled={busy !== null || !draft} className="btn-primary px-4 py-2 text-sm">
          {busy === 'save' ? t('common.loading') : t('sw.saveVersion')}
        </button>
        {notice && <span className="text-xs" style={{ color: 'var(--color-pos)' }}>{notice}</span>}
      </div>
      {error && (
        <div className="mt-3">
          <ErrorBox message={error} />
        </div>
      )}
      {versions.length === 0 ? (
        <Empty text={t('sw.noVersions')} />
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {versions.map((v, idx) => {
            const val = validity[v.id];
            const isNewestDraft = idx === 0 && v.status === 'draft';
            return (
              <div key={v.id} className="rounded-[0.625rem] border p-4" style={{ borderColor: 'var(--color-line)' }}>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="num text-sm font-semibold">v{v.version}</span>
                  <span className="rounded-full border px-2.5 py-0.5 text-[10px] uppercase tracking-wider" style={{ borderColor: 'var(--color-line)', color: STATUS_COLOR[v.status] ?? 'var(--color-mut)' }}>
                    {v.status}
                  </span>
                  <span className="text-xs" style={{ color: 'var(--color-mut)' }}>
                    {new Date(v.createdAt).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}
                  </span>
                  <div className="ml-auto flex flex-wrap gap-2">
                    <button onClick={() => void restore(v.id)} disabled={busy !== null} className={secondaryBtn} style={ghostStyle}>
                      {busy === v.id ? t('common.loading') : t('sw.restore')}
                    </button>
                    {v.status === 'draft' && (
                      <>
                        <button onClick={() => void officialBacktest(v.id)} disabled={busy !== null || !isNewestDraft} title={isNewestDraft ? '' : t('sw.onlyNewestHint')} className={secondaryBtn} style={secondaryStyle}>
                          {busy === `bt-${v.id}` ? t('sw.backtestRunning') : t('sw.officialBacktest')}
                        </button>
                        <button onClick={() => void checkValidity(v.id)} disabled={busy !== null} className={secondaryBtn} style={ghostStyle}>
                          {busy === `validity-${v.id}` ? t('common.loading') : t('sw.checkValidity')}
                        </button>
                        <button onClick={() => void promote(v.id)} disabled={busy !== null || !val?.verdict?.passed} title={val?.verdict?.passed ? '' : t('sw.promoteGateHint')} className={secondaryBtn} style={{ borderColor: 'rgba(61,220,151,0.5)', color: 'var(--color-pos)' }}>
                          {busy === `promote-${v.id}` ? t('common.loading') : t('sw.promote')}
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {val && (
                  <p className="mt-2 text-xs leading-relaxed" style={{ color: val.verdict?.passed ? 'var(--color-pos)' : 'var(--color-mut)' }}>
                    {!val.hasBacktest
                      ? t('sw.noOfficialBacktest')
                      : val.verdict?.passed
                        ? t('sw.validityPassed', { n: val.backtest?.tradeCount ?? 0 })
                        : `${t('sw.validityFailed')}: ${val.verdict?.reasons.join(' · ') ?? ''}`}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-4 text-[11px] leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('sw.deployFlowHint')}</p>
    </Panel>
  );
}

// ── Hauptview ───────────────────────────────────────────────────────────────

export function Workshop() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [runs, setRuns] = useState<BacktestRow[]>([]);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [universe, setUniverse] = useState<string[]>(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const loadSessions = useCallback(async () => {
    try {
      const rows = await trpc.workshop.list.query();
      setSessions(rows);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('common.error'));
      setSessions((prev) => prev ?? []);
    }
  }, [t]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const [d, r, v] = await Promise.all([
        trpc.workshop.get.query({ id }),
        trpc.workshop.backtests.query({ id }),
        trpc.workshop.versions.query({ id }),
      ]);
      setDetail(d);
      setRuns(r);
      setVersions(v);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('common.error'));
    }
  }, [t]);

  useEffect(() => {
    void loadSessions();
    void trpc.market.scanUniverse.query().then(setUniverse).catch(() => undefined);
  }, [loadSessions]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else {
      setDetail(null);
      setRuns([]);
      setVersions([]);
    }
  }, [selectedId, loadDetail]);

  const refresh = useCallback(() => {
    void loadSessions();
    if (selectedId) void loadDetail(selectedId);
  }, [loadSessions, loadDetail, selectedId]);

  async function createSession() {
    const name = newName.trim();
    if (name.length < 3) return;
    setCreating(true);
    try {
      const row = await trpc.workshop.create.mutate({ name });
      setNewName('');
      await loadSessions();
      setSelectedId(row.id);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setCreating(false);
    }
  }

  async function removeSession(id: string) {
    try {
      await trpc.workshop.remove.mutate({ id });
      if (selectedId === id) setSelectedId(null);
      await loadSessions();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('common.error'));
    }
  }

  const draft = (detail?.session.draftDsl ?? null) as Dsl | null;

  return (
    <div>
      <PageHeader title={t('sw.title')} subtitle={t('sw.subtitle')} />
      {loadError && <ErrorBox message={loadError} />}

      <Panel label={t('sw.sessions')} stagger={0}>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field label={t('sw.newSessionName')} value={newName} onChange={setNewName} placeholder={t('sw.newSessionPlaceholder')} />
          <button onClick={() => void createSession()} disabled={creating || newName.trim().length < 3} className="btn-primary px-4 py-2 text-sm">
            {creating ? t('common.loading') : t('sw.newSession')}
          </button>
        </div>
        {sessions === null ? (
          <Loading />
        ) : sessions.length === 0 ? (
          <Empty text={t('sw.noSessions')} />
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            {sessions.map((s) => (
              <div key={s.id} className="flex items-center gap-1">
                <button
                  onClick={() => setSelectedId(s.id === selectedId ? null : s.id)}
                  className={secondaryBtn}
                  style={
                    s.id === selectedId
                      ? { borderColor: 'rgba(79,209,255,0.5)', color: 'var(--color-ink)', background: 'rgba(46,124,246,0.14)' }
                      : ghostStyle
                  }
                >
                  {s.name}
                  {s.strategyId && <span className="ml-1.5" style={{ color: 'var(--color-warn)' }} title={t('sw.linkedStrategy')}>◆</span>}
                </button>
                {s.id === selectedId && (
                  <button onClick={() => void removeSession(s.id)} title={t('sw.deleteSession')} className={secondaryBtn} style={{ borderColor: 'rgba(255,92,108,0.4)', color: 'var(--color-neg)' }}>
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>

      {selectedId && detail && (
        <div className="mt-6 flex flex-col gap-6">
          <PinePanel session={detail.session} onChanged={refresh} />
          <ChatPanel session={detail.session} messages={detail.messages} onChanged={refresh} />
          <DraftEditor sessionId={detail.session.id} draft={draft} universe={universe} onSaved={refresh} />
          <BacktestPanel session={detail.session} draft={draft} universe={universe} runs={runs} onChanged={refresh} />
          <VersionsPanel session={detail.session} draft={draft} versions={versions} onChanged={refresh} />
        </div>
      )}
      {selectedId && !detail && <Loading />}
    </div>
  );
}
