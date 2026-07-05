import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { Empty, ErrorBox, Loading, PageHeader, Panel } from '../components/ui.js';

/**
 * Strategie-Builder (09_ §3.14 + §3.5): Registry mit Versionen + Promotion
 * (draft→paper, Mensch im Loop) und drei Wege: Eingebaut / Pine / Anweisung→DSL.
 * Das LLM schaltet NIE scharf — Registrierung nur nach expliziter Bestätigung.
 */

type Strategy = Awaited<ReturnType<typeof trpc.strategies.list.query>>[number];
type Version = Awaited<ReturnType<typeof trpc.strategies.versions.query>>[number];
type DslPreview = Awaited<ReturnType<typeof trpc.strategies.dslPreview.mutate>>;

const KIND_COLOR: Record<string, string> = {
  builtin: 'var(--color-cyan)',
  pine: 'var(--color-warn)',
  dsl: 'var(--color-violet)',
};

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
            <ul className="space-y-2">
              {versions.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="num">
                    v{v.version} ·{' '}
                    <span style={{ color: v.status === 'paper' ? 'var(--color-pos)' : v.status === 'live' ? 'var(--color-cyan)' : 'var(--color-mut)' }}>
                      {v.status}
                    </span>
                  </span>
                  <span className="flex items-center gap-3">
                    {v.status === 'draft' && (
                      <button
                        onClick={() => void promote(v.id)}
                        disabled={busy}
                        className="rounded border px-2 py-1 text-xs disabled:opacity-50"
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
              ))}
            </ul>
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

function DslTab({ onRegistered }: { onRegistered: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [json, setJson] = useState('');
  const [preview, setPreview] = useState<DslPreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'register' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [registered, setRegistered] = useState<number | null>(null);

  async function doPreview() {
    setBusy('preview');
    setError(null);
    setRegistered(null);
    try {
      let dsl: unknown;
      if (json.trim()) {
        try {
          dsl = JSON.parse(json);
        } catch {
          setError(t('builder.dslErrors') + ': JSON');
          return;
        }
      }
      const res = await trpc.strategies.dslPreview.mutate(dsl !== undefined ? { dsl } : { text });
      setPreview(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
      setPreview(null);
    } finally {
      setBusy(null);
    }
  }

  async function doRegister() {
    if (!preview?.ok) return;
    setBusy('register');
    setError(null);
    try {
      const res = await trpc.strategies.dslRegister.mutate({ dsl: preview.dsl });
      setRegistered(res.version);
      setPreview(null);
      setText('');
      setJson('');
      onRegistered();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel label={t('builder.dslTitle')} stagger={2}>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="label">{t('builder.dslTextLabel')}</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            placeholder={t('builder.dslTextPlaceholder')}
            className="field px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="label">{t('builder.dslJsonLabel')}</span>
          <textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            rows={5}
            placeholder='{"id":"btc-london-bos", ...}'
            className="field num px-3 py-2 text-xs"
          />
        </label>
      </div>
      <button
        onClick={() => void doPreview()}
        disabled={busy !== null || (text.trim().length < 10 && json.trim().length < 10)}
        className="btn-primary mt-4 px-5 py-2 text-sm disabled:opacity-50"
      >
        {busy === 'preview' ? t('builder.dslPreviewing') : t('builder.dslPreviewBtn')}
      </button>
      <p className="mt-2 text-[11px]" style={{ color: 'var(--color-mut)' }}>
        {t('builder.dslLlmOff')}
      </p>

      {error && (
        <p className="mt-3 text-xs" style={{ color: 'var(--color-neg)' }}>
          {error}
        </p>
      )}

      {preview && (
        <div className="mt-5 rounded-[0.625rem] border p-4" style={{ borderColor: preview.ok ? 'rgba(139,92,246,0.4)' : 'rgba(255,92,108,0.4)' }}>
          <p className="label">{t('builder.dslPreviewTitle')}</p>
          {preview.llmUsed && (
            <p className="mt-2 text-xs" style={{ color: 'var(--color-warn)' }}>
              {t('builder.dslLlmUsed')}
            </p>
          )}
          <pre className="num mt-3 max-h-72 overflow-auto rounded p-3 text-xs leading-relaxed" style={{ background: 'rgba(4,6,20,0.7)' }}>
            {JSON.stringify(preview.ok ? preview.dsl : preview.draft, null, 2)}
          </pre>
          {!preview.ok && preview.errors.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-medium" style={{ color: 'var(--color-neg)' }}>
                {t('builder.dslErrors')}:
              </p>
              <ul className="mt-1 list-disc pl-5 text-xs" style={{ color: 'var(--color-neg)' }}>
                {preview.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          {preview.ok && (
            <button onClick={() => void doRegister()} disabled={busy !== null} className="btn-primary mt-4 px-5 py-2 text-sm disabled:opacity-50">
              {busy === 'register' ? t('builder.dslRegistering') : t('builder.dslRegisterBtn')}
            </button>
          )}
        </div>
      )}

      {registered !== null && (
        <p className="mt-4 rounded-[0.625rem] border p-3 text-sm" style={{ borderColor: 'rgba(61,220,151,0.4)', color: 'var(--color-pos)' }}>
          ✓ {t('builder.dslRegistered', { version: registered })}
        </p>
      )}
    </Panel>
  );
}

export function Strategien() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'builtin' | 'pine' | 'dsl'>('builtin');
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
    { id: 'builtin' as const, key: 'builder.tabBuiltin' },
    { id: 'pine' as const, key: 'builder.tabPine' },
    { id: 'dsl' as const, key: 'builder.tabDsl' },
  ];

  return (
    <div>
      <PageHeader
        title={t('builder.title')}
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

      {tab === 'pine' && <PineTab onRegistered={() => void load()} />}
      {tab === 'dsl' && <DslTab onRegistered={() => void load()} />}
      {tab === 'builtin' && (
        <Panel stagger={2}>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
            {t('builder.builtinHint')}
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
            {(tab === 'builtin' ? list : list.filter((s) => s.kind === tab)).map((s) => (
              <StrategyRow key={s.id} s={s} onChanged={() => void load()} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
