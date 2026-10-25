import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { rankAssets } from '../lib/asset-search.js';
import { VENUE_LABEL } from './AssetSelect.js';

/**
 * „+ Markt hinzufügen“ auf dem Dashboard (Patrick: „wenn ich bei der Übersicht
 * neue Sachen reinhaben will, krieg ich sie nicht rein“): Inline-Picker über
 * product.allAssets — ALLE Anlageklassen wählbar, client-seitig nach Ticker
 * und Name gefiltert. Bewusst rankAssets aus der Command-Palette wiederverwendet,
 * damit es keine zweite Such-/Ranking-Wahrheit gibt. Ein Klick auf eine Zeile
 * toggelt den echten Stern-Favoriten (product.toggleFavorite) und meldet die
 * Änderung nach oben, damit „Meine Märkte“ sofort neu lädt.
 * Asset-Register (Patrick 2026-10-25: „auch solche, die noch nicht bei uns vertreten
 * sind“): dieselben Suchen wie das Asset-Feld — jedes Binance-Paar (market.symbolSearch)
 * und Aktien/ETF/Indizes/Forex/Futures über Yahoo (market.stockSearch) — ein Klick auf
 * einen Treffer außerhalb des Katalogs ruft product.addAsset: echte Kerzen laden,
 * registrieren, Stern setzen. Danach läuft der Markt im Backend überall mit.
 */

type PickerAsset = Awaited<ReturnType<typeof trpc.product.allAssets.query>>[number];
type BinanceSearch = Awaited<ReturnType<typeof trpc.market.symbolSearch.query>>;
type StockSearch = Awaited<ReturnType<typeof trpc.market.stockSearch.query>>;

// Farbcode je Anlageklasse — identisch zur Command-Palette (dort nicht
// exportiert; gemeinsame Komponenten bleiben laut Auftrag unangetastet).
// Lookup kleingeschrieben: die Live-DB liefert 'CRYPTO'/'STOCK'/'ETF'/… in
// Großbuchstaben, sonst fiele jede Klasse stumm auf die Muted-Farbe zurück.
const TYPE_COLOR: Record<string, string> = {
  crypto: 'var(--color-cyan)',
  stock: 'var(--color-violet)',
  etf: 'var(--color-warn)',
  index: 'var(--color-blue)',
  future: 'var(--color-magenta)',
  commodity: 'var(--color-pos)',
  forex: 'var(--color-cyan)',
  fund: 'var(--color-warn)',
};

function typeColor(assetType: string): string {
  return TYPE_COLOR[assetType.toLowerCase()] ?? 'var(--color-mut)';
}

const rowClass =
  'flex w-full items-center gap-2.5 rounded-[0.625rem] px-2 py-2 text-left transition-colors hover:bg-[rgba(59,130,246,0.12)] disabled:opacity-60';

