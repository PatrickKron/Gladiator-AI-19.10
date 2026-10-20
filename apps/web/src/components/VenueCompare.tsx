import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { fmtNum } from './ui.js';
import { clearVisibleInterval, setVisibleInterval } from '../lib/visible-interval.js';

/**
 * Börsen-Vergleich im Order-Ticket (Vision-Punkt 2): echte, öffentliche Kurse
 * je Börse, gerankt nach effektivem Preis inkl. Gebühr. Klick auf eine
 * erreichbare Börse wählt sie für die Order. Nicht erreichbar ⇒ sichtbar, nie geschätzt.
 */

type Quotes = Awaited<ReturnType<typeof trpc.market.venueQuotes.query>>;

export const VENUE_NAMES: Record<string, string> = {
  binance: 'Binance',
  bybit: 'Bybit',
  okx: 'OKX',
  bitget: 'Bitget',
  kucoin: 'KuCoin',
  mexc: 'MEXC',
  gate: 'Gate',
  hyperliquid: 'Hyperliquid',
};

export function VenueCompare({
  symbol,
  side,
  selected,
  onSelect,
}: {
  symbol: string;
  side: 'buy' | 'sell';
  selected: string;
  onSelect: (venue: string) => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<Quotes | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    const load = () =>
      trpc.market.venueQuotes
        .query({ symbol, side })
        .then((d) => {
          if (!cancelled) {
            setData(d);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : t('common.error'));
        });
    void load();
    const timer = setVisibleInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      clearVisibleInterval(timer);
    };
  }, [symbol, side, t]);

  const pct = (n: number | null, digits = 3) => (n === null ? '—' : `${fmtNum(n * 100, digits)} %`);

  return (
    <div className="rounded-[0.625rem] border p-3" style={{ borderColor: 'var(--color-line)' }}>
      <div className="flex items-center justify-between gap-2">
        <p className="label">{t(side === 'buy' ? 'venues.titleBuy' : 'venues.titleSell', { symbol })}</p>
        <span className="text-[11px]" style={{ color: 'var(--color-mut)' }}>
          {t('venues.selected', { venue: VENUE_NAMES[selected] ?? selected })}
        </span>
      </div>
      {error && !data && (
        <p className="mt-2 text-xs" style={{ color: 'var(--color-warn)' }}>
          {error}
        </p>
      )}
      {!data && !error && (
        <p className="mt-2 animate-pulse text-xs" style={{ color: 'var(--color-mut)' }}>
          {t('common.loading')}
        </p>
      )}
      {data && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="label text-left">
                <th className="py-1 pr-2 font-normal">{t('venues.venue')}</th>
                <th className="py-1 pr-2 text-right font-normal">{t(side === 'buy' ? 'venues.ask' : 'venues.bid')}</th>
                <th className="py-1 pr-2 text-right font-normal">{t('venues.fee')}</th>
                <th className="py-1 pr-2 text-right font-normal">{t('venues.effective')}</th>
                <th className="py-1 pr-2 text-right font-normal">{t('venues.diff')}</th>
                <th className="py-1 pr-2 text-right font-normal">{t('venues.funding')}</th>
                <th className="py-1 text-right font-normal">{t('venues.maxLev')}</th>
              </tr>
            </thead>
            <tbody className="num">
              {data.venues.map((v) => {
                const ok = v.status === 'ok' && v.effectivePrice !== null;
                const isSel = v.venue === selected;
                const raw = side === 'buy' ? v.ask : v.bid;
                return (
                  <tr
                    key={v.venue}
                    onClick={() => ok && onSelect(v.venue)}
                    className={ok ? 'cursor-pointer' : ''}
                    title={ok ? t('venues.clickToSelect') : (v.error ?? undefined)}
                    style={{
                      borderTop: '1px solid rgba(99,140,255,0.08)',
                      background: isSel ? 'rgba(79,209,255,0.1)' : 'transparent',
                      opacity: ok ? 1 : 0.55,
                    }}
                  >
                    <td className="py-1 pr-2">
                      <span style={{ color: isSel ? 'var(--color-cyan)' : 'var(--color-ink)' }}>{VENUE_NAMES[v.venue] ?? v.venue}</span>
                      {v.marketType === 'swap' && <span className="ml-1" style={{ color: 'var(--color-mut)' }}>Perp</span>}
                      {v.connected && (
                        <span className="ml-1 rounded border px-1 text-[10px]" style={{ borderColor: 'var(--color-pos)', color: 'var(--color-pos)' }}>
                          {t('venues.connected')}
                        </span>
                      )}
                    </td>
                    {ok ? (
                      <>
                        <td className="py-1 pr-2 text-right">{raw !== null ? fmtNum(raw, raw >= 100 ? 2 : 6) : '—'}</td>
                        <td className="py-1 pr-2 text-right">{pct(v.takerFee)}</td>
                        <td className="py-1 pr-2 text-right">{fmtNum(v.effectivePrice!, v.effectivePrice! >= 100 ? 2 : 6)}</td>
                        <td className="py-1 pr-2 text-right" style={{ color: v.best ? 'var(--color-pos)' : 'var(--color-mut)' }}>
                          {v.best ? t('venues.best') : `+${fmtNum(v.diffBps ?? 0, 1)} bps`}
                        </td>
                        <td className="py-1 pr-2 text-right">{pct(v.fundingRate, 4)}</td>
                        <td className="py-1 text-right">{v.maxLeverage !== null ? `${v.maxLeverage}×` : '—'}</td>
                      </>
                    ) : (
                      <td colSpan={6} className="py-1 text-right" style={{ color: 'var(--color-mut)' }}>
                        {v.status === 'not_listed' ? t('venues.notListed') : t('venues.unavailable')}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-1.5 text-[11px]" style={{ color: 'var(--color-mut)' }}>
            {t('venues.footer', { time: new Date(data.fetchedAt).toLocaleTimeString() })}
          </p>
        </div>
      )}
    </div>
  );
}
