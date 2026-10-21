import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { EmptyState, PageHeader } from '../components/ui.js';
import { buildChartUrl, CHART_TFS, CHART_VENUES, type ChartTf, type ChartVenue } from '../lib/chart-url.js';
import { cachedCatalog, loadCatalog } from '../lib/indicator-catalog.js';
import { clampNumber, type MenuEntry, type MenuInput } from '../lib/indicator-menu.js';
import {
  COMPARE_OPS,
  CONDITION_KINDS,
  conditionLabel,
  defaultCondition,
  defaultOperand,
  fmtNum,
  MAX_CONDITIONS,
  numericInputs,
  OPERAND_KINDS,
  plotChoices,
  type Condition,
  type ConditionKind,
  type Operand,
  type OperandKind,
} from '../lib/screener-ui.js';

/**
 * Markt-Screener (Repo-Masterliste, Phase 2): Bedingungen aus Indikator-
 * Bibliothek und Smart-Money-Engine über alle Symbole mit echten Kerzen —
 * gerechnet auf dem Server (`screener.run`). Vorlagen, eigene Bedingungen,
 * gespeicherte Screens je Nutzer; Klick auf ein Symbol öffnet den Chart im
 * selben Zeitrahmen.
 */

type RunResult = Awaited<ReturnType<typeof trpc.screener.run.query>>;
type Preset = Awaited<ReturnType<typeof trpc.screener.presets.query>>[number];
type Saved = Awaited<ReturnType<typeof trpc.screener.list.query>>[number];

const TF_KEY = 'gladiator.screener.tf';
const loadTf = (): ChartTf => {
  try {
    const v = localStorage.getItem(TF_KEY);
    return v && (CHART_TFS as readonly string[]).includes(v) ? (v as ChartTf) : '1h';
  } catch {
    return '1h';
  }
};

const selCls = 'field cursor-pointer px-2 py-1 text-xs';
const chipCls = 'rounded border px-2 py-0.5 text-[11px] transition-colors';
const chipStyle = (on: boolean) => ({
  borderColor: on ? 'rgba(96,165,250,0.5)' : 'var(--color-line)',
  color: on ? 'var(--color-cyan)' : 'var(--color-mut)',
  background: on ? 'rgba(96,165,250,0.08)' : 'transparent',
});

function NumBox({ value, min, max, int, onChange, label }: { value: number; min?: number; max?: number; int?: boolean; onChange: (n: number) => void; label: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = clampNumber(draft, { type: int ? 'int' : 'float', min, max }, value);
    setDraft(String(n));
    if (n !== value) onChange(n);
  };
  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      inputMode="decimal"
      aria-label={label}
      className="field num w-20 px-2 py-1 text-center text-xs"
    />
  );
}

