import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { isChartVenue, type ChartVenue } from '../lib/chart-url.js';

/**
 * Asset-Selektor (Patrick-Lücke 2): Scan-Universum (Basis + ★ Favoriten) als
 * Dropdown, Auswahl in localStorage — Oracle/Aegis beziehen sich darauf.
 * Seit der Repo-Masterliste (Phase 5) auch Aktien/ETF/Forex mit echten Kerzen
 * aus Twelve Data oder Yahoo — als zweite Gruppe mit Quelle; ohne Key und ohne
 * geladene Kerzen ehrlich „nicht verbunden“.
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

const VENUE_LABEL: Record<ChartVenue, string> = { binance: 'Binance', twelvedata: 'Twelve Data', yahoo: 'Yahoo' };

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
  const [universe, setUniverse] = useState<string[]>([value]);
  const [stocks, setStocks] = useState<StockSymbols | 'error' | null>(null);

  useEffect(() => {
    void trpc.market.scanUniverse
      .query()
      .then((u) => setUniverse(u.includes(value) ? u : [...u, value]))
      .catch(() => setUniverse([value]));
    void trpc.market.stockSymbols
      .query()
      .then(setStocks)
      .catch(() => setStocks('error'));
    // nur beim Einhängen laden (das Universum ändert sich nicht mit der Auswahl)
  }, []);

  const rows = stocks !== null && stocks !== 'error' ? stocks.rows : [];
  const configured = stocks !== null && stocks !== 'error' && stocks.configured.twelvedata;
  const current = `${venue}:${value}`;
  const known = venue === 'binance' ? universe.includes(value) : rows.some((r) => r.venue === venue && r.symbol === value);

  return (
    <label className="flex items-center gap-2">
      <span className="label">{label ?? t('assetCtx.selector')}</span>
      <select
        value={current}
        onChange={(e) => {
          const [v, ...rest] = e.target.value.split(':');
          const sym = rest.join(':');
          const nextVenue: ChartVenue = isChartVenue(v) ? v : 'binance';
          if (persist) {
            localStorage.setItem(STORAGE_KEY, sym);
            setSelectedVenue(nextVenue);
          }
          onChange(sym, nextVenue);
        }}
        className="field num cursor-pointer px-3 py-1.5 text-sm"
        style={{ color: 'var(--color-cyan)' }}
      >
        <optgroup label={t('assetCtx.cryptoGroup')}>
          {universe.map((s) => (
            <option key={s} value={`binance:${s}`}>
              {s}
            </option>
          ))}
        </optgroup>
        <optgroup label={t('assetCtx.stocksGroup')}>
          {rows.map((r) => (
            <option key={`${r.venue}:${r.symbol}`} value={`${r.venue}:${r.symbol}`}>
              {r.symbol} · {VENUE_LABEL[r.venue]}
            </option>
          ))}
          {rows.length === 0 && (
            <option disabled value="__none">
              {stocks === null ? t('common.loading') : configured ? t('assetCtx.stocksEmpty') : t('assetCtx.stocksNone')}
            </option>
          )}
        </optgroup>
        {!known && (
          <option value={current}>
            {value}
            {venue !== 'binance' ? ` · ${VENUE_LABEL[venue]}` : ''}
          </option>
        )}
      </select>
    </label>
  );
}
