import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { FavStarSymbol } from './FavStar.js';
import { rankAssets } from '../lib/asset-search.js';
import { buildChartUrl } from '../lib/chart-url.js';
import { loadTf } from '../lib/chart-tf.js';
import { navEntries, searchNav, type NavEntry } from '../lib/navigation.js';

/**
 * Command-Palette (P1.5): globale Suche über ALLE Assets UND alle Seiten/Tabs
 * der Funktions-Registry (Cmd/Ctrl+K) — auch über Synonyme („api key",
 * „binance", „alarm"). Klick/Enter → Chart des Assets (mit gemerktem
 * Timeframe) oder direkt in die Seite bzw. den Tab. Nicht-Krypto/
 * ohne Kerzen wird ehrlich als „kein Chart" markiert und ist nicht anklickbar.
 */

type PaletteAsset = Awaited<ReturnType<typeof trpc.product.allAssets.query>>[number];

const TYPE_COLOR: Record<string, string> = {
  crypto: 'var(--color-cyan)',
  stock: 'var(--color-violet)',
  etf: 'var(--color-warn)',
};

type PaletteEntry = { kind: 'view'; entry: NavEntry } | { kind: 'asset'; asset: PaletteAsset };

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [assets, setAssets] = useState<PaletteAsset[] | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Assets einmalig laden, sobald die Palette zum ersten Mal geöffnet wird.
  useEffect(() => {
    if (!open || assets !== null) return;
    void trpc.product.allAssets.query().then(setAssets).catch(() => setAssets([]));
  }, [open, assets]);

  // Fokus + Reset bei jedem Öffnen.
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      const id = window.setTimeout(() => inputRef.current?.focus(), 20);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  // Seiten + Tabs aus der Funktions-Registry (inkl. Suchbegriffe/Synonyme)
  // und Assets in EINER Trefferliste. Neue Funktionen sind automatisch suchbar.
  const nav = useMemo(() => navEntries(t), [t]);
  const results = useMemo<PaletteEntry[]>(() => {
    const views = searchNav(nav, query, query.trim() === '' ? 6 : 8);
    const rankedAssets = rankAssets(assets ?? [], query, 50);
    return [...views.map((entry) => ({ kind: 'view' as const, entry })), ...rankedAssets.map((asset) => ({ kind: 'asset' as const, asset }))];
  }, [assets, query, nav]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  if (!open) return null;

  const openEntry = (entry: PaletteEntry) => {
    if (entry.kind === 'view') {
      window.location.hash = entry.entry.hash;
      onClose();
      return;
    }
    const a = entry.asset;
    if (!a.hasChart || !a.symbol) return;
    window.location.hash = buildChartUrl(a.symbol, loadTf(a.symbol) ?? '1h');
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      const entry = results[selected];
      if (entry) openEntry(entry);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
      style={{ background: 'rgba(3,4,14,0.72)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="glass w-full max-w-xl overflow-hidden p-0"
        style={{ borderColor: 'rgba(79,209,255,0.35)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--color-line)' }}>
          <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="var(--color-mut)" strokeWidth="1.7" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('palette.placeholder')}
            className="w-full bg-transparent text-sm outline-none"
            style={{ color: 'var(--color-ink)' }}
          />
        </div>

        <div className="max-h-[52vh] overflow-y-auto">
          {assets === null ? (
            <p className="px-4 py-6 text-sm" style={{ color: 'var(--color-mut)' }}>{t('common.loading')}</p>
          ) : results.length === 0 ? (
            <p className="px-4 py-6 text-sm" style={{ color: 'var(--color-mut)' }}>{t('palette.empty')}</p>
          ) : (
            <ul>
              {results.map((entry, i) =>
                entry.kind === 'view' ? (
                  <li
                    key={`view:${entry.entry.hash}`}
                    onMouseEnter={() => setSelected(i)}
                    className="flex items-center gap-2.5 px-3 py-2"
                    style={{ background: i === selected ? 'rgba(46,124,246,0.12)' : 'transparent', cursor: 'pointer' }}
                    onClick={() => openEntry(entry)}
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="var(--color-cyan)" strokeWidth="1.7" strokeLinecap="round">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium" style={{ color: 'var(--color-ink)' }}>{entry.entry.label}</span>
                      <span className="block truncate text-xs" style={{ color: 'var(--color-mut)' }}>{entry.entry.description}</span>
                    </span>
                    <span className="label shrink-0 rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
                      {entry.entry.area}
                    </span>
                  </li>
                ) : (
                  <li
                    key={entry.asset.id}
                    onMouseEnter={() => setSelected(i)}
                    className="flex items-center gap-2 px-3 py-2"
                    style={{ background: i === selected ? 'rgba(46,124,246,0.12)' : 'transparent', cursor: entry.asset.hasChart ? 'pointer' : 'default' }}
                    onClick={() => openEntry(entry)}
                  >
                    {entry.asset.symbol ? (
                      <FavStarSymbol symbol={entry.asset.symbol} initialFavorite={entry.asset.isFavorite} />
                    ) : (
                      <span className="w-5 shrink-0" />
                    )}
                    <span className="num w-16 shrink-0 font-medium">{entry.asset.ticker}</span>
                    <span className="min-w-0 flex-1 truncate text-sm" style={{ color: 'var(--color-mut)' }}>{entry.asset.name}</span>
                    <span
                      className="label shrink-0 rounded border px-1.5 py-0.5"
                      style={{ borderColor: 'var(--color-line)', color: TYPE_COLOR[entry.asset.assetType] ?? 'var(--color-mut)' }}
                    >
                      {entry.asset.assetType}
                    </span>
                    {!entry.asset.hasChart && (
                      <span className="label shrink-0" style={{ color: 'var(--color-mut)' }}>{t('palette.noChart')}</span>
                    )}
                  </li>
                ),
              )}
            </ul>
          )}
        </div>

        <p className="border-t px-4 py-2 text-[11px]" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
          {t('ia.searchHint')}
        </p>
      </div>
    </div>
  );
}