function OperandEditor({ value, onChange, catalog }: { value: Operand; onChange: (o: Operand) => void; catalog: MenuEntry[] }) {
  const { t } = useTranslation();
  const standard = useMemo(() => catalog.filter((e) => e.group === 'standard').sort((a, b) => a.name.localeCompare(b.name)), [catalog]);
  const entry = value.kind === 'indicator' ? catalog.find((e) => e.id === value.id) : undefined;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <select value={value.kind} onChange={(e) => onChange(defaultOperand(e.target.value as OperandKind))} className={selCls} aria-label={t('screener.value')}>
        {OPERAND_KINDS.map((k) => (
          <option key={k} value={k}>
            {t(`screener.op_${k}`)}
          </option>
        ))}
      </select>
      {value.kind === 'number' && <NumBox value={value.value} onChange={(n) => onChange({ kind: 'number', value: n })} label={t('screener.value')} />}
      {value.kind === 'change' && (
        <>
          <NumBox value={value.bars} min={1} max={200} int onChange={(n) => onChange({ kind: 'change', bars: n })} label={t('screener.bars')} />
          <span className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
            {t('screener.bars')}
          </span>
        </>
      )}
      {value.kind === 'volume_avg' && (
        <>
          <NumBox value={value.bars} min={2} max={200} int onChange={(n) => onChange({ ...value, bars: n })} label={t('screener.bars')} />
          <span className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
            {t('screener.bars')} · {t('screener.mult')}
          </span>
          <NumBox value={value.mult ?? 1} min={0.01} max={100} onChange={(n) => onChange({ ...value, mult: n })} label={t('screener.mult')} />
        </>
      )}
      {value.kind === 'indicator' && (
        <>
          <select
            value={value.id}
            onChange={(e) => {
              const next = catalog.find((x) => x.id === e.target.value);
              onChange({ kind: 'indicator', id: e.target.value, ...(next ? { plot: plotChoices(next)[0]?.id } : {}) });
            }}
            className={selCls}
            aria-label={t('screener.op_indicator')}
          >
            {standard.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.shortName})
              </option>
            ))}
          </select>
          {entry && plotChoices(entry).length > 1 && (
            <select value={value.plot ?? plotChoices(entry)[0]?.id} onChange={(e) => onChange({ ...value, plot: e.target.value })} className={selCls} aria-label={t('screener.plot')}>
              {plotChoices(entry).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          )}
          {entry &&
            numericInputs(entry).map((inp: MenuInput) => {
              const cur = value.inputs?.[inp.id] ?? entry.defaultInputs[inp.id];
              return (
                <label key={inp.id} className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--color-mut)' }}>
                  {inp.title ?? inp.id}
                  <NumBox
                    value={typeof cur === 'number' ? cur : Number(inp.defval)}
                    min={inp.min}
                    max={inp.max}
                    int={inp.type === 'int'}
                    onChange={(n) => onChange({ ...value, inputs: { ...(value.inputs ?? {}), [inp.id]: n } })}
                    label={inp.title ?? inp.id}
                  />
                </label>
              );
            })}
        </>
      )}
    </span>
  );
}

function ConditionRow({ value, onChange, onRemove, catalog }: { value: Condition; onChange: (c: Condition) => void; onRemove: () => void; catalog: MenuEntry[] }) {
  const { t } = useTranslation();
  const patterns = useMemo(() => catalog.filter((e) => e.group === 'candlestick').sort((a, b) => a.name.localeCompare(b.name)), [catalog]);
  const within = (n: number, onN: (v: number) => void, max = 100) => (
    <label className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--color-mut)' }}>
      {t('screener.withinBars')}
      <NumBox value={n} min={1} max={max} int onChange={onN} label={t('screener.withinBars')} />
      {t('screener.bars')}
    </label>
  );
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border px-2 py-1.5" style={{ borderColor: 'var(--color-line)' }}>
      <select value={value.kind} onChange={(e) => onChange(defaultCondition(e.target.value as ConditionKind))} className={selCls} aria-label={t('screener.conditions')}>
        {CONDITION_KINDS.map((k) => (
          <option key={k} value={k}>
            {t(`screener.kind_${k}`)}
          </option>
        ))}
      </select>
      {value.kind === 'compare' && (
        <>
          <OperandEditor value={value.left} onChange={(left) => onChange({ ...value, left })} catalog={catalog} />
          <select value={value.op} onChange={(e) => onChange({ ...value, op: e.target.value as Condition extends { op: infer O } ? O : never })} className={`${selCls} num`} aria-label="op">
            {COMPARE_OPS.map((op) => (
              <option key={op} value={op}>
                {op === 'crosses_above' || op === 'crosses_below' ? t(`screener.${op}`) : op}
              </option>
            ))}
          </select>
          <OperandEditor value={value.right} onChange={(right) => onChange({ ...value, right })} catalog={catalog} />
        </>
      )}
      {value.kind === 'pattern' && (
        <>
          <select value={value.id} onChange={(e) => onChange({ ...value, id: e.target.value })} className={selCls} aria-label={t('screener.kind_pattern')}>
            {patterns.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          {within(value.withinBars, (n) => onChange({ ...value, withinBars: n }), 50)}
        </>
      )}
      {value.kind === 'structure' && (
        <>
          <select value={value.event} onChange={(e) => onChange({ ...value, event: e.target.value as 'BOS' | 'CHoCH' })} className={selCls} aria-label={t('screener.event')}>
            <option value="BOS">BOS</option>
            <option value="CHoCH">CHoCH</option>
          </select>
          <select
            value={value.direction ?? 'any'}
            onChange={(e) => {
              const d = e.target.value;
              const rest = { ...value };
              delete rest.direction;
              onChange(d === 'any' ? rest : { ...rest, direction: d as 'bullish' | 'bearish' });
            }}
            className={selCls}
            aria-label={t('screener.direction')}
          >
            <option value="any">{t('screener.dir_any')}</option>
            <option value="bullish">{t('screener.dir_bullish')}</option>
            <option value="bearish">{t('screener.dir_bearish')}</option>
          </select>
          {within(value.withinBars, (n) => onChange({ ...value, withinBars: n }))}
        </>
      )}
      {value.kind === 'liquidity' && (
        <>
          <select value={value.what} onChange={(e) => onChange({ ...value, what: e.target.value as typeof value.what })} className={selCls} aria-label={t('screener.kind_liquidity')}>
            {(['sweep_buy_side', 'sweep_sell_side', 'eqh_open', 'eql_open'] as const).map((w) => (
              <option key={w} value={w}>
                {t(`screener.liq_${w}`)}
              </option>
            ))}
          </select>
          {within(value.withinBars, (n) => onChange({ ...value, withinBars: n }))}
        </>
      )}
      {value.kind === 'range' && (
        <select value={value.zone} onChange={(e) => onChange({ ...value, zone: e.target.value as typeof value.zone })} className={selCls} aria-label={t('screener.kind_range')}>
          {(['premium', 'discount', 'equilibrium'] as const).map((z) => (
            <option key={z} value={z}>
              {t(`screener.zone_${z}`)}
            </option>
          ))}
        </select>
      )}
      <button type="button" onClick={onRemove} className="ml-auto px-1 text-sm" style={{ color: 'var(--color-mut)' }} aria-label={t('screener.remove')} title={t('screener.remove')}>
        ✕
      </button>
    </div>
  );
}