export function AddMarketPicker({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  // undefined = lädt noch, null = Laden fehlgeschlagen — ehrlich zeigen, kein leerer Fake
  const [assets, setAssets] = useState<PickerAsset[] | null | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null); // null = alle Klassen
  const [busyId, setBusyId] = useState<number | null>(null);
  const [binance, setBinance] = useState<BinanceSearch | null>(null);
  const [stocks, setStocks] = useState<StockSearch | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadCatalog = () =>
    trpc.product.allAssets
      .query()
      .then((rows) => setAssets(rows))
      .catch(() => setAssets(null));

  useEffect(() => {
    void loadCatalog();
    // Fokus direkt ins Suchfeld — wer den Picker öffnet, will tippen, nicht erst klicken
    const id = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(id);
  }, []);

  // Suche über ALLE Quellen (wie AssetSelect, leicht entprellt): Binance ab einem Zeichen, Yahoo ab zwei.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setBinance(null);
      setStocks(null);
      return;
    }
    const id = window.setTimeout(() => {
      void trpc.market.symbolSearch
        .query({ q, limit: 8 })
        .then(setBinance)
        .catch(() => setBinance({ connected: false, total: 0, results: [], error: 'offline' }));
      if (q.length >= 2) {
        void trpc.market.stockSearch
          .query({ q, limit: 8 })
          .then(setStocks)
          .catch(() => setStocks({ connected: false, results: [], error: 'offline' }));
      } else setStocks(null);
    }, 250);
    return () => window.clearTimeout(id);
  }, [query]);

  // Anlageklassen aus den ECHTEN Daten ableiten — kein hartkodierter Katalog,
  // der bei neuen Klassen im Asset-Register stumm veralten würde.
  const types = useMemo(() => [...new Set((assets ?? []).map((a) => a.assetType))].sort(), [assets]);

  const results = useMemo(() => {
    const base = typeFilter === null ? (assets ?? []) : (assets ?? []).filter((a) => a.assetType === typeFilter);
    return rankAssets(base, query, 30);
  }, [assets, query, typeFilter]);

  // Treffer, die schon im Katalog/Register stehen, erscheinen nur oben (dort sitzt ihr Stern).
  const known = useMemo(() => new Set((assets ?? []).filter((a) => a.venue && a.symbol).map((a) => `${a.venue}:${a.symbol}`)), [assets]);
  const binanceHits = query.trim() ? (binance?.results ?? []).filter((r) => !known.has(`binance:${r.symbol}`)) : [];
  const yahooHits = (stocks?.results ?? []).filter((r) => !known.has(`yahoo:${r.symbol}`));

  async function toggle(asset: PickerAsset) {
    setBusyId(asset.id);
    try {
      const res = await trpc.product.toggleFavorite.mutate({ assetId: asset.id });
      // Lokalen Stern-Zustand nachziehen, damit die Liste sofort die Server-Wahrheit zeigt
      setAssets((prev) => (Array.isArray(prev) ? prev.map((a) => (a.id === asset.id ? { ...a, isFavorite: res.favorite } : a)) : prev));
      onChanged();
    } catch {
      // Toggle fehlgeschlagen → Zustand unverändert lassen (kein falscher Stern)
    } finally {
      setBusyId(null);
    }
  }

  async function add(venue: 'binance' | 'yahoo', symbol: string, name?: string, kind?: string) {
    setAdding(`${venue}:${symbol}`);
    setMessage(null);
    try {
      const r = await trpc.product.addAsset.mutate({ venue, symbol, ...(name ? { name } : {}), ...(kind ? { kind } : {}) });
      setMessage({ ok: true, text: t('dashboard.addMarketAdded', { symbol: r.symbol }) });
      await loadCatalog();
      onChanged();
    } catch (e) {
      setMessage({ ok: false, text: t('dashboard.addMarketFailed', { symbol, error: String(e instanceof Error ? e.message : e).slice(0, 160) }) });
    } finally {
      setAdding(null);
    }
  }

  const chip = (active: boolean) => ({
    borderColor: active ? 'rgba(96,165,250,0.6)' : 'var(--color-line)',
    color: active ? 'var(--color-cyan)' : 'var(--color-mut)',
  });
  const busy = busyId !== null || adding !== null;
  const hasHits = binanceHits.length > 0 || yahooHits.length > 0;

  return (
    <div className="glass reveal mb-5 p-4" style={{ '--stagger': 0.5, borderColor: 'rgba(96,165,250,0.35)' } as React.CSSProperties}>
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose(); // gleiche Erwartung wie bei der Command-Palette
          }}
          placeholder={t('dashboard.addMarketSearch')}
          className="field w-full min-w-0 px-3 py-2 text-sm"
        />
        <button
          onClick={onClose}
          className="shrink-0 rounded-[0.625rem] border px-3 py-2 text-xs"
          style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}
        >
          {t('common.close')}
        </button>
      </div>

      {/* Klassen-Filter: alle Anlageklassen bleiben wählbar („Alle“ = kein Filter) */}
      {types.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <button onClick={() => setTypeFilter(null)} className="rounded-full border px-2.5 py-1 text-xs" style={chip(typeFilter === null)}>
            {t('common.all')}
          </button>
          {types.map((ty) => (
            <button key={ty} onClick={() => setTypeFilter(ty)} className="rounded-full border px-2.5 py-1 text-xs" style={chip(typeFilter === ty)}>
              {ty}
            </button>
          ))}
        </div>
      )}

      {adding && (
        <p className="mt-3 animate-pulse text-xs" style={{ color: 'var(--color-cyan)' }}>
          {t('dashboard.addMarketAdding', { symbol: adding.split(':').slice(1).join(':') })}
        </p>
      )}
      {message && (
        <p className="mt-3 text-xs" style={{ color: message.ok ? 'var(--color-pos)' : 'var(--color-neg)' }}>
          {message.text}
        </p>
      )}

      {assets === undefined ? (
        <p className="mt-4 animate-pulse text-sm" style={{ color: 'var(--color-mut)' }}>
          {t('common.loading')}
        </p>
      ) : assets === null ? (
        <p className="mt-4 text-sm" style={{ color: 'var(--color-neg)' }}>
          {t('common.error')}
        </p>
      ) : results.length === 0 && !hasHits && !query.trim() ? (
        <p className="mt-4 text-sm" style={{ color: 'var(--color-mut)' }}>
          {t('palette.empty')}
        </p>
      ) : (
        <div className="mt-3 max-h-80 overflow-y-auto">
          {query.trim() && results.length > 0 && <p className="label px-2 py-1">{t('dashboard.addMarketCatalog')}</p>}
          {results.length > 0 && (
            <ul>
              {results.map((a) => (
                <li key={a.id}>
                  <button onClick={() => void toggle(a)} disabled={busy} title={a.isFavorite ? t('fav.remove') : t('fav.add')} className={rowClass}>
                    <span className="shrink-0 text-base leading-none" style={{ color: a.isFavorite ? 'var(--color-warn)' : 'rgba(139,148,184,0.45)' }}>
                      {busyId === a.id ? '…' : a.isFavorite ? '★' : '☆'}
                    </span>
                    <span className="num w-16 shrink-0 truncate font-medium">{a.ticker}</span>
                    <span className="min-w-0 flex-1 truncate text-sm" style={{ color: 'var(--color-mut)' }}>
                      {a.name}
                    </span>
                    <span className="label shrink-0 rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--color-line)', color: typeColor(a.assetType) }}>
                      {a.assetType}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Noch nicht im System: echte Treffer der Quellen — ein Klick fügt hinzu (Kerzen + Register + Stern). */}
          {query.trim() && (
            <>
              <p className="label mt-2 px-2 py-1">{t('dashboard.addMarketBinance')}</p>
              {binance === null && <p className="px-2 py-1 text-xs" style={{ color: 'var(--color-mut)' }}>{t('common.loading')}</p>}
              {binance?.connected === false && <p className="px-2 py-1 text-xs" style={{ color: 'var(--color-warn)' }}>{t('assetCtx.searchOffline')}</p>}
              {binance?.connected && binanceHits.length === 0 && (
                <p className="px-2 py-1 text-xs" style={{ color: 'var(--color-mut)' }}>{t('assetCtx.noResults', { q: query.trim().toUpperCase() })}</p>
              )}
              <ul>
                {binanceHits.map((r) => (
                  <li key={`bn:${r.symbol}`}>
                    <button onClick={() => void add('binance', r.symbol)} disabled={busy} title={t('dashboard.addMarketAddTitle')} className={rowClass}>
                      <span className="shrink-0 text-base leading-none" style={{ color: 'var(--color-cyan)' }}>
                        {adding === `binance:${r.symbol}` ? '…' : '+'}
                      </span>
                      <span className="num min-w-0 flex-1 truncate font-medium">{r.symbol}</span>
                      <span className="label shrink-0 rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--color-line)', color: typeColor('CRYPTO') }}>
                        {VENUE_LABEL.binance}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>

              {query.trim().length >= 2 && (
                <>
                  <p className="label mt-2 px-2 py-1">{t('dashboard.addMarketYahoo')}</p>
                  {stocks === null && <p className="px-2 py-1 text-xs" style={{ color: 'var(--color-mut)' }}>{t('common.loading')}</p>}
                  {stocks?.connected === false && <p className="px-2 py-1 text-xs" style={{ color: 'var(--color-warn)' }}>{t('assetCtx.yahooOffline')}</p>}
                  {stocks?.connected && yahooHits.length === 0 && (
                    <p className="px-2 py-1 text-xs" style={{ color: 'var(--color-mut)' }}>{t('assetCtx.stocksNoResults', { q: query.trim().toUpperCase() })}</p>
                  )}
                  <ul>
                    {yahooHits.map((r) => (
                      <li key={`yh:${r.symbol}`}>
                        <button onClick={() => void add('yahoo', r.symbol, r.name, r.type)} disabled={busy} title={t('dashboard.addMarketAddTitle')} className={rowClass}>
                          <span className="shrink-0 text-base leading-none" style={{ color: 'var(--color-cyan)' }}>
                            {adding === `yahoo:${r.symbol}` ? '…' : '+'}
                          </span>
                          <span className="num w-20 shrink-0 truncate font-medium">{r.symbol}</span>
                          <span className="min-w-0 flex-1 truncate text-sm" style={{ color: 'var(--color-mut)' }}>
                            {r.name}
                            {r.exchange ? ` · ${r.exchange}` : ''}
                          </span>
                          <span className="chip chip--mut shrink-0 text-[10px]">{t(`assetCtx.kind_${r.type}`, { defaultValue: r.type })}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Klartext statt Rätselraten: was der Stern hier konkret bewirkt (Patrick: klare Beschriftung) */}
      <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('dashboard.addMarketHint')}
      </p>
      <p className="mt-1.5 text-xs leading-relaxed" style={{ color: 'var(--color-mut)' }}>
        {t('dashboard.addMarketNewHint')}
      </p>
    </div>
  );
}
