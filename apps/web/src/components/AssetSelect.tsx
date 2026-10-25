import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { isChartVenue, type ChartVenue } from '../lib/chart-url.js';

/**
 * Asset-Selektor. Seit Patricks Mängelliste (2026-10-22, Punkt 3) ein Suchfeld statt
 * einer Handvoll Optionen: „Meine Märkte“ (★ Favoriten ALLER Quellen + Scan-Universum) zuerst,
 * darunter JEDES Binance-Spot-Paar gegen USDT (live von der Börse). Ein Paar ohne Kerzen wird beim
 * Auswählen nachgeladen (market.ensureCandles — derselbe Backfill wie der Scan), erst dann
 * wechselt das Asset; bei einem Paar mit Kerzen sofort, der Nachlauf läuft im Hintergrund.
 * Aktien/ETF/Forex als dritte Gruppe: schon geladene Symbole (Twelve Data/Yahoo) plus ab
 * zwei Zeichen die Yahoo-Suche ohne Key (market.stockSearch) — Auswahl eines Treffers holt
 * echte Kerzen (market.ensureStockCandles) und wechselt erst dann. Beide Wege tragen das Asset
 * ins Asset-Register ein (Kerzen-Refresh, Alarme, News laufen dann im Backend mit). Nicht
 * erreichbar ⇒ ehrlich „nicht verbunden“. Auswahl in localStorage — Oracle/Aegis beziehen sich darauf.
 */

const STORAGE_KEY = 'gladiator.selectedAsset';
const VENUE_KEY = 'gladiator.selectedVenue';

export function getSelectedAsset(): string {
  return localStorage.getItem(STORAGE_KEY) ?? 'BTC/USDT';
}

/** Ausgewähltes Asset persistieren (z. B. beim Deep-Link-Sprung in Charts). */
export function setSelectedAsset(symbol: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, symbol.toUpperCase());
  } catch {
    /* localStorage nicht verfügbar — ignorieren */
  }
}

export function getSelectedVenue(): ChartVenue {
  try {
    const v = localStorage.getItem(VENUE_KEY);
    return isChartVenue(v) ? v : 'binance';
  } catch {
    return 'binance';
  }
}

export function setSelectedVenue(venue: ChartVenue): void {
  try {
    localStorage.setItem(VENUE_KEY, venue);
  } catch {
    /* nur Komfort */
  }
}

type StockSymbols = Awaited<ReturnType<typeof trpc.market.stockSymbols.query>>;
type SearchResult = Awaited<ReturnType<typeof trpc.market.symbolSearch.query>>;
type StockSearch = Awaited<ReturnType<typeof trpc.market.stockSearch.query>>;

type Favorite = Awaited<ReturnType<typeof trpc.product.favoriteSymbols.query>>[number];
type MyMarket = { symbol: string; venue: ChartVenue; fav: boolean; name?: string };

/** Quellen-Namen (Eigennamen, nicht übersetzt) — auch für Alarm-Liste u. a. */
export const VENUE_LABEL: Record<ChartVenue, string> = { binance: 'Binance', twelvedata: 'Twelve Data', yahoo: 'Yahoo' };