export function Screener() {
  const { t } = useTranslation();
  const [tf, setTfState] = useState<ChartTf>(loadTf);
  const setTf = (next: ChartTf) => {
    setTfState(next);
    try {
      localStorage.setItem(TF_KEY, next);
    } catch {
      /* nur Komfort */
    }
  };
  const [venue, setVenue] = useState<ChartVenue>('binance');
  const [catalog, setCatalog] = useState<MenuEntry[] | 'error' | null>(cachedCatalog());
  const [presets, setPresets] = useState<Preset[]>([]);
  const [saved, setSaved] = useState<Saved[] | null>(null);
  const [selectedSaved, setSelectedSaved] = useState<string>('');
  const [name, setName] = useState('');
  const [universe, setUniverse] = useState<number | null>(null);
  const [conditions, setConditions] = useState<Condition[]>([defaultCondition('compare')]);
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [onlyMatches, setOnlyMatches] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const fail = (e: unknown) => setErr(e instanceof Error ? e.message : String(e));

  useEffect(() => {
    let cancelled = false;
    loadCatalog()
      .then((c) => {
        if (!cancelled) setCatalog(c);
      })
      .catch(() => {
        if (!cancelled) setCatalog('error');
      });
    void trpc.screener.presets
      .query()
      .then((p) => {
        if (!cancelled) setPresets(p);
      })
      .catch(fail);
    void trpc.screener.list
      .query()
      .then((s) => {
        if (!cancelled) setSaved(s);
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setUniverse(null);
    void trpc.screener.universe
      .query({ timeframe: tf, venue })
      .then((u) => {
        if (!cancelled) setUniverse(u.length);
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [tf, venue]);

  const entryOf = (id: string) => (Array.isArray(catalog) ? catalog.find((e) => e.id === id) : undefined);

  const run = async () => {
    setRunning(true);
    setErr(null);
    try {
      setResult(await trpc.screener.run.query({ timeframe: tf, conditions, venue }));
    } catch (e) {
      fail(e);
    } finally {
      setRunning(false);
    }
  };

  const applyPreset = (p: Preset) => {
    setConditions(p.conditions as Condition[]);
    setSelectedSaved('');
    setResult(null);
  };
  const loadSaved = (id: string) => {
    setSelectedSaved(id);
    const s = saved?.find((x) => x.id === id);
    if (!s) return;
    setConditions(s.conditions as Condition[]);
    setName(s.name);
    if ((CHART_TFS as readonly string[]).includes(s.timeframe)) setTf(s.timeframe as ChartTf);
    setResult(null);
  };
  const saveScreen = async (asNew: boolean) => {
    const n = name.trim();
    if (!n) return;
    try {
      const row = await trpc.screener.save.mutate({ ...(asNew || !selectedSaved ? {} : { id: selectedSaved }), name: n, timeframe: tf, conditions });
      setSaved((prev) => {
        const list = (prev ?? []).filter((s) => s.id !== row.id);
        return [...list, row].sort((a, b) => a.name.localeCompare(b.name));
      });
      setSelectedSaved(row.id);
      setErr(null);
    } catch (e) {
      fail(e);
    }
  };
  const deleteScreen = async () => {
    const s = saved?.find((x) => x.id === selectedSaved);
    if (!s || !window.confirm(t('screener.deleteConfirm', { name: s.name }))) return;
    try {
      await trpc.screener.remove.mutate({ id: s.id });
      setSaved((prev) => (prev ?? []).filter((x) => x.id !== s.id));
      setSelectedSaved('');
      setErr(null);
    } catch (e) {
      fail(e);
    }
  };

  const rows = useMemo(() => (result ? result.rows.filter((r) => !onlyMatches || r.matches) : []), [result, onlyMatches]);
  const cat = Array.isArray(catalog) ? catalog : [];

  return (
    <div>
      <PageHeader title={t('screener.title')} subtitle={t('screener.subtitle')} />

      <div className="glass mb-4 flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="label">{t('screener.timeframe')}</span>
          {CHART_TFS.map((f) => (
            <button key={f} type="button" onClick={() => setTf(f)} className={`num ${chipCls}`} style={chipStyle(tf === f)}>
              {f}
            </button>
          ))}
          <select value={venue} onChange={(e) => setVenue(e.target.value as ChartVenue)} className={`${selCls} ml-2`} aria-label={t('screener.venue')}>
            {CHART_VENUES.map((v) => (
              <option key={v} value={v}>
                {t(`screener.venue_${v}`)}
              </option>
            ))}
          </select>
          <span className="label ml-2" style={{ color: universe === 0 ? 'var(--color-warn)' : undefined }}>
            {universe === null ? t('screener.loading') : universe === 0 ? t('screener.universeEmpty') : t('screener.universe', { n: universe })}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="label mr-1">{t('screener.presets')}</span>
          {presets.map((p) => (
            <button key={p.id} type="button" onClick={() => applyPreset(p)} className={chipCls} style={chipStyle(false)}>
              {t(p.nameKey)}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="label">{t('screener.saved')}</span>
          <select value={selectedSaved} onChange={(e) => loadSaved(e.target.value)} className={selCls} aria-label={t('screener.saved')}>
            <option value="">{saved === null ? t('screener.loading') : saved.length === 0 ? t('screener.savedNone') : '—'}</option>
            {(saved ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.timeframe}
              </option>
            ))}
          </select>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('screener.namePlaceholder')} maxLength={60} className="field w-48 px-2 py-1 text-xs" aria-label={t('screener.namePlaceholder')} />
          <button type="button" onClick={() => void saveScreen(true)} disabled={!name.trim()} className={`${chipCls} disabled:opacity-40`} style={chipStyle(true)}>
            {t('screener.save')}
          </button>
          {selectedSaved && (
            <>
              <button type="button" onClick={() => void saveScreen(false)} disabled={!name.trim()} className={`${chipCls} disabled:opacity-40`} style={chipStyle(false)}>
                {t('screener.update')}
              </button>
              <button type="button" onClick={() => void deleteScreen()} className={chipCls} style={{ borderColor: 'rgba(239,68,68,0.4)', color: 'var(--color-neg)' }}>
                {t('screener.delete')}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="glass mb-4 flex flex-col gap-2 p-4">
        <p className="label">{t('screener.conditions')}</p>
        {catalog === null && <p className="text-xs" style={{ color: 'var(--color-mut)' }}>{t('screener.loading')}</p>}
        {catalog === 'error' && <p className="text-xs" style={{ color: 'var(--color-neg)' }}>{t('screener.catalogError')}</p>}
        {Array.isArray(catalog) &&
          conditions.map((c, i) => (
            <ConditionRow
              key={i}
              value={c}
              catalog={cat}
              onChange={(next) => setConditions((prev) => prev.map((x, j) => (j === i ? next : x)))}
              onRemove={() => setConditions((prev) => prev.filter((_, j) => j !== i))}
            />
          ))}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setConditions((prev) => [...prev, defaultCondition('compare')])}
            disabled={conditions.length >= MAX_CONDITIONS}
            className={`${chipCls} disabled:opacity-40`}
            style={chipStyle(false)}
            title={conditions.length >= MAX_CONDITIONS ? t('screener.max', { n: MAX_CONDITIONS }) : undefined}
          >
            + {t('screener.add')}
          </button>
          <button
            type="button"
            onClick={() => void run()}
            disabled={running || conditions.length === 0 || !Array.isArray(catalog) || universe === 0}
            className="rounded border px-3 py-1 text-xs disabled:opacity-40"
            style={{ borderColor: 'rgba(96,165,250,0.5)', color: 'var(--color-cyan)', background: 'rgba(96,165,250,0.08)' }}
          >
            {running ? t('screener.running') : `▶ ${t('screener.run')}`}
          </button>
          <label className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-mut)' }}>
            <input type="checkbox" checked={onlyMatches} onChange={(e) => setOnlyMatches(e.target.checked)} className="accent-[#60a5fa]" />
            {t('screener.onlyMatches')}
          </label>
          {result && (
            <span className="label" style={{ color: result.matched > 0 ? 'var(--color-cyan)' : 'var(--color-mut)' }}>
              {t('screener.summary', { matched: result.matched, scanned: result.scanned, ms: result.ms })}
            </span>
          )}
          {err && (
            <span className="label" style={{ color: 'var(--color-neg)' }}>
              {t('screener.error', { msg: err })}
            </span>
          )}
        </div>
      </div>

      <div className="glass p-4">
        {!result && <EmptyState text={t('screener.notRun')} actionLabel={t('screener.notRunCta')} onAction={() => void run()} />}
        {result && rows.length === 0 && <p className="text-sm" style={{ color: 'var(--color-mut)' }}>{t('screener.noMatches')}</p>}
        {result && rows.length > 0 && (
          // Treffer als Karten (Welle C): Symbol, Kurs, Veränderung, je Bedingung ein Chip — Klick öffnet den Chart im selben Zeitrahmen
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {rows.map((r) => (
              <a key={r.symbol} href={buildChartUrl(r.symbol, tf, venue)} className="glass glass-hover block p-4" title={t('screener.openChart')} style={r.matches ? undefined : { opacity: 0.7 }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="num truncate text-base font-semibold">{r.symbol}</p>
                    <p className="num mt-0.5 text-sm" style={{ color: 'var(--color-mut)' }}>
                      {fmtNum(r.close)} <span className="text-xs">· {r.candles} {t('screener.colCandles')}</span>
                    </p>
                  </div>
                  <span className={`chip ${r.changePct == null ? 'chip--mut' : r.changePct >= 0 ? 'chip--pos' : 'chip--neg'}`}>
                    {r.changePct == null ? '—' : `${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(2)} %`}
                  </span>
                </div>
                {r.error && (
                  <p className="mt-2 text-[11px]" style={{ color: 'var(--color-warn)' }}>
                    {r.error}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {conditions.map((c, i) => {
                    const res = r.results?.[i];
                    const label = conditionLabel(c, entryOf, t);
                    if (!res) return <span key={i} className="chip chip--mut" title={label}>— {label}</span>;
                    const text = c.kind === 'compare' ? `${fmtNum(res.left)} / ${fmtNum(res.right)}` : c.kind === 'range' ? `${fmtNum(res.left)} %` : fmtNum(res.left);
                    return (
                      <span key={i} className={`chip ${res.ok ? 'chip--pos' : res.note ? 'chip--warn' : 'chip--mut'}`} title={`${label}${res.note ? ` · ${res.note}` : ''}`}>
                        {res.ok ? '✓' : res.note ? '⚠' : '✗'} <span className="num">{text}</span>
                      </span>
                    );
                  })}
                </div>
              </a>
            ))}
          </div>
        )}
        <p className="label mt-3">{t('screener.hint')}</p>
      </div>
    </div>
  );
}
