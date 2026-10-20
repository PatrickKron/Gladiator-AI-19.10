import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { ensurePriceStream, getLatest, onTick, type TickWithDirection } from '../lib/prices.js';
import { buildWatchlist, isTypingTarget, keyDirection, stepSymbol } from '../lib/watchlist.js';

/**
 * Watchlist-Seitenleiste der Markt-Bühne (UI-Welle 4): Favoriten zuerst, dann
 * das Scan-Universum, Live-Kurse aus dem bestehenden Preis-Stream (ehrlich „—“,
 * solange für ein Symbol kein Tick da ist). Klick oder ↑/↓ (k/j) wechselt das Asset.
 */
export function Watchlist({ value, onSelect }: { value: string; onSelect: (symbol: string) => void }) {
  const { t, i18n } = useTranslation();
  const [list, setList] = useState<string[]>([value]);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [ticks, setTicks] = useState<Map<string, TickWithDirection>>(() => new Map(getLatest().map((x) => [x.symbol, x])));
  const listRef = useRef(list);
  listRef.current = list;
  const valueRef = useRef(value);
  valueRef.current = value;
  const asideRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([trpc.market.scanUniverse.query().catch(() => [] as string[]), trpc.product.favoriteSymbols.query().catch(() => [] as string[])]).then(
      ([universe, favs]) => {
        if (cancelled) return;
        setFavorites(new Set(favs));
        setList(buildWatchlist(universe, favs, valueRef.current));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    ensurePriceStream();
    return onTick((tk) => setTicks((m) => new Map(m).set(tk.symbol, tk)));
  }, []);

  // Tastatur: ↑/↓ bzw. k/j — nie in Eingabefeldern, nie mit Modifikatoren (⌘K-Suche etc.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target as HTMLElement | null)) return;
      // ausgeblendet (schmaler Bildschirm) → Pfeiltasten scrollen normal
      if (!asideRef.current || asideRef.current.offsetParent === null) return;
      const dir = keyDirection(e.key);
      if (dir === null) return;
      e.preventDefault();
      onSelect(stepSymbol(listRef.current, valueRef.current, dir));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSelect]);

  return (
    <aside ref={asideRef} className="glass p-3" aria-label={t('market.watchlist')}>
      <div className="flex items-center justify-between">
        <p className="label">{t('market.watchlist')}</p>
        <span className="text-[10px]" style={{ color: 'var(--color-mut)' }} title={t('market.keysHint')}>
          ↑↓
        </span>
      </div>
      <ul className="mt-2 space-y-0.5">
        {list.map((s) => {
          const tk = ticks.get(s);
          const active = s === value;
          return (
            <li key={s}>
              <button
                type="button"
                onClick={() => onSelect(s)}
                className="num flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs"
                style={{ background: active ? 'rgba(79,209,255,0.12)' : 'transparent', color: active ? 'var(--color-ink)' : 'var(--color-mut)' }}
                aria-current={active ? 'true' : undefined}
              >
                <span className="truncate">
                  {favorites.has(s) && <span style={{ color: 'var(--color-warn)' }}>★ </span>}
                  {s.replace('/USDT', '')}
                </span>
                <span className="text-right">
                  {tk ? tk.price.toLocaleString(i18n.language, { maximumFractionDigits: tk.price >= 1000 ? 0 : tk.price >= 1 ? 2 : 6 }) : '—'}
                  {tk?.changePct24h != null && (
                    <span className="ml-1.5" style={{ color: tk.changePct24h >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                      {tk.changePct24h >= 0 ? '+' : ''}
                      {tk.changePct24h.toFixed(1)}%
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
