import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { feedSymbol } from '../lib/pairs.js';
import { isChartVenue, type ChartVenue } from '../lib/chart-url.js';

/**
 * Stern-Favoriten (P0.3) — zwei Varianten, ein Verhalten:
 * - `FavStar`      : asset-ID-basiert (Pakete-Liste, wo die assetId vorliegt).
 * - `FavStarSymbol`: symbol-basiert (Charts/Aegis/Oracle/Signale, wo nur das
 *   Symbol bekannt ist) — nutzt product.toggleFavoriteBySymbol. Seit dem
 *   Asset-Register für JEDE Quelle: mit `venue` (yahoo/twelvedata) auch Aktien,
 *   ETF, Forex; ohne venue entscheidet das Register.
 * Favoriten steuern Scan-Universum, Signal-Priorität und Dashboard (bestehendes
 * Backend, keine Fake-Daten).
 */

const STAR_FULL = '★';
const STAR_EMPTY = '☆';
const btnClass = 'shrink-0 px-1 text-base leading-none transition-transform hover:scale-125 disabled:opacity-40';

export function FavStar({
  assetId,
  isFavorite,
  onToggled,
}: {
  assetId: number;
  isFavorite: boolean;
  onToggled: (assetId: number, fav: boolean) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  return (
    <button
      title={isFavorite ? t('fav.remove') : t('fav.add')}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        setBusy(true);
        trpc.product.toggleFavorite
          .mutate({ assetId })
          .then((res) => onToggled(assetId, res.favorite))
          .catch(() => undefined)
          .finally(() => setBusy(false));
      }}
      className={btnClass}
      style={{ color: isFavorite ? 'var(--color-warn)' : 'rgba(139,148,184,0.45)' }}
    >
      {isFavorite ? STAR_FULL : STAR_EMPTY}
    </button>
  );
}

export function FavStarSymbol({
  symbol,
  venue,
  initialFavorite,
  onToggled,
  className = '',
}: {
  symbol: string;
  /** Kerzenquelle des Symbols (Chart-Venue); ohne = Krypto-Paar bzw. Register entscheidet. */
  venue?: ChartVenue | string | null;
  /** Wenn bekannt (z. B. aus signal.isFavorite): spart die Zustands-Abfrage. */
  initialFavorite?: boolean;
  onToggled?: (fav: boolean) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [fav, setFav] = useState<boolean | null>(initialFavorite ?? null);
  const [busy, setBusy] = useState(false);
  const [noAsset, setNoAsset] = useState(false);

  const source = isChartVenue(venue) ? venue : undefined;

  useEffect(() => {
    if (initialFavorite !== undefined) {
      setFav(initialFavorite);
      return;
    }
    let cancelled = false;
    void trpc.product.favoriteSymbols
      .query()
      .then((syms) => {
        if (cancelled) return;
        // Krypto-Paare normalisiert ("BTCUSDT" → "BTC/USDT"), alle anderen Quellen exakt
        const norm = source && source !== 'binance' ? symbol.toUpperCase() : (feedSymbol(symbol) ?? symbol.toUpperCase());
        setFav(syms.some((s) => s.symbol === norm && (source ? s.venue === source : true)));
      })
      .catch(() => {
        if (!cancelled) setFav(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, source, initialFavorite]);

  const isFav = fav === true;
  return (
    <button
      title={noAsset ? t('fav.noAsset') : isFav ? t('fav.remove') : t('fav.add')}
      disabled={busy || fav === null}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        setBusy(true);
        trpc.product.toggleFavoriteBySymbol
          .mutate({ symbol, ...(source ? { venue: source } : {}) })
          .then((res) => {
            if (res.ok) {
              setFav(res.favorite);
              setNoAsset(false);
              onToggled?.(res.favorite);
            } else {
              setNoAsset(true);
            }
          })
          .catch(() => undefined)
          .finally(() => setBusy(false));
      }}
      className={`${btnClass} ${className}`}
      style={{ color: isFav ? 'var(--color-warn)' : 'rgba(139,148,184,0.55)' }}
    >
      {isFav ? STAR_FULL : STAR_EMPTY}
    </button>
  );
}