export function AssetSelect({
  value,
  venue = 'binance',
  onChange,
  persist = true,
  label,
}: {
  value: string;
  venue?: ChartVenue;
  onChange: (symbol: string, venue: ChartVenue) => void;
  /** false = Zelle eines Mehrfach-Layouts: Wahl nicht als Seiten-Asset merken */
  persist?: boolean;
  label?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const [q, setQ] = useState('');
  // Scan-Universum = Binance-Paare; ein gewähltes Aktien-/Forex-Symbol gehört nicht hinein (sonst stünde es als Binance-Zeile da).
  const [universe, setUniverse] = useState<string[]>(venue === 'binance' ? [value] : []);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [stocks, setStocks] = useState<StockSymbols | 'error' | null>(null);
  const [search, setSearch] = useState<SearchResult | null>(null);
  const [stockSearch, setStockSearch] = useState<StockSearch | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void trpc.market.scanUniverse
      .query()
      .then((u) => setUniverse(u.includes(value) || venue !== 'binance' ? u : [...u, value]))
      .catch(() => setUniverse(venue === 'binance' ? [value] : []));
    void trpc.product.favoriteSymbols
      .query()
      .then(setFavorites)
      .catch(() => setFavorites([]));
    void trpc.market.stockSymbols
      .query()
      .then(setStocks)
      .catch(() => setStocks('error'));
    // nur beim Einhängen laden (das Universum ändert sich nicht mit der Auswahl)
  }, []);

  // Offen: Fokus ins Suchfeld, Klick außerhalb schließt.
  useEffect(() => {
    if (!open) return;
    setTimeout(() => inputRef.current?.focus(), 0);
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Suche gegen alle Binance-Paare (leicht entprellt) — und ab zwei Zeichen bei Yahoo (Aktien/ETF/Forex, kein Key).
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => {
      void trpc.market.symbolSearch
        .query({ q, limit: 40 })
        .then(setSearch)
        .catch(() => setSearch({ connected: false, total: 0, results: [], error: 'offline' }));
      if (q.trim().length >= 2) {
        void trpc.market.stockSearch
          .query({ q: q.trim(), limit: 8 })
          .then(setStockSearch)
          .catch(() => setStockSearch({ connected: false, results: [], error: 'offline' }));
      } else setStockSearch(null);
    }, 250);
    return () => clearTimeout(id);
  }, [q, open]);

  const rows = stocks !== null && stocks !== 'error' ? stocks.rows : [];
  // „Meine Märkte“: Favoriten jeder Quelle (mit ihrer Quelle, nie hart „binance“) + Scan-Universum.
  // Katalog-Favoriten ohne Kerzenquelle (venue null) sind nicht chartbar und bleiben hier draußen.
  const myMarkets: MyMarket[] = [];
  const myKeys = new Set<string>();
  const addMy = (m: MyMarket) => {
    const key = `${m.venue}:${m.symbol}`;
    if (myKeys.has(key)) return;
    myKeys.add(key);
    myMarkets.push(m);
  };
  for (const f of favorites) {
    if (isChartVenue(f.venue)) addMy({ symbol: f.symbol, venue: f.venue, fav: true, name: f.venue === 'binance' ? undefined : f.name });
  }
  for (const s of universe) addMy({ symbol: s, venue: 'binance', fav: false });
  const needle = q.trim().toUpperCase();
  const myVisible = needle ? myMarkets.filter((m) => m.symbol.includes(needle) || (m.name ?? '').toUpperCase().includes(needle)) : myMarkets;
  const binanceHits = (search?.results ?? []).filter((r) => !myKeys.has(`binance:${r.symbol}`));
  const stockRows = rows.filter((r) => !myKeys.has(`${r.venue}:${r.symbol.toUpperCase()}`));
  const stockVisible = needle ? stockRows.filter((r) => r.symbol.toUpperCase().includes(needle)) : stockRows;
  const stockKnown = new Set(rows.map((r) => r.symbol.toUpperCase()));
  const yahooHits = (stockSearch?.results ?? []).filter((r) => !stockKnown.has(r.symbol) && !myKeys.has(`yahoo:${r.symbol}`));

  const commit = (symbol: string, v: ChartVenue) => {
    if (persist) {
      localStorage.setItem(STORAGE_KEY, symbol);
      setSelectedVenue(v);
    }
    onChange(symbol, v);
  };

  const pick = async (symbol: string, v: ChartVenue, hasCandles: boolean) => {
    setOpen(false);
    setQ('');
    setErr(null);
    if (hasCandles) {
      commit(symbol, v);
      // Hintergrund: Rückstand nachladen (inkrementell, nichts tun wenn frisch)
      if (v === 'binance') void trpc.market.ensureCandles.mutate({ symbol }).catch(() => undefined);
      return;
    }
    setBusy(symbol);
    try {
      if (v === 'yahoo') {
        // Aktien/ETF/Forex ohne Key: echte Yahoo-Kerzen holen, erst dann wechseln.
        const r = await trpc.market.ensureStockCandles.mutate({ symbol });
        setStocks((prev) => (prev && prev !== 'error' ? { ...prev, rows: [...prev.rows, { venue: 'yahoo', symbol, timeframes: Object.keys(r.candles), candles: Object.values(r.candles).reduce((a, b) => a + b, 0) }] } : prev));
        commit(symbol, 'yahoo');
        return;
      }
      const r = await trpc.market.ensureCandles.mutate({ symbol });
      if (r.candles1h === 0) throw new Error(r.errors[0] ?? 'keine Kerzen');
      setUniverse((u) => (u.includes(symbol) ? u : [...u, symbol]));
      commit(symbol, 'binance');
    } catch (e) {
      setErr(t('assetCtx.loadFailed', { symbol, error: String(e instanceof Error ? e.message : e).slice(0, 140) }));
    } finally {
      setBusy(null);
    }
  };

  const openBox = () => {
    const r = boxRef.current?.getBoundingClientRect();
    setAlignRight(!!r && r.left > window.innerWidth / 2);
    setOpen(true);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') setOpen(false);
    if (e.key === 'Enter') {
      e.preventDefault();
      const mine = myVisible[0];
      if (mine) void pick(mine.symbol, mine.venue, true);
      else if (binanceHits[0]) void pick(binanceHits[0].symbol, 'binance', binanceHits[0].hasCandles);
    }
  };

  const current = `${value}${venue !== 'binance' ? ` · ${VENUE_LABEL[venue]}` : ''}`;

  const Row = ({ symbol, v, hasCandles, fav, name, kind }: { symbol: string; v: ChartVenue; hasCandles: boolean; fav?: boolean; name?: string; kind?: string }) => (
    <button
      type="button"
      onClick={() => void pick(symbol, v, hasCandles)}
      className="num flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-white/5"
      style={{ color: symbol === value && v === venue ? 'var(--color-cyan)' : 'var(--color-ink)' }}
    >
      <span className="min-w-0 truncate">
        {fav && <span style={{ color: 'var(--color-warn)' }}>★ </span>}
        {symbol}
        {name && <span className="font-sans" style={{ color: 'var(--color-mut)' }}> · {name}</span>}
        {!name && v !== 'binance' && <span style={{ color: 'var(--color-mut)' }}> · {VENUE_LABEL[v]}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {kind && <span className="chip chip--mut text-[10px]">{t(`assetCtx.kind_${kind}`, { defaultValue: kind })}</span>}
        {!hasCandles && <span className="chip shrink-0 text-[10px]">{t('assetCtx.newBadge')}</span>}
      </span>
    </button>
  );

  return (
    // min-w-0/max-w-full: das Feld darf die Seite auf dem Handy nie breiter machen.
    <div ref={boxRef} className="relative flex min-w-0 max-w-full items-center gap-2">
      <span className="label">{label ?? t('assetCtx.selector')}</span>
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openBox())}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={busy !== null}
        className="field num min-w-0 max-w-full cursor-pointer truncate px-3 py-1.5 text-left text-sm"
        style={{ color: 'var(--color-cyan)' }}
      >
        {busy ? t('assetCtx.loadingCandles', { symbol: busy }) : current} <span style={{ color: 'var(--color-mut)' }}>▾</span>
      </button>
      {err && (
        <span className="text-xs" style={{ color: 'var(--color-neg)' }}>
          {err}
        </span>
      )}
      {open && (
        <div
          role="listbox"
          className="glass absolute top-full z-30 mt-1 w-[min(22rem,calc(100vw-2rem))] p-2"
          style={{ [alignRight ? 'right' : 'left']: 0 }}
        >
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder={t('assetCtx.search')}
            aria-label={t('assetCtx.search')}
            className="field w-full px-3 py-1.5 text-sm"
          />
          <div className="mt-2 max-h-72 overflow-y-auto">
            {myVisible.length > 0 && (
              <>
                <p className="label px-2 py-1">{t('assetCtx.myMarkets')}</p>
                {myVisible.map((m) => (
                  <Row key={`my:${m.venue}:${m.symbol}`} symbol={m.symbol} v={m.venue} hasCandles fav={m.fav} name={m.name} />
                ))}
              </>
            )}
            <p className="label px-2 py-1">
              {search?.connected ? t('assetCtx.binanceAll', { n: search.total }) : t('assetCtx.cryptoGroup')}
            </p>
            {search === null && <p className="px-2 py-1 text-xs" style={{ color: 'var(--color-mut)' }}>{t('common.loading')}</p>}
            {search?.connected === false && <p className="px-2 py-1 text-xs" style={{ color: 'var(--color-warn)' }}>{t('assetCtx.searchOffline')}</p>}
            {search?.connected && binanceHits.length === 0 && needle && myVisible.length === 0 && (
              <p className="px-2 py-1 text-xs" style={{ color: 'var(--color-mut)' }}>{t('assetCtx.noResults', { q: needle })}</p>
            )}
            {binanceHits.map((r) => (
              <Row key={`bn:${r.symbol}`} symbol={r.symbol} v="binance" hasCandles={r.hasCandles} />
            ))}
            <p className="label px-2 py-1">{t('assetCtx.stocksGroup')}</p>
            {stockVisible.map((r) => (
              <Row key={`${r.venue}:${r.symbol}`} symbol={r.symbol} v={r.venue} hasCandles />
            ))}
            {/* Yahoo-Treffer (ohne Key): Auswahl holt echte Kerzen und wechselt erst dann. */}
            {yahooHits.map((r) => (
              <Row key={`yh:${r.symbol}`} symbol={r.symbol} v="yahoo" hasCandles={r.hasCandles} name={r.name} kind={r.type} />
            ))}
            {stockSearch?.connected === false && <p className="px-2 py-1 text-xs" style={{ color: 'var(--color-warn)' }}>{t('assetCtx.yahooOffline')}</p>}
            {needle.length < 2 && rows.length === 0 && (
              <p className="px-2 py-1 text-xs" style={{ color: 'var(--color-mut)' }}>
                {stocks === null ? t('common.loading') : t('assetCtx.stocksHint')}
              </p>
            )}
            {needle.length >= 2 && stockSearch?.connected && yahooHits.length === 0 && stockVisible.length === 0 && (
              <p className="px-2 py-1 text-xs" style={{ color: 'var(--color-mut)' }}>{t('assetCtx.stocksNoResults', { q: needle })}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
