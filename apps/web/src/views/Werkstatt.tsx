import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader, Panel } from '../components/ui.js';

/**
 * Trading-Agenten-Werkstatt (Sub-Agenten): benutzerdefinierte, autonome Trading-
 * Agenten erstellen, steuern, backtesten. Wie CHAMÆLIEN-Workflows, aber fürs
 * Trading. Paper-Default; ein Agent startet pausiert und wird bewusst scharfgeschaltet.
 */

type Agent = Awaited<ReturnType<typeof trpc.subAgents.list.query>>[number];
type Template = Awaited<ReturnType<typeof trpc.subAgents.templates.query>>[number];

const DATA_SOURCES = ['price', 'macro', 'funding', 'calendar', 'news'] as const;
type DataSource = (typeof DATA_SOURCES)[number];

/** Locker getypte Sicht auf die (serverseitig via Zod validierte) Spec — für Formular-Mapping. */
type SpecShape = {
  side: 'long' | 'short';
  setupType: 'scalp' | 'swing' | 'position';
  timeframe: '15m' | '1h' | '4h' | '1d';
  dataSources: string[];
  entryRules: {
    price?: { dipFromHighPct?: number; dipLookback?: number; changePct24h?: { gt?: number; lt?: number } };
    macro?: { vix?: { gt?: number; lt?: number }; grsLabel?: '' | 'risk-on' | 'neutral' | 'risk-off' };
    funding?: { rate?: { gt?: number; lt?: number } };
    calendar?: { noHighImpactWithinMin?: number; highImpactWithinMin?: number };
    news?: { anyKeyword?: string[]; withinMin?: number };
  };
  exitRules?: { takeProfitPct?: number; stopLossPct?: number; maxHoldHours?: number; exitOnNewsKeyword?: string[] };
  riskParams?: {
    riskPctPerTrade?: number;
    maxLeverage?: number;
    maxConcurrentPositions?: number;
    maxDailyLossPct?: number;
    cooldownMinutes?: number;
  };
};

const STATUS_COLOR: Record<string, string> = {
  active: 'var(--color-pos)',
  paused: 'var(--color-warn)',
  archived: 'var(--color-mut)',
};

