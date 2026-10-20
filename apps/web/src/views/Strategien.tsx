import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHashTab } from '../lib/use-hash-tab.js';
import { trpc } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader, Panel } from '../components/ui.js';
import { Workshop } from './Workshop.js';
import { StrategyCatalog } from '../components/StrategyCatalog.js';

/**
 * Strategie-Builder (09_ §3.14 + §3.5): Registry mit Versionen + Promotion
 * (draft→paper, Mensch im Loop) und drei Wege: Eingebaut / Pine / Anweisung→DSL.
 * Das LLM schaltet NIE scharf — Registrierung nur nach expliziter Bestätigung.
 */

type Strategy = Awaited<ReturnType<typeof trpc.strategies.list.query>>[number];
type Version = Awaited<ReturnType<typeof trpc.strategies.versions.query>>[number];

const KIND_COLOR: Record<string, string> = {
  builtin: 'var(--color-cyan)',
  pine: 'var(--color-warn)',
  dsl: 'var(--color-violet)',
};

type Validity = Awaited<ReturnType<typeof trpc.strategies.validity.query>>;

/**
 * Version mit Validitäts-Badge (Vision 5): zeigt, ob ein bestandener Netto-
 * Backtest existiert — nur dann darf die Strategie selbstständig laufen. Der
 * Promote-Button ist ohne bestandenen Backtest gesperrt (Details im Tooltip).
 */
