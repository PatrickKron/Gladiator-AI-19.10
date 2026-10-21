import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CATEGORY_KEYS, filterCatalog, MAX_INDICATORS_PER_SYMBOL, type MenuEntry } from '../lib/indicator-menu.js';

/**
 * Indikator-Menü am Voll-Chart (Repo-Masterliste, Phase 1): durchsuchbarer
 * Katalog (Standard + Kerzenmuster, serverseitig gerechnet) und — zweiter Tab —
 * die Strategie-Marker (Pine/DSL). Ein Klick fügt den Indikator mit seinen
 * Defaults hinzu; Feinheiten regelt der Einstellungs-Dialog an der Legende.
 */

export type PineStrategy = { slug: string; name: string; kind: 'pine' | 'dsl' };

export function IndicatorMenu({
  open,
  onClose,
  catalog,
  categories,
  activeCount,
  onAdd,
  strategies,
  strategySlugs,
  onToggleStrategy,
  strategySignalCount,
}: {
  open: boolean;
  onClose: () => void;
  /** null = lädt · 'error' = ehrlich nicht ladbar */
  catalog: MenuEntry[] | 'error' | null;
  categories: string[];
  activeCount: number;
  onAdd: (entry: MenuEntry) => Promise<void>;
  strategies: PineStrategy[] | 'error' | null;
  strategySlugs: string[];
  onToggleStrategy: (slug: string) => void;
  strategySignalCount: number;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'library' | 'strategies'>('library');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setTimeout(() => inputRef.current?.focus(), 0);
    // Esc schließt auch, wenn der Fokus auf einem Knopf liegt (nicht nur im Suchfeld).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const results = useMemo(() => (Array.isArray(catalog) ? filterCatalog(catalog, query, category) : []), [catalog, query, category]);
  const full = activeCount >= MAX_INDICATORS_PER_SYMBOL;

  if (!open) return null;

  const add = async (entry: MenuEntry) => {
    if (busy || full) return;
    setBusy(entry.id);
    setErr(null);
    try {
      await onAdd(entry);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && results[0]) void add(results[0]);
  };

  const tabBtn = (key: 'library' | 'strategies', label: string) => (
    <button
      type="button"
      onClick={() => setTab(key)}
      className="border-b-2 px-3 py-2 text-xs transition-colors"
      style={tab === key ? { borderColor: 'var(--color-cyan)', color: 'var(--color-ink)' } : { borderColor: 'transparent', color: 'var(--color-mut)' }}
    >
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[8vh]" style={{ background: 'rgba(3,4,14,0.72)', backdropFilter: 'blur(4px)' }} onClick={onClose}>
      <div role="dialog" aria-label={t('chart.ind.menuTitle')} className="glass w-full max-w-2xl overflow-hidden p-0" style={{ borderColor: 'rgba(79,209,255,0.35)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-4" style={{ borderColor: 'var(--color-line)' }}>
          <div className="flex">
            {tabBtn('library', t('chart.ind.tabLibrary'))}
            {tabBtn('strategies', t('chart.ind.tabStrategies'))}
          </div>
          <button type="button" onClick={onClose} className="px-2 text-sm" style={{ color: 'var(--color-mut)' }} aria-label={t('common.close')}>
            ✕
          </button>
        </div>

        {tab === 'library' && (
          <>
            <div className="flex items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: 'var(--color-line)' }}>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={t('chart.ind.search')}
                className="w-full bg-transparent text-sm outline-none"
                style={{ color: 'var(--color-ink)' }}
                aria-label={t('chart.ind.search')}
              />
              <span className="num shrink-0 text-[11px]" style={{ color: full ? 'var(--color-warn)' : 'var(--color-mut)' }}>
                {activeCount}/{MAX_INDICATORS_PER_SYMBOL}
              </span>
            </div>
            <div className="flex flex-wrap gap-1 border-b px-4 py-2" style={{ borderColor: 'var(--color-line)' }}>
              {[null, ...categories].map((c) => (
                <button
                  key={c ?? 'all'}
                  type="button"
                  onClick={() => setCategory(c)}
                  className="rounded border px-2 py-0.5 text-[11px]"
                  style={{
                    borderColor: category === c ? 'rgba(79,209,255,0.5)' : 'var(--color-line)',
                    color: category === c ? 'var(--color-cyan)' : 'var(--color-mut)',
                    background: category === c ? 'rgba(79,209,255,0.08)' : 'transparent',
                  }}
                >
                  {t(`chart.ind.cat_${c === null ? 'all' : (CATEGORY_KEYS[c] ?? 'all')}`)}
                </button>
              ))}
            </div>
            <div className="max-h-[52vh] overflow-y-auto">
              {catalog === null && <p className="px-4 py-6 text-sm" style={{ color: 'var(--color-mut)' }}>{t('chart.ind.loading')}</p>}
              {catalog === 'error' && <p className="px-4 py-6 text-sm" style={{ color: 'var(--color-neg)' }}>{t('chart.ind.catalogError')}</p>}
              {Array.isArray(catalog) && results.length === 0 && <p className="px-4 py-6 text-sm" style={{ color: 'var(--color-mut)' }}>{t('chart.ind.noResults')}</p>}
              {Array.isArray(catalog) && results.length > 0 && (
                <ul>
                  {results.map((e) => (
                    <li key={e.id} className="flex items-center gap-3 border-b px-4 py-2" style={{ borderColor: 'rgba(99,140,255,0.08)' }}>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm" style={{ color: 'var(--color-ink)' }}>
                          {e.name} <span className="num text-[11px]" style={{ color: 'var(--color-mut)' }}>{e.shortName}</span>
                        </span>
                        <span className="flex flex-wrap gap-1.5 text-[10px]" style={{ color: 'var(--color-mut)' }}>
                          <span>{t(`chart.ind.cat_${CATEGORY_KEYS[e.category] ?? 'all'}`)}</span>
                          <span>· {e.overlay ? t('chart.ind.overlayTag') : t('chart.ind.paneTag')}</span>
                          {e.extraTimeframes.length > 0 && <span>· {t('chart.ind.extraTag', { tfs: e.extraTimeframes.join('/') })}</span>}
                        </span>
                      </span>
                      <button
                        type="button"
                        disabled={full || busy !== null}
                        onClick={() => void add(e)}
                        className="rounded border px-2 py-0.5 text-[11px] transition-colors disabled:opacity-40"
                        style={{ borderColor: 'rgba(79,209,255,0.5)', color: 'var(--color-cyan)' }}
                      >
                        {busy === e.id ? t('chart.ind.adding') : `+ ${t('chart.ind.add')}`}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="border-t px-4 py-2 text-[11px]" style={{ borderColor: 'var(--color-line)', color: err ? 'var(--color-neg)' : 'var(--color-mut)' }}>
              {err ?? (full ? t('chart.ind.limit', { n: MAX_INDICATORS_PER_SYMBOL }) : t('chart.ind.libraryNote'))}
            </div>
          </>
        )}

        {tab === 'strategies' && (
          <div className="px-4 py-3">
            <p className="label mb-1">{t('chart.ind.strategyTitle')}</p>
            <p className="mb-2 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
              {t('chart.ind.pineHint')}
            </p>
            {strategies === null && <p className="text-xs" style={{ color: 'var(--color-mut)' }}>{t('chart.ind.strategiesLoading')}</p>}
            {strategies === 'error' && <p className="text-xs" style={{ color: 'var(--color-neg)' }}>{t('chart.ind.strategiesError')}</p>}
            {Array.isArray(strategies) && strategies.length === 0 && (
              <p className="text-xs" style={{ color: 'var(--color-mut)' }}>
                {t('chart.ind.noStrategies')}{' '}
                <a href="#/strategien" className="underline" style={{ color: 'var(--color-cyan)' }}>
                  {t('chart.ind.openStrategies')}
                </a>
              </p>
            )}
            {Array.isArray(strategies) && strategies.length > 0 && (
              <div className="flex flex-col gap-1.5">
                {strategies.map((s) => (
                  <label key={s.slug} className="flex cursor-pointer items-start gap-2 text-xs">
                    <input type="checkbox" checked={strategySlugs.includes(s.slug)} onChange={() => onToggleStrategy(s.slug)} className="mt-0.5 accent-[#e14ecf]" />
                    <span style={{ color: strategySlugs.includes(s.slug) ? 'var(--color-ink)' : 'var(--color-mut)' }}>
                      {s.name} <span className="num" style={{ color: 'var(--color-mut)' }}>({s.slug})</span>{' '}
                      <span className="rounded border px-1 text-[10px] uppercase" style={{ borderColor: 'var(--color-line)', color: s.kind === 'pine' ? 'var(--color-magenta)' : 'var(--color-violet)' }}>
                        {s.kind}
                      </span>
                    </span>
                  </label>
                ))}
                {strategySlugs.some((slug) => strategies.some((s) => s.slug === slug)) && (
                  <p className="mt-1 text-[11px]" style={{ color: strategySignalCount > 0 ? 'var(--color-mut)' : 'var(--color-warn)' }}>
                    {strategySignalCount > 0 ? t('chart.ind.strategyCount', { n: strategySignalCount }) : t('chart.ind.strategyNone')}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