function num(v: string): number | undefined {
  if (v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function cmp(gt: string, lt: string): { gt?: number; lt?: number } | undefined {
  const g = num(gt);
  const l = num(lt);
  if (g === undefined && l === undefined) return undefined;
  const out: { gt?: number; lt?: number } = {};
  if (g !== undefined) out.gt = g;
  if (l !== undefined) out.lt = l;
  return out;
}

function keywords(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Formular-Zustand — spiegelt die Spec, aber flach für Inputs. */
type FormState = {
  name: string;
  thesis: string;
  symbols: string;
  side: 'long' | 'short';
  timeframe: '15m' | '1h' | '4h' | '1d';
  setupType: 'scalp' | 'swing' | 'position';
  ds: Record<DataSource, boolean>;
  dipFromHighPct: string;
  dipLookback: string;
  change24hGt: string;
  change24hLt: string;
  vixGt: string;
  vixLt: string;
  grsLabel: '' | 'risk-on' | 'neutral' | 'risk-off';
  fundingGt: string;
  fundingLt: string;
  noHighImpactWithinMin: string;
  highImpactWithinMin: string;
  newsKeywords: string;
  newsWithinMin: string;
  takeProfitPct: string;
  stopLossPct: string;
  maxHoldHours: string;
  exitNewsKeywords: string;
  riskPctPerTrade: string;
  maxLeverage: string;
  maxConcurrentPositions: string;
  maxDailyLossPct: string;
  cooldownMinutes: string;
};

function emptyForm(): FormState {
  return {
    name: '',
    thesis: '',
    symbols: 'BTC/USDT',
    side: 'long',
    timeframe: '1h',
    setupType: 'swing',
    ds: { price: true, macro: false, funding: false, calendar: false, news: false },
    // Sinnvolle Defaults: ein sofort gültiger, testbarer Dip-Buyer von Grund auf.
    dipFromHighPct: '5',
    dipLookback: '30',
    change24hGt: '',
    change24hLt: '',
    vixGt: '',
    vixLt: '',
    grsLabel: '',
    fundingGt: '',
    fundingLt: '',
    noHighImpactWithinMin: '',
    highImpactWithinMin: '',
    newsKeywords: '',
    newsWithinMin: '120',
    takeProfitPct: '10',
    stopLossPct: '5',
    maxHoldHours: '',
    exitNewsKeywords: '',
    riskPctPerTrade: '1',
    maxLeverage: '1',
    maxConcurrentPositions: '1',
    maxDailyLossPct: '5',
    cooldownMinutes: '60',
  };
}

/** Formular ⇢ (meta, spec) für create/update. */
function buildPayload(f: FormState) {
  const entryRules: Record<string, unknown> = {};
  if (f.ds.price) {
    const price: Record<string, unknown> = {};
    if (num(f.dipFromHighPct) !== undefined) {
      price.dipFromHighPct = num(f.dipFromHighPct);
      if (num(f.dipLookback) !== undefined) price.dipLookback = num(f.dipLookback);
    }
    const c = cmp(f.change24hGt, f.change24hLt);
    if (c) price.changePct24h = c;
    if (Object.keys(price).length > 0) entryRules.price = price;
  }
  if (f.ds.macro) {
    const macro: Record<string, unknown> = {};
    const v = cmp(f.vixGt, f.vixLt);
    if (v) macro.vix = v;
    if (f.grsLabel) macro.grsLabel = f.grsLabel;
    if (Object.keys(macro).length > 0) entryRules.macro = macro;
  }
  if (f.ds.funding) {
    const fr = cmp(f.fundingGt, f.fundingLt);
    if (fr) entryRules.funding = { rate: fr };
  }
  if (f.ds.calendar) {
    const cal: Record<string, unknown> = {};
    if (num(f.noHighImpactWithinMin) !== undefined) cal.noHighImpactWithinMin = num(f.noHighImpactWithinMin);
    if (num(f.highImpactWithinMin) !== undefined) cal.highImpactWithinMin = num(f.highImpactWithinMin);
    if (Object.keys(cal).length > 0) entryRules.calendar = cal;
  }
  if (f.ds.news) {
    const kw = keywords(f.newsKeywords);
    if (kw.length > 0) entryRules.news = { anyKeyword: kw, withinMin: num(f.newsWithinMin) ?? 120 };
  }

  const exitRules: Record<string, unknown> = {
    takeProfitPct: num(f.takeProfitPct) ?? 10,
    stopLossPct: num(f.stopLossPct) ?? 5,
  };
  if (num(f.maxHoldHours) !== undefined) exitRules.maxHoldHours = num(f.maxHoldHours);
  const exitKw = keywords(f.exitNewsKeywords);
  if (exitKw.length > 0) exitRules.exitOnNewsKeyword = exitKw;

  const dataSources = DATA_SOURCES.filter((d) => f.ds[d]);

  return {
    name: f.name,
    thesis: f.thesis || undefined,
    symbols: keywords(f.symbols),
    spec: {
      side: f.side,
      setupType: f.setupType,
      timeframe: f.timeframe,
      dataSources,
      entryRules,
      exitRules,
      riskParams: {
        riskPctPerTrade: num(f.riskPctPerTrade) ?? 1,
        maxLeverage: num(f.maxLeverage) ?? 1,
        maxConcurrentPositions: num(f.maxConcurrentPositions) ?? 1,
        maxDailyLossPct: num(f.maxDailyLossPct) ?? 5,
        cooldownMinutes: num(f.cooldownMinutes) ?? 60,
      },
    },
  };
}

/** Agent (DTO) ⇢ Formular (zum Bearbeiten). */
function formFromAgent(a: Agent): FormState {
  const f = emptyForm();
  const spec = a.spec as unknown as SpecShape;
  f.name = a.name;
  f.thesis = a.thesis ?? '';
  f.symbols = a.symbols.join(', ');
  f.side = spec.side;
  f.timeframe = spec.timeframe;
  f.setupType = spec.setupType;
  for (const d of DATA_SOURCES) f.ds[d] = (spec.dataSources as string[]).includes(d);
  const e = spec.entryRules ?? {};
  if (e.price) {
    if (e.price.dipFromHighPct !== undefined) f.dipFromHighPct = String(e.price.dipFromHighPct);
    if (e.price.dipLookback !== undefined) f.dipLookback = String(e.price.dipLookback);
    if (e.price.changePct24h?.gt !== undefined) f.change24hGt = String(e.price.changePct24h.gt);
    if (e.price.changePct24h?.lt !== undefined) f.change24hLt = String(e.price.changePct24h.lt);
  }
  if (e.macro) {
    if (e.macro.vix?.gt !== undefined) f.vixGt = String(e.macro.vix.gt);
    if (e.macro.vix?.lt !== undefined) f.vixLt = String(e.macro.vix.lt);
    if (e.macro.grsLabel) f.grsLabel = e.macro.grsLabel;
  }
  if (e.funding?.rate) {
    if (e.funding.rate.gt !== undefined) f.fundingGt = String(e.funding.rate.gt);
    if (e.funding.rate.lt !== undefined) f.fundingLt = String(e.funding.rate.lt);
  }
  if (e.calendar) {
    if (e.calendar.noHighImpactWithinMin !== undefined) f.noHighImpactWithinMin = String(e.calendar.noHighImpactWithinMin);
    if (e.calendar.highImpactWithinMin !== undefined) f.highImpactWithinMin = String(e.calendar.highImpactWithinMin);
  }
  if (e.news?.anyKeyword) {
    f.newsKeywords = e.news.anyKeyword.join(', ');
    f.newsWithinMin = String(e.news.withinMin ?? 120);
  }
  const x = spec.exitRules ?? {};
  f.takeProfitPct = String(x.takeProfitPct ?? 10);
  f.stopLossPct = String(x.stopLossPct ?? 5);
  if (x.maxHoldHours !== undefined) f.maxHoldHours = String(x.maxHoldHours);
  if (x.exitOnNewsKeyword) f.exitNewsKeywords = x.exitOnNewsKeyword.join(', ');
  const r = spec.riskParams ?? {};
  f.riskPctPerTrade = String(r.riskPctPerTrade ?? 1);
  f.maxLeverage = String(r.maxLeverage ?? 1);
  f.maxConcurrentPositions = String(r.maxConcurrentPositions ?? 1);
  f.maxDailyLossPct = String(r.maxDailyLossPct ?? 5);
  f.cooldownMinutes = String(r.cooldownMinutes ?? 60);
  return f;
}

function formFromTemplate(tpl: Template): FormState {
  const f = emptyForm();
  const spec = tpl.spec as unknown as SpecShape;
  f.name = tpl.name;
  f.thesis = tpl.thesis;
  f.symbols = tpl.symbols.join(', ');
  f.side = spec.side;
  f.timeframe = spec.timeframe;
  f.setupType = spec.setupType;
  for (const d of DATA_SOURCES) f.ds[d] = (spec.dataSources as string[]).includes(d);
  const e = spec.entryRules ?? {};
  if (e.price?.dipFromHighPct !== undefined) f.dipFromHighPct = String(e.price.dipFromHighPct);
  if (e.price?.dipLookback !== undefined) f.dipLookback = String(e.price.dipLookback);
  if (e.price?.changePct24h?.gt !== undefined) f.change24hGt = String(e.price.changePct24h.gt);
  if (e.price?.changePct24h?.lt !== undefined) f.change24hLt = String(e.price.changePct24h.lt);
  if (e.macro?.vix?.lt !== undefined) f.vixLt = String(e.macro.vix.lt);
  if (e.macro?.vix?.gt !== undefined) f.vixGt = String(e.macro.vix.gt);
  if (e.macro?.grsLabel) f.grsLabel = e.macro.grsLabel;
  if (e.funding?.rate?.gt !== undefined) f.fundingGt = String(e.funding.rate.gt);
  if (e.funding?.rate?.lt !== undefined) f.fundingLt = String(e.funding.rate.lt);
  if (e.calendar?.noHighImpactWithinMin !== undefined) f.noHighImpactWithinMin = String(e.calendar.noHighImpactWithinMin);
  if (e.calendar?.highImpactWithinMin !== undefined) f.highImpactWithinMin = String(e.calendar.highImpactWithinMin);
  if (e.news?.anyKeyword) {
    f.newsKeywords = e.news.anyKeyword.join(', ');
    f.newsWithinMin = String(e.news.withinMin ?? 120);
  }
  const x = spec.exitRules ?? {};
  f.takeProfitPct = String(x.takeProfitPct ?? 10);
  f.stopLossPct = String(x.stopLossPct ?? 5);
  if (x.maxHoldHours !== undefined) f.maxHoldHours = String(x.maxHoldHours);
  if (x.exitOnNewsKeyword) f.exitNewsKeywords = x.exitOnNewsKeyword.join(', ');
  const r = spec.riskParams ?? {};
  f.riskPctPerTrade = String(r.riskPctPerTrade ?? 1);
  f.maxLeverage = String(r.maxLeverage ?? 1);
  f.maxConcurrentPositions = String(r.maxConcurrentPositions ?? 1);
  f.maxDailyLossPct = String(r.maxDailyLossPct ?? 5);
  f.cooldownMinutes = String(r.cooldownMinutes ?? 60);
  return f;
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="field px-3 py-2 text-sm" />
    </label>
  );
}

function AgentForm({
  initial,
  templates,
  editingId,
  onSaved,
  onCancel,
}: {
  initial: FormState;
  templates: Template[];
  editingId: string | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [f, setF] = useState<FormState>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Awaited<ReturnType<typeof trpc.subAgents.backtestDraft.mutate>> | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const set = (patch: Partial<FormState>) => setF((prev) => ({ ...prev, ...patch }));
  const toggleDs = (d: DataSource) => setF((prev) => ({ ...prev, ds: { ...prev.ds, [d]: !prev.ds[d] } }));

  async function testDraft() {
    setDraftBusy(true);
    setError(null);
    setDraft(null);
    try {
      const payload = buildPayload(f);
      if (payload.symbols.length === 0) {
        setError(t('workshop.needSymbols'));
        return;
      }
      setDraft(await trpc.subAgents.backtestDraft.mutate({ symbols: payload.symbols, spec: payload.spec as never, days: 30 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setDraftBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const payload = buildPayload(f);
      if (payload.symbols.length === 0) {
        setError(t('workshop.needSymbols'));
        return;
      }
      // Server validiert via subAgentSpecSchema (Zod) — Client-Payload ist bewusst locker getypt.
      if (editingId) await trpc.subAgents.update.mutate({ id: editingId, ...payload } as never);
      else await trpc.subAgents.create.mutate(payload as never);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel label={editingId ? t('workshop.editTitle') : t('workshop.createTitle')} stagger={1}>
      {/* Vorlagen */}
      {!editingId && (
        <div className="mt-3">
          <p className="label mb-2">{t('workshop.templates')}</p>
          <div className="flex flex-wrap gap-2">
            {templates.map((tpl) => (
              <button
                key={tpl.key}
                onClick={() => setF(formFromTemplate(tpl))}
                title={tpl.description}
                className="rounded-[0.625rem] border px-3 py-1.5 text-xs"
                style={{ borderColor: 'rgba(139,92,246,0.4)', color: 'var(--color-violet)' }}
              >
                {tpl.name}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('workshop.fromScratch')}</p>
        </div>
      )}

      {/* Basis */}
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Field label={t('workshop.name')} value={f.name} onChange={(v) => set({ name: v })} placeholder="Mein Dip-Buyer" />
        <Field label={t('workshop.symbols')} value={f.symbols} onChange={(v) => set({ symbols: v })} placeholder="BTC/USDT, ETH/USDT" />
        <label className="flex flex-col gap-1.5 md:col-span-2">
          <span className="label">{t('workshop.thesis')}</span>
          <textarea value={f.thesis} onChange={(e) => set({ thesis: e.target.value })} rows={2} className="field px-3 py-2 text-sm" />
        </label>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <label className="flex flex-col gap-1.5">
          <span className="label">{t('workshop.side')}</span>
          <select value={f.side} onChange={(e) => set({ side: e.target.value as FormState['side'] })} className="field px-3 py-2 text-sm">
            <option value="long">{t('workshop.long')}</option>
            <option value="short">{t('workshop.short')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="label">{t('workshop.timeframe')}</span>
          <select value={f.timeframe} onChange={(e) => set({ timeframe: e.target.value as FormState['timeframe'] })} className="field px-3 py-2 text-sm">
            {(['15m', '1h', '4h', '1d'] as const).map((tf) => (
              <option key={tf} value={tf}>{tf}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="label">{t('workshop.setupType')}</span>
          <select value={f.setupType} onChange={(e) => set({ setupType: e.target.value as FormState['setupType'] })} className="field px-3 py-2 text-sm">
            {(['scalp', 'swing', 'position'] as const).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
      </div>

      {/* Datenquellen */}
      <div className="mt-5">
        <p className="label mb-2">{t('workshop.dataSources')}</p>
        <div className="flex flex-wrap gap-2">
          {DATA_SOURCES.map((d) => (
            <button
              key={d}
              onClick={() => toggleDs(d)}
              className="rounded-[0.625rem] border px-3 py-1.5 text-xs transition-all"
              style={
                f.ds[d]
                  ? { borderColor: 'rgba(79,209,255,0.5)', color: 'var(--color-ink)', background: 'rgba(46,124,246,0.14)' }
                  : { borderColor: 'var(--color-line)', color: 'var(--color-mut)' }
              }
            >
              {t(`workshop.ds_${d}`)}
            </button>
          ))}
        </div>
      </div>

      {/* Einstiegsregeln — je Quelle */}
      <div className="mt-5 rounded-[0.625rem] border p-4" style={{ borderColor: 'var(--color-line)' }}>
        <p className="label mb-3">{t('workshop.entryRules')}</p>
        <div className="grid gap-4 md:grid-cols-2">
          {f.ds.price && (
            <>
              <Field label={t('workshop.dipFromHighPct')} value={f.dipFromHighPct} onChange={(v) => set({ dipFromHighPct: v })} placeholder="7" />
              <Field label={t('workshop.dipLookback')} value={f.dipLookback} onChange={(v) => set({ dipLookback: v })} placeholder="48" />
              <Field label={`${t('workshop.change24h')} — ${t('workshop.gt')}`} value={f.change24hGt} onChange={(v) => set({ change24hGt: v })} placeholder="5" />
              <Field label={`${t('workshop.change24h')} — ${t('workshop.lt')}`} value={f.change24hLt} onChange={(v) => set({ change24hLt: v })} placeholder="-5" />
            </>
          )}
          {f.ds.macro && (
            <>
              <Field label={`VIX — ${t('workshop.gt')}`} value={f.vixGt} onChange={(v) => set({ vixGt: v })} placeholder="30" />
              <Field label={`VIX — ${t('workshop.lt')}`} value={f.vixLt} onChange={(v) => set({ vixLt: v })} placeholder="20" />
              <label className="flex flex-col gap-1.5">
                <span className="label">{t('workshop.grsLabel')}</span>
                <select value={f.grsLabel} onChange={(e) => set({ grsLabel: e.target.value as FormState['grsLabel'] })} className="field px-3 py-2 text-sm">
                  <option value="">—</option>
                  <option value="risk-on">risk-on</option>
                  <option value="neutral">neutral</option>
                  <option value="risk-off">risk-off</option>
                </select>
              </label>
            </>
          )}
          {f.ds.funding && (
            <>
              <Field label={`${t('workshop.fundingRate')} — ${t('workshop.gt')}`} value={f.fundingGt} onChange={(v) => set({ fundingGt: v })} placeholder="0.0005" />
              <Field label={`${t('workshop.fundingRate')} — ${t('workshop.lt')}`} value={f.fundingLt} onChange={(v) => set({ fundingLt: v })} placeholder="-0.0002" />
            </>
          )}
          {f.ds.calendar && (
            <>
              <Field label={t('workshop.noHighImpactWithinMin')} value={f.noHighImpactWithinMin} onChange={(v) => set({ noHighImpactWithinMin: v })} placeholder="120" />
              <Field label={t('workshop.highImpactWithinMin')} value={f.highImpactWithinMin} onChange={(v) => set({ highImpactWithinMin: v })} placeholder="30" />
            </>
          )}
          {f.ds.news && (
            <>
              <Field label={t('workshop.newsKeywords')} value={f.newsKeywords} onChange={(v) => set({ newsKeywords: v })} placeholder="etf approval, listing" />
              <Field label={t('workshop.newsWithinMin')} value={f.newsWithinMin} onChange={(v) => set({ newsWithinMin: v })} placeholder="120" />
            </>
          )}
        </div>
        <p className="mt-3 text-[11px]" style={{ color: 'var(--color-mut)' }}>{t('workshop.entryHint')}</p>
      </div>

      {/* Ausstieg + Risk */}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="rounded-[0.625rem] border p-4" style={{ borderColor: 'var(--color-line)' }}>
          <p className="label mb-3">{t('workshop.exitRules')}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('workshop.takeProfitPct')} value={f.takeProfitPct} onChange={(v) => set({ takeProfitPct: v })} placeholder="10" />
            <Field label={t('workshop.stopLossPct')} value={f.stopLossPct} onChange={(v) => set({ stopLossPct: v })} placeholder="5" />
            <Field label={t('workshop.maxHoldHours')} value={f.maxHoldHours} onChange={(v) => set({ maxHoldHours: v })} placeholder="48" />
            <Field label={t('workshop.exitNewsKeywords')} value={f.exitNewsKeywords} onChange={(v) => set({ exitNewsKeywords: v })} placeholder="hack, ban" />
          </div>
        </div>
        <div className="rounded-[0.625rem] border p-4" style={{ borderColor: 'var(--color-line)' }}>
          <p className="label mb-3">{t('workshop.riskParams')}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('workshop.riskPctPerTrade')} value={f.riskPctPerTrade} onChange={(v) => set({ riskPctPerTrade: v })} placeholder="1" />
            <Field label={t('workshop.maxLeverage')} value={f.maxLeverage} onChange={(v) => set({ maxLeverage: v })} placeholder="1" />
            <Field label={t('workshop.maxConcurrent')} value={f.maxConcurrentPositions} onChange={(v) => set({ maxConcurrentPositions: v })} placeholder="1" />
            <Field label={t('workshop.maxDailyLoss')} value={f.maxDailyLossPct} onChange={(v) => set({ maxDailyLossPct: v })} placeholder="5" />
            <Field label={t('workshop.cooldownMinutes')} value={f.cooldownMinutes} onChange={(v) => set({ cooldownMinutes: v })} placeholder="60" />
          </div>
        </div>
      </div>

      {error && <p className="mt-4 text-sm" style={{ color: 'var(--color-neg)' }}>{error}</p>}

      {/* Sofort-Test des aktuellen Entwurfs (ohne Speichern) */}
      {(draftBusy || draft) && (
        <div className="mt-4 rounded-[0.625rem] border border-dashed p-3" style={{ borderColor: 'rgba(79,209,255,0.3)' }}>
          <p className="label mb-1">{t('workshop.draftResult')}</p>
          {draftBusy ? (
            <span className="text-xs" style={{ color: 'var(--color-mut)' }}>{t('workshop.quickTestRunning')}</span>
          ) : draft ? (
            <QuickResultLine res={draft} />
          ) : null}
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-3">
        <button onClick={() => void submit()} disabled={busy || f.name.trim().length < 2} className="btn-primary px-5 py-2 text-sm disabled:opacity-50">
          {busy ? t('common.saving') : editingId ? t('common.save') : t('workshop.create')}
        </button>
        <button onClick={() => void testDraft()} disabled={draftBusy} className="rounded-[0.625rem] border px-5 py-2 text-sm disabled:opacity-50" style={{ borderColor: 'rgba(79,209,255,0.4)', color: 'var(--color-cyan)' }}>
          {draftBusy ? t('workshop.quickTestRunning') : t('workshop.draftTest')}
        </button>
        <button onClick={onCancel} className="rounded-[0.625rem] border px-5 py-2 text-sm" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
          {t('common.cancel')}
        </button>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('workshop.paperNote')}</p>
    </Panel>
  );
}

function BacktestBox({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const [res, setRes] = useState<Awaited<ReturnType<typeof trpc.subAgents.backtest.mutate>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setRes(await trpc.subAgents.backtest.mutate({ id: agentId, days: 180 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[0.625rem] border p-4" style={{ borderColor: 'var(--color-line)' }}>
      <div className="flex items-center justify-between gap-3">
        <p className="label">{t('workshop.backtestTitle')}</p>
        <button onClick={() => void run()} disabled={busy} className="rounded border px-3 py-1.5 text-xs disabled:opacity-50" style={{ borderColor: 'rgba(79,209,255,0.4)', color: 'var(--color-cyan)' }}>
          {busy ? t('workshop.backtestRunning') : t('workshop.backtestRun')}
        </button>
      </div>
      {error && <p className="mt-2 text-xs" style={{ color: 'var(--color-neg)' }}>{error}</p>}
      {res && 'insufficient' in res && res.insufficient && (
        <p className="mt-3 text-xs" style={{ color: 'var(--color-warn)' }}>{res.detail}</p>
      )}
      {res && 'metrics' in res && !res.insufficient && (
        <div className="mt-3">
          <p className="num text-sm">
            {res.symbol} · {res.candleCount} {t('workshop.candles')} · {res.trades} {t('workshop.trades')}
          </p>
          {res.notBacktestable ? (
            <p className="mt-2 text-xs" style={{ color: 'var(--color-warn)' }}>{t('workshop.notBacktestable')}</p>
          ) : (
            <div className="num mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
              <Metric label={t('workshop.netReturn')} value={`${res.metrics.netReturnPct.toFixed(1)} %`} pos={res.metrics.netReturnPct >= 0} />
              <Metric label={t('workshop.winRate')} value={res.metrics.winRate === null ? '—' : `${(res.metrics.winRate * 100).toFixed(0)} %`} />
              <Metric label={t('workshop.profitFactor')} value={res.metrics.profitFactor === null ? '—' : res.metrics.profitFactor.toFixed(2)} />
              <Metric label={t('workshop.maxDrawdown')} value={`${res.metrics.maxDrawdownPct.toFixed(1)} %`} />
            </div>
          )}
          {!res.priceOnly && res.skippedConditions.length > 0 && (
            <p className="mt-3 text-[11px]" style={{ color: 'var(--color-warn)' }}>
              {t('workshop.skippedTitle')}: {res.skippedConditions.join(' · ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, pos }: { label: string; value: string; pos?: boolean }) {
  return (
    <div>
      <p className="label">{label}</p>
      <p style={pos === undefined ? undefined : { color: pos ? 'var(--color-pos)' : 'var(--color-neg)' }}>{value}</p>
    </div>
  );
}

function AgentDetail({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const [perf, setPerf] = useState<Awaited<ReturnType<typeof trpc.subAgents.performance.query>> | null>(null);
  const [positions, setPositions] = useState<Awaited<ReturnType<typeof trpc.subAgents.positions.query>> | null>(null);
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof trpc.subAgents.runs.query>> | null>(null);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof trpc.subAgents.signalHistory.query>> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      trpc.subAgents.performance.query({ id: agentId }),
      trpc.subAgents.positions.query({ id: agentId }),
      trpc.subAgents.runs.query({ id: agentId, limit: 8 }),
      trpc.subAgents.signalHistory.query({ id: agentId, limit: 10 }),
    ])
      .then(([p, pos, r, h]) => {
        if (cancelled) return;
        setPerf(p);
        setPositions(pos);
        setRuns(r);
        setHistory(h);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      {/* Performance */}
      <div className="rounded-[0.625rem] border p-4" style={{ borderColor: 'var(--color-line)' }}>
        <p className="label mb-3">{t('workshop.performance')}</p>
        {perf === null ? (
          <Loading />
        ) : !('netPnl' in perf) ? (
          <Empty text={t('workshop.noTrades')} />
        ) : (
          <div className="num grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
            <Metric label={t('workshop.netPnl')} value={perf.netPnl.toFixed(2)} pos={perf.netPnl >= 0} />
            <Metric label={t('workshop.trades')} value={String(perf.trades)} />
            <Metric label={t('workshop.winRate')} value={`${((perf.winRate ?? 0) * 100).toFixed(0)} %`} />
            <Metric label={t('workshop.profitFactor')} value={perf.profitFactor === null ? '—' : perf.profitFactor.toFixed(2)} />
            <Metric label={t('workshop.expectancy')} value={perf.expectancyR === null ? '—' : `${perf.expectancyR.toFixed(2)} R`} />
          </div>
        )}
      </div>

      {/* Backtest */}
      <BacktestBox agentId={agentId} />

      {/* Offene Positionen */}
      <div className="rounded-[0.625rem] border p-4" style={{ borderColor: 'var(--color-line)' }}>
        <p className="label mb-3">{t('workshop.positionsTitle')}</p>
        {positions === null ? (
          <Loading />
        ) : positions.length === 0 ? (
          <Empty text={t('common.empty')} />
        ) : (
          <ul className="space-y-2 text-sm">
            {positions.map((p) => (
              <li key={p.id} className="num flex items-center justify-between">
                <span>
                  {p.symbol} <span style={{ color: p.direction === 'long' ? 'var(--color-pos)' : 'var(--color-neg)' }}>{p.direction}</span>
                </span>
                <span style={p.unrealizedPnl === null ? undefined : { color: p.unrealizedPnl >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                  {p.unrealizedPnl === null ? t('common.notConnected') : p.unrealizedPnl.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Läufe */}
      <div className="rounded-[0.625rem] border p-4" style={{ borderColor: 'var(--color-line)' }}>
        <p className="label mb-3">{t('workshop.runsTitle')}</p>
        {runs === null ? (
          <Loading />
        ) : runs.length === 0 ? (
          <Empty text={t('common.empty')} />
        ) : (
          <ul className="space-y-1.5 text-xs">
            {runs.map((r) => (
              <li key={r.id} className="num flex flex-wrap items-center justify-between gap-2">
                <span style={{ color: 'var(--color-mut)' }}>{new Date(r.ranAt).toLocaleString()}</span>
                <span>
                  {t('workshop.signalsShort')} {r.signalsCreated} · {t('workshop.closedShort')} {r.positionsClosed}
                  {r.error && <span style={{ color: 'var(--color-neg)' }}> · {r.error}</span>}
                  {r.note && <span style={{ color: 'var(--color-warn)' }}> · {r.note}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Signal-Historie */}
      <div className="rounded-[0.625rem] border p-4 lg:col-span-2" style={{ borderColor: 'var(--color-line)' }}>
        <p className="label mb-3">{t('workshop.signalHistory')}</p>
        {history === null ? (
          <Loading />
        ) : history.length === 0 ? (
          <Empty text={t('common.empty')} />
        ) : (
          <ul className="space-y-1.5 text-xs">
            {history.map((s) => (
              <li key={s.id} className="num flex flex-wrap items-center justify-between gap-2">
                <span>
                  {new Date(s.createdAt).toLocaleString()} · {s.symbol} ·{' '}
                  <span style={{ color: s.direction === 'long' ? 'var(--color-pos)' : 'var(--color-neg)' }}>{s.direction}</span>
                </span>
                <span style={{ color: 'var(--color-mut)' }}>
                  @ {Number(s.entry).toFixed(2)} · {s.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Kompaktes Ein-Zeilen-Ergebnis eines Schnelltests. */
function QuickResultLine({ res }: { res: Awaited<ReturnType<typeof trpc.subAgents.backtest.mutate>> }) {
  const { t } = useTranslation();
  if ('insufficient' in res && res.insufficient) {
    return <span className="text-xs" style={{ color: 'var(--color-warn)' }}>{res.detail}</span>;
  }
  if (!('metrics' in res)) return null;
  if (res.notBacktestable) {
    return <span className="text-xs" style={{ color: 'var(--color-warn)' }}>{t('workshop.notBacktestable')}</span>;
  }
  const m = res.metrics;
  return (
    <span className="num text-xs">
      <span style={{ color: 'var(--color-mut)' }}>{res.symbol} · 30T · </span>
      {res.trades} {t('workshop.trades')} ·{' '}
      <span style={{ color: m.netReturnPct >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
        {m.netReturnPct >= 0 ? '+' : ''}{m.netReturnPct.toFixed(1)} %
      </span>{' '}
      · {t('workshop.winRate')} {m.winRate === null ? '—' : `${(m.winRate * 100).toFixed(0)} %`}
      {!res.priceOnly && res.skippedConditions.length > 0 && (
        <span style={{ color: 'var(--color-warn)' }}> · {t('workshop.priceOnlyShort')}</span>
      )}
    </span>
  );
}

function AgentCard({ a, onChanged, onEdit }: { a: Agent; onChanged: () => void; onEdit: (a: Agent) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [quick, setQuick] = useState<Awaited<ReturnType<typeof trpc.subAgents.backtest.mutate>> | null>(null);
  const [quickBusy, setQuickBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function setStatus(status: 'active' | 'paused' | 'archived') {
    setBusy(true);
    try {
      await trpc.subAgents.setStatus.mutate({ id: a.id, status });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function quickTest() {
    setQuickBusy(true);
    setActionError(null);
    try {
      setQuick(await trpc.subAgents.backtest.mutate({ id: a.id, days: 30 }));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setQuickBusy(false);
    }
  }

  async function clone() {
    setBusy(true);
    setActionError(null);
    try {
      await trpc.subAgents.duplicate.mutate({ id: a.id });
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setActionError(null);
    try {
      await trpc.subAgents.remove.mutate({ id: a.id });
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('common.error'));
      setBusy(false);
    }
  }

  const btn = 'rounded border px-3 py-1.5 text-xs disabled:opacity-50';
  const btnMut = { borderColor: 'var(--color-line)', color: 'var(--color-mut)' };

  return (
    <li className="rounded-[0.625rem] border p-4" style={{ borderColor: 'var(--color-line)' }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="label rounded border px-1.5 py-0.5" style={{ borderColor: STATUS_COLOR[a.status], color: STATUS_COLOR[a.status] }}>
            {t(`workshop.status_${a.status}`)}
          </span>
          <span className="text-sm font-medium">{a.name}</span>
          <span className="label">{a.symbols.join(', ')}</span>
          <span className="label" style={{ color: 'var(--color-cyan)' }}>{t('common.paper')}</span>
        </div>
        <div className="num flex items-center gap-4 text-xs">
          <span title={t('workshop.netPnl')} style={{ color: a.netPnl >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
            {a.netPnl >= 0 ? '+' : ''}{a.netPnl.toFixed(2)}
          </span>
          <span title={t('workshop.openPositions')}>◉ {a.openPositions}</span>
          <span title={t('workshop.closedTrades')}>✓ {a.closedTrades}</span>
        </div>
      </div>
      {a.thesis && <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>{a.thesis}</p>}
      {a.lastError && <p className="mt-2 text-[11px]" style={{ color: 'var(--color-neg)' }}>{a.lastError}</p>}

      {/* Schnelltest-Ergebnis (30 T) */}
      {(quickBusy || quick) && (
        <div className="mt-2 rounded border border-dashed px-3 py-2" style={{ borderColor: 'rgba(79,209,255,0.3)' }}>
          {quickBusy ? (
            <span className="text-xs" style={{ color: 'var(--color-mut)' }}>{t('workshop.quickTestRunning')}</span>
          ) : quick ? (
            <QuickResultLine res={quick} />
          ) : null}
        </div>
      )}
      {actionError && <p className="mt-2 text-[11px]" style={{ color: 'var(--color-neg)' }}>{actionError}</p>}

      {confirmDel ? (
        <div className="mt-3 rounded-[0.625rem] border p-3" style={{ borderColor: 'rgba(255,92,108,0.4)' }}>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--color-neg)' }}>{t('workshop.confirmDelete')}</p>
          <div className="mt-2 flex gap-2">
            <button onClick={() => void remove()} disabled={busy} className={btn} style={{ borderColor: 'rgba(255,92,108,0.5)', color: 'var(--color-neg)' }}>
              {t('workshop.confirmDeleteYes')}
            </button>
            <button onClick={() => setConfirmDel(false)} disabled={busy} className={btn} style={btnMut}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => void quickTest()} disabled={quickBusy} className={btn} style={{ borderColor: 'rgba(79,209,255,0.4)', color: 'var(--color-cyan)' }}>
            {quickBusy ? t('workshop.quickTestRunning') : t('workshop.quickTest')}
          </button>
          {a.status === 'active' ? (
            <button onClick={() => void setStatus('paused')} disabled={busy} className={btn} style={{ borderColor: 'rgba(255,196,0,0.4)', color: 'var(--color-warn)' }}>
              {t('workshop.pause')}
            </button>
          ) : a.status === 'paused' ? (
            <button onClick={() => void setStatus('active')} disabled={busy} className={btn} style={{ borderColor: 'rgba(61,220,151,0.4)', color: 'var(--color-pos)' }}>
              {t('workshop.activate')}
            </button>
          ) : null}
          <button onClick={() => setOpen((o) => !o)} className={btn} style={btnMut}>
            {open ? t('common.close') : t('workshop.details')}
          </button>
          <button onClick={() => onEdit(a)} className={btn} style={btnMut}>
            {t('workshop.edit')}
          </button>
          <button onClick={() => void clone()} disabled={busy} className={btn} style={btnMut}>
            {t('workshop.clone')}
          </button>
          <button onClick={() => setConfirmDel(true)} disabled={busy} className={btn} style={{ borderColor: 'rgba(255,92,108,0.35)', color: 'var(--color-neg)' }}>
            {t('workshop.delete')}
          </button>
          <span className="label ml-auto self-center">
            {t('workshop.lastRun')}: {a.lastRunAt ? new Date(a.lastRunAt).toLocaleString() : t('workshop.never')}
          </span>
        </div>
      )}

      {open && <AgentDetail agentId={a.id} />}
    </li>
  );
}

export function Werkstatt() {
  const { t } = useTranslation();
  const [list, setList] = useState<Agent[] | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);

  async function load() {
    try {
      const [l, tpls] = await Promise.all([trpc.subAgents.list.query(), trpc.subAgents.templates.query()]);
      setList(l);
      setTemplates(tpls);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const initialForm = useMemo(() => (editing ? formFromAgent(editing) : emptyForm()), [editing]);

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }
  function openEdit(a: Agent) {
    setEditing(a);
    setFormOpen(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function onSaved() {
    setFormOpen(false);
    setEditing(null);
    void load();
  }

  return (
    <div>
      <PageHeader
        title={t('workshop.title')}
        subtitle={t('workshop.subtitle')}
        right={
          !formOpen && (
            <button onClick={openCreate} className="btn-primary px-5 py-2 text-sm">
              + {t('workshop.newAgent')}
            </button>
          )
        }
      />
      {error && <ErrorBox message={error} />}

      {formOpen && (
        <AgentForm
          key={editing?.id ?? 'new'}
          initial={initialForm}
          templates={templates}
          editingId={editing?.id ?? null}
          onSaved={onSaved}
          onCancel={() => {
            setFormOpen(false);
            setEditing(null);
          }}
        />
      )}

      <Panel label={t('workshop.yourAgents')} stagger={2} className="mt-5">
        {list === null ? (
          <Loading />
        ) : list.length === 0 ? (
          <Empty text={t('workshop.noAgents')} />
        ) : (
          <ul className="mt-4 space-y-3">
            {list.map((a) => (
              <AgentCard key={a.id} a={a} onChanged={() => void load()} onEdit={openEdit} />
            ))}
          </ul>
        )}
      </Panel>

      <p className="mt-5 text-[11px] leading-relaxed" style={{ color: 'var(--color-mut)' }}>{t('workshop.autonomyNote')}</p>
    </div>
  );
}