function VersionRow({ v, busy, onPromote }: { v: Version; busy: boolean; onPromote: (id: string) => void }) {
  const { t } = useTranslation();
  const [val, setVal] = useState<Validity | null>(null);

  useEffect(() => {
    let cancelled = false;
    void trpc.strategies.validity
      .query({ versionId: v.id })
      .then((res) => {
        if (!cancelled) setVal(res);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [v.id]);

  const passed = Boolean(val?.hasBacktest && val.verdict?.passed);
  const badge = !val
    ? null
    : !val.hasBacktest
      ? { label: t('builder.noBacktest'), color: 'var(--color-warn)', title: t('builder.noBacktestHint') }
      : passed
        ? { label: t('builder.validated'), color: 'var(--color-pos)', title: checksTitle(val) }
        : { label: t('builder.notValid'), color: 'var(--color-neg)', title: checksTitle(val) };

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="flex items-center gap-2">
        <span className="num">
          v{v.version} ·{' '}
          <span style={{ color: v.status === 'paper' ? 'var(--color-pos)' : v.status === 'live' ? 'var(--color-cyan)' : 'var(--color-mut)' }}>
            {v.status}
          </span>
        </span>
        {badge && (
          <span className="label rounded border px-1.5 py-0.5" style={{ borderColor: badge.color, color: badge.color }} title={badge.title}>
            {badge.label}
          </span>
        )}
        {/* Ehrlich: eine paper-Strategie ohne bestandenen Backtest läuft ungeprüft im Auto-Loop */}
        {v.status === 'paper' && val && !passed && (
          <span className="text-[11px]" style={{ color: 'var(--color-warn)' }} title={t('builder.validityGateHint')}>
            {t('builder.runsUnvalidated')}
          </span>
        )}
      </span>
      <span className="flex items-center gap-3">
        {v.status === 'draft' && (
          <button
            onClick={() => onPromote(v.id)}
            disabled={busy || !passed}
            title={passed ? '' : t('builder.noBacktestHint')}
            className="rounded border px-2 py-1 text-xs disabled:opacity-40"
            style={{ borderColor: 'rgba(61,220,151,0.4)', color: 'var(--color-pos)' }}
          >
            {t('builder.promote')} ({t('builder.promoteDraftToPaper')})
          </button>
        )}
        <a href="#/labor" className="text-xs" style={{ color: 'var(--color-cyan)' }}>
          → {t('builder.backtest')}
        </a>
      </span>
    </li>
  );
}

function checksTitle(val: Validity): string {
  if (!val.verdict) return '';
  return val.verdict.checks.map((c) => `${c.passed ? '✓' : '✗'} ${c.detail}`).join('\n');
}

function StrategyRow({ s, onChanged }: { s: Strategy; onChanged: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      try {
        setVersions(await trpc.strategies.versions.query({ strategyId: s.id }));
      } catch {
        setVersions([]);
      }
    }
  }

  async function promote(versionId: string) {
    setBusy(true);
    setError(null);
    try {
      await trpc.strategies.promote.mutate({ versionId });
      setVersions(await trpc.strategies.versions.query({ strategyId: s.id }));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-[0.625rem] border p-4" style={{ borderColor: 'var(--color-line)' }}>
      <button onClick={() => void toggle()} className="flex w-full flex-wrap items-center justify-between gap-3 text-left">
        <div className="flex items-center gap-3">
          <span
            className="label rounded border px-1.5 py-0.5"
            style={{ borderColor: KIND_COLOR[s.kind] ?? 'var(--color-line)', color: KIND_COLOR[s.kind] ?? 'var(--color-mut)' }}
          >
            {s.kind}
          </span>
          <span className="text-sm font-medium">{s.name}</span>
          <span className="label">{s.slug}</span>
        </div>
        <span className="label">
          {t('builder.createdAt')}: {new Date(s.createdAt).toLocaleDateString()} · {open ? '−' : '+'}
        </span>
      </button>
      {open && (
        <div className="mt-3 border-t pt-3" style={{ borderColor: 'rgba(99,140,255,0.12)' }}>
          {s.description && (
            <p className="mb-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
              {s.description}
            </p>
          )}
          <p className="label mb-2">{t('builder.versions')}</p>
          {versions === null ? (
            <Loading />
          ) : versions.length === 0 ? (
            <Empty text={t('builder.noVersions')} />
          ) : (
            <>
              <ul className="space-y-2">
                {versions.map((v) => (
                  <VersionRow key={v.id} v={v} busy={busy} onPromote={(id) => void promote(id)} />
                ))}
              </ul>
              <p className="mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--color-mut)' }}>
                {t('builder.validityGateHint')}
              </p>
            </>
          )}
          {error && (
            <p className="mt-2 text-xs" style={{ color: 'var(--color-neg)' }}>
              {error}
            </p>
          )}
          <p className="mt-3 text-[11px]" style={{ color: 'var(--color-mut)' }}>
            {t('builder.liveBlocked')}
          </p>
        </div>
      )}
    </li>
  );
}

function PineTab({ onRegistered }: { onRegistered: () => void }) {
  const { t } = useTranslation();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string } | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await trpc.strategies.pineRegister.mutate({
        slug,
        name,
        description: description || undefined,
      });
      setResult({ id: res.strategy.id });
      onRegistered();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel label={t('builder.pineTitle')} stagger={2}>
      <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('builder.pineHint', { url: `${window.location.origin}/api/webhook/pine` })}
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="label">{t('builder.pineSlug')}</span>
          <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="mein-smc-script" className="field px-3 py-2 text-sm" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="label">{t('builder.pineName')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="field px-3 py-2 text-sm" />
        </label>
        <label className="flex flex-col gap-1.5 md:col-span-2">
          <span className="label">{t('builder.pineDescription')}</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="field px-3 py-2 text-sm" />
        </label>
      </div>
      <button
        onClick={() => void submit()}
        disabled={busy || slug.length < 3 || name.length < 3}
        className="btn-primary mt-4 px-5 py-2 text-sm disabled:opacity-50"
      >
        {t('builder.pineRegister')}
      </button>
      {error && (
        <p className="mt-3 text-xs" style={{ color: 'var(--color-neg)' }}>
          {error}
        </p>
      )}
      {result && (
        <div className="mt-4 rounded-[0.625rem] border p-3" style={{ borderColor: 'rgba(61,220,151,0.4)' }}>
          <p className="text-sm" style={{ color: 'var(--color-pos)' }}>
            ✓ {t('builder.pineRegistered')}
          </p>
          <p className="num mt-2 text-sm break-all select-all" style={{ color: 'var(--color-cyan)' }}>
            {result.id}
          </p>
        </div>
      )}
    </Panel>
  );
}

