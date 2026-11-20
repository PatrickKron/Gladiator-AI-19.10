import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { ensurePriceStream, getLatest, onTick, type TickWithDirection } from '../lib/prices.js';
import { buildWatchlist, isTypingTarget, keyDirection } from '../lib/watchlist.js';
import { isChartVenue, type ChartVenue } from '../lib/chart-url.js';
import { onFavoritesChange } from '../lib/favorites-bus.js';

type WatchItem = { symbol: string; venue: ChartVenue; fav: boolean };

/**
 * Watchlist-Seitenleiste der Markt-Bühne (UI-Welle 4 + Multi-Venue Welle 12):
 * Favoriten ALLER Quellen (Krypto, Aktien, ETFs, Forex, Rohstoffe) zuerst, dann
 * das Scan-Universum, Live-Kurse aus dem Preis-Stream für Binance-Krypto (ehrlich
 * „—“ ohne Tick). Klick oder ↑/↓ (k/j) wechselt Asset samt echter Kursquelle (`venue`).
 */
export function Watchlist({
  value,
  venue = 'binance',
  onSelect,
}: {
  value: string;
  venue?: ChartVenue;
  onSelect: (symbol: string, venue: ChartVenue) => void;
}) {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<WatchItem[]>([{ symbol: value, venue, fav: false }]);
  const [ticks, setTicks] = useState<Map<string, TickWithDirection>>(() => new Map(getLatest().map((x) => [x.symbol, x])));
  const [rev, setRev] = useState(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const valueRef = useRef(value);
  valueRef.current = value;
  const venueRef = useRef(venue);
  venueRef.current = venue;
  const asideRef = useRef<HTMLElement>(null);

  useEffect(() => onFavoritesChange(() => setRev((r) => r + 1)), []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      trpc.market.scanUniverse.query().catch(() => [] as string[]),
      trpc.product.favoriteSymbols.query().catch(() => []),
    ]).then(([universe, favRows]) => {
      if (cancelled) return;
      const out: WatchItem[] = [];
      const seen = new Set<string>();
      const push = (it: WatchItem) => {
        const k = `${it.venue}:${it.symbol}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.push(it);
      };
      // 1. Favoriten ALLER chartbaren Quellen (Binance, Yahoo, Twelve Data) zuerst
      const binanceFavs: string[] = [];
      for (const f of favRows) {
        if (!isChartVenue(f.venue)) continue;
        if (f.venue === 'binance') binanceFavs.push(f.symbol);
        push({ symbol: f.symbol, venue: f.venue, fav: true });
      }
      // 2. Aktuelles Asset immer sichtbar halten
      push({ symbol: valueRef.current, venue: venueRef.current, fav: false });
      // 3. Scan-Universum (Binance) dahinter
      const curBinance = venueRef.current === 'binance' ? valueRef.current : (universe[0] ?? '');
      for (const s of buildWatchlist(universe, binanceFavs, curBinance)) {
        if (!s) continue;
        push({ symbol: s, venue: 'binance', fav: binanceFavs.includes(s) });
      }
      setItems(out);
    });
    return () => {
      cancelled = true;
    };
  }, [rev]);

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
      const list = itemsRef.current;
      if (list.length === 0) return;
      e.preventDefault();
      const idx = list.findIndex((it) => it.symbol === valueRef.current && it.venue === venueRef.current);
      const nextIdx = idx < 0 ? 0 : (idx + dir + list.length) % list.length;
      const target = list[nextIdx]!;
      onSelect(target.symbol, target.venue);
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
      <ul className="mt-2 max-h-[70vh] space-y-0.5 overflow-y-auto pr-0.5">
        {items.map((it) => {
          const tk = it.venue === 'binance' ? ticks.get(it.symbol) : undefined;
          const active = it.symbol === value && it.venue === venue;
          return (
            <li key={`${it.venue}:${it.symbol}`}>
              <button
                type="button"
                onClick={() => onSelect(it.symbol, it.venue)}
                className="num flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs"
                style={{ background: active ? 'rgba(96,165,250,0.12)' : 'transparent', color: active ? 'var(--color-ink)' : 'var(--color-mut)' }}
                aria-current={active ? 'true' : undefined}
              >
                <span className="truncate">
                  {it.fav && <span style={{ color: 'var(--color-warn)' }}>★ </span>}
                  {it.venue === 'binance' ? it.symbol.replace('/USDT', '') : it.symbol}
                </span>
                <span className="shrink-0 text-right">
                  {it.venue !== 'binance' ? (
                    <span className="rounded border px-1 py-0.5 text-[9px]" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
                      {it.venue === 'twelvedata' ? 'TD' : 'YH'}
                    </span>
                  ) : (
                    <>
                      {tk ? tk.price.toLocaleString(i18n.language, { maximumFractionDigits: tk.price >= 1000 ? 0 : tk.price >= 1 ? 2 : 6 }) : '—'}
                      {tk?.changePct24h != null && (
                        <span className="ml-1.5" style={{ color: tk.changePct24h >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>
                          {tk.changePct24h >= 0 ? '+' : ''}
                          {tk.changePct24h.toFixed(1)}%
                        </span>
                      )}
                    </>
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