type PineAnalyzeResult = Awaited<ReturnType<typeof trpc.strategies.pineAnalyze.mutate>>;
type PineImproveResult = Awaited<ReturnType<typeof trpc.strategies.pineImprove.mutate>>;

/**
 * Pine-Script einfügen → Struktur-Analyse (immer, regelbasiert) + KI-Erklärung/
 * Verbesserung (nur mit hinterlegtem Anthropic-Key — ehrlich beschriftet).
 * Es wird nichts registriert oder ausgeführt: Ergebnis ist ein Entwurf zum
 * Kopieren nach TradingView (Mensch im Loop).
 */
function PineAnalyzePanel() {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState<'analyze' | 'improve' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<PineAnalyzeResult | null>(null);
  const [improved, setImproved] = useState<PineImproveResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function doAnalyze() {
    setBusy('analyze');
    setError(null);
    setImproved(null);
    try {
      setAnalysis(await trpc.strategies.pineAnalyze.mutate({ code }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
      setAnalysis(null);
    } finally {
      setBusy(null);
    }
  }

  async function doImprove() {
    setBusy('improve');
    setError(null);
    try {
      setImproved(await trpc.strategies.pineImprove.mutate({ code, goal: goal.trim() || undefined }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
      setImproved(null);
    } finally {
      setBusy(null);
    }
  }

  async function copyImproved() {
    if (!improved) return;
    try {
      await navigator.clipboard.writeText(improved.improved);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard verweigert (Browser-Rechte) — kein Drama, Text bleibt markierbar.
    }
  }

  const s = analysis?.structural ?? null;

  return (
    <Panel label={t('builder.pineAnalyzeTitle')} stagger={3} className="mt-5">
      <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('builder.pineAnalyzeIntro')}
      </p>
      <label className="mt-4 flex flex-col gap-1.5">
        <span className="label">{t('builder.pineCodeLabel')}</span>
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          rows={10}
          spellCheck={false}
          placeholder={'//@version=5\nstrategy("Meine Strategie", overlay=true)\n...'}
          className="field num px-3 py-2 text-xs leading-relaxed"
        />
      </label>
      <label className="mt-3 flex flex-col gap-1.5">
        <span className="label">{t('builder.pineGoalLabel')}</span>
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder={t('builder.pineGoalPlaceholder')}
          className="field px-3 py-2 text-sm"
        />
      </label>
      <div className="mt-4 flex flex-wrap gap-2.5">
        <button
          onClick={() => void doAnalyze()}
          disabled={busy !== null || code.trim().length < 20}
          className="btn-primary px-5 py-2 text-sm disabled:opacity-50"
        >
          {busy === 'analyze' ? t('builder.pineAnalyzing') : t('builder.pineAnalyzeBtn')}
        </button>
        <button
          onClick={() => void doImprove()}
          disabled={busy !== null || code.trim().length < 20}
          className="rounded-[0.625rem] border px-5 py-2 text-sm transition-colors disabled:opacity-50"
          style={{ borderColor: 'rgba(139,92,246,0.5)', color: 'var(--color-violet, #8b5cf6)' }}
        >
          {busy === 'improve' ? t('builder.pineImproving') : t('builder.pineImproveBtn')}
        </button>
      </div>

      {error && (
        <p className="mt-3 text-xs" style={{ color: 'var(--color-neg)' }}>
          {error}
        </p>
      )}

      {s && (
        <div className="mt-5 rounded-[0.625rem] border p-4" style={{ borderColor: 'var(--color-line)' }}>
          <p className="label">{t('builder.pineStructTitle')}</p>
          <div className="num mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs md:grid-cols-4">
            <div>
              <p className="label">{t('builder.pineFactVersion')}</p>
              <p className="mt-0.5">{s.version ?? '—'}</p>
            </div>
            <div>
              <p className="label">{t('builder.pineFactType')}</p>
              <p className="mt-0.5">{s.scriptType}</p>
            </div>
            <div>
              <p className="label">{t('builder.pineFactTitle')}</p>
              <p className="mt-0.5 truncate" title={s.title ?? ''}>{s.title ?? '—'}</p>
            </div>
            <div>
              <p className="label">{t('builder.pineFactLines')}</p>
              <p className="mt-0.5">{s.lineCount}</p>
            </div>
            <div>
              <p className="label">{t('builder.pineFactSl')}</p>
              <p className="mt-0.5" style={{ color: s.hasStopLoss ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                {s.hasStopLoss ? '✓' : '✗'}
              </p>
            </div>
            <div>
              <p className="label">{t('builder.pineFactTp')}</p>
              <p className="mt-0.5" style={{ color: s.hasTakeProfit ? 'var(--color-pos)' : 'var(--color-warn)' }}>
                {s.hasTakeProfit ? '✓' : '—'}
              </p>
            </div>
            <div>
              <p className="label">{t('builder.pineFactAlerts')}</p>
              <p className="mt-0.5">{s.alertCount}</p>
            </div>
            <div>
              <p className="label">{t('builder.pineFactHtf')}</p>
              <p className="mt-0.5">{s.securityTimeframes.length > 0 ? s.securityTimeframes.join(', ') : '—'}</p>
            </div>
          </div>

          {s.indicators.length > 0 && (
            <div className="mt-3">
              <p className="label">{t('builder.pineFactIndicators')}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {s.indicators.map((ind) => (
                  <span key={ind} className="num rounded border px-1.5 py-0.5 text-[11px]" style={{ borderColor: 'var(--color-line)', color: 'var(--color-cyan)' }}>
                    ta.{ind}
                  </span>
                ))}
              </div>
            </div>
          )}

          {s.inputs.length > 0 && (
            <div className="mt-3">
              <p className="label">{t('builder.pineFactInputs')}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {s.inputs.map((inp) => (
                  <span key={inp.name} className="num rounded border px-1.5 py-0.5 text-[11px]" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
                    {inp.name}
                    {inp.defval ? ` = ${inp.defval}` : ''}
                  </span>
                ))}
              </div>
            </div>
          )}

          {(s.entryCalls.length > 0 || s.exitCalls.length > 0) && (
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <p className="label">{t('builder.pineFactEntries')} ({s.entryCalls.length})</p>
                <ul className="num mt-1.5 space-y-1 text-[11px]" style={{ color: 'var(--color-mut)' }}>
                  {s.entryCalls.map((c, i) => (
                    <li key={i} className="truncate" title={c}>{c}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="label">{t('builder.pineFactExits')} ({s.exitCalls.length})</p>
                <ul className="num mt-1.5 space-y-1 text-[11px]" style={{ color: 'var(--color-mut)' }}>
                  {s.exitCalls.map((c, i) => (
                    <li key={i} className="truncate" title={c}>{c}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {s.warnings.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-medium" style={{ color: 'var(--color-warn)' }}>
                {t('builder.pineWarnings')}
              </p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-xs" style={{ color: 'var(--color-warn)' }}>
                {s.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {analysis && (
        <div className="mt-4 rounded-[0.625rem] border p-4" style={{ borderColor: analysis.llm.used ? 'rgba(139,92,246,0.4)' : 'var(--color-line)' }}>
          <p className="label">{t('builder.pineLlmTitle')}</p>
          {analysis.llm.used ? (
            <p className="mt-3 text-xs leading-relaxed whitespace-pre-wrap">{analysis.llm.analysis}</p>
          ) : (
            <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-warn)' }}>
              {analysis.llm.hint}
            </p>
          )}
        </div>
      )}

      {improved && (
        <div className="mt-4 rounded-[0.625rem] border p-4" style={{ borderColor: 'rgba(61,220,151,0.4)' }}>
          <div className="flex items-center justify-between gap-3">
            <p className="label">{t('builder.pineImprovedTitle')}</p>
            <button
              onClick={() => void copyImproved()}
              className="rounded border px-2 py-1 text-xs"
              style={{ borderColor: 'var(--color-line)', color: copied ? 'var(--color-pos)' : 'var(--color-cyan)' }}
            >
              {copied ? t('builder.pineCopied') : t('builder.pineCopy')}
            </button>
          </div>
          <pre className="num mt-3 max-h-96 overflow-auto rounded p-3 text-xs leading-relaxed select-all" style={{ background: 'rgba(4,6,20,0.7)' }}>
            {improved.improved}
          </pre>
          {improved.notes && (
            <>
              <p className="label mt-4">{t('builder.pineImproveNotes')}</p>
              <p className="mt-2 text-xs leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--color-mut)' }}>
                {improved.notes}
              </p>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

/** Tabs im Hash — Deep-Link z. B. `#/strategien?tab=pine` (auch über ⌘K-Suche). */
const STRATEGY_TABS = ['katalog', 'workshop', 'builtin', 'pine'] as const;
type StrategyTab = (typeof STRATEGY_TABS)[number];

export function Strategien() {
  const { t } = useTranslation();
  // Katalog zuerst (Patricks „umfassendes Sortiment"); der DSL-Editor-Tab
  // wurde konsolidiert — DSL-Strategien baut man im Strategie-Workshop
  // (iterativ, mit Backtest-Gate), nicht mehr an zwei Orten.
  const [tab, setTab] = useHashTab<StrategyTab>('#/strategien', STRATEGY_TABS, 'katalog');
  const [list, setList] = useState<Strategy[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setList(await trpc.strategies.list.query());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const tabs = [
    { id: 'katalog' as const, key: 'builder.tabCatalog' },
    { id: 'workshop' as const, key: 'builder.tabWorkshop' },
    { id: 'builtin' as const, key: 'builder.tabBuiltin' },
    { id: 'pine' as const, key: 'builder.tabPine' },
  ];

  return (
    <div>
      <PageHeader
        title={t('ia.page_strategies')}
        subtitle={t('builder.subtitle')}
        right={
          <div className="flex gap-2">
            {tabs.map((x) => (
              <button
                key={x.id}
                onClick={() => setTab(x.id)}
                className="rounded-[0.625rem] border px-3.5 py-2 text-sm transition-all"
                style={
                  tab === x.id
                    ? {
                        borderColor: 'rgba(79,209,255,0.5)',
                        color: 'var(--color-ink)',
                        background: 'linear-gradient(92deg, rgba(46,124,246,0.2), rgba(139,92,246,0.14))',
                        boxShadow: '0 0 16px rgba(46,124,246,0.2)',
                      }
                    : { borderColor: 'var(--color-line)', color: 'var(--color-mut)' }
                }
              >
                {t(x.key)}
              </button>
            ))}
          </div>
        }
      />
      {error && <ErrorBox message={error} />}

      {tab === 'pine' && (
        <>
          <PineTab onRegistered={() => void load()} />
          <PineAnalyzePanel />
        </>
      )}
      {tab === 'katalog' && <StrategyCatalog />}
      {tab === 'workshop' && <Workshop embedded />}
      {tab === 'builtin' && (
        <Panel stagger={2}>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
            {t('builder.builtinHint')}
          </p>
          <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
            {t('builder.dslMovedHint')}{' '}
            <a href="#/strategien?tab=workshop" className="underline decoration-dotted" style={{ color: 'var(--color-cyan)' }}>
              {t('nav.strategyWorkshop')}
            </a>
          </p>
        </Panel>
      )}

      {/* Registry: alle Strategien mit Versionen (immer sichtbar) */}
      <Panel label={t('builder.registry')} stagger={3} className="mt-5">
        {list === null ? (
          <Loading />
        ) : list.length === 0 ? (
          <Empty text={t('common.empty')} />
        ) : (
          <ul className="mt-4 space-y-3">
            {(tab === 'pine' ? list.filter((s) => s.kind === 'pine') : list).map((s) => (
              <StrategyRow key={s.id} s={s} onChanged={() => void load()} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
