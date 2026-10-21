import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { NotConnected, Panel, fmtNum } from './ui.js';
import { clearVisibleInterval, setVisibleInterval } from '../lib/visible-interval.js';
import { appLocale } from '../lib/locale.js';

/**
 * Orderbuch (Chart-Seite): echtes Binance-Buch (serverseitig per Websocket-Stream
 * warm gehalten, sonst REST), jede Sekunde abgefragt, optional gebündelt.
 * Tiefenbalken = kumulierte Menge. Nicht erreichbar ⇒ „nicht verbunden", nie erfunden.
 */
type Book = Awaited<ReturnType<typeof trpc.market.orderBook.query>>;

/** Sinnvolle Bündelungsstufen relativ zum Preis (0 = keine Bündelung). */
function groupSteps(mid: number | null): number[] {
  if (!mid) return [0];
  const base = 10 ** Math.floor(Math.log10(mid) - 4);
  return [0, base, base * 10, base * 100];
}

/** Nachkommastellen einer Zahl (max. 8) — für Preise des echten Buchs bzw. die Bündelungsstufe. */
function decimals(n: number): number {
  const str = Number(n.toPrecision(12)).toString();
  if (str.includes('e-')) return Math.min(8, Number(str.split('e-')[1]));
  const dot = str.indexOf('.');
  return dot < 0 ? 0 : Math.min(8, str.length - dot - 1);
}

/** Anzeige-Genauigkeit: bei Bündelung die Stufe, sonst die feinste Stelle der echten Level. */
export function bookDigits(step: number, prices: number[]): number {
  if (step > 0) return decimals(step);
  return prices.reduce((d, p) => Math.max(d, decimals(p)), 0);
}

export function OrderBookPanel({ symbol }: { symbol: string }) {
  const { t } = useTranslation();
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState(0);

  useEffect(() => {
    setBook(null);
    setError(null);
    setGroup(0);
  }, [symbol]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      trpc.market.orderBook
        .query({ symbol, levels: 15, ...(group > 0 ? { group } : {}) })
        .then((b) => {
          if (!cancelled) {
            setBook(b);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : t('common.error'));
        });
    void load();
    const timer = setVisibleInterval(() => void load(), 1_000);
    return () => {
      cancelled = true;
      clearVisibleInterval(timer);
    };
  }, [symbol, group, t]);

  const digits = book ? bookDigits(group, [...book.bids, ...book.asks].map((l) => l.price)) : 2;
  const price = (n: number) => n.toLocaleString(appLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const row = (side: 'bid' | 'ask', l: Book['bids'][number]) => {
    const pct = book && book.maxCum > 0 ? (l.cum / book.maxCum) * 100 : 0;
    const color = side === 'bid' ? 'rgba(52,211,153,0.16)' : 'rgba(239,68,68,0.16)';
    return (
      <div
        key={`${side}-${l.price}`}
        className="num grid grid-cols-3 px-2 py-0.5 text-xs"
        style={{ background: `linear-gradient(to left, ${color} ${pct}%, transparent ${pct}%)` }}
      >
        <span style={{ color: side === 'bid' ? 'var(--color-pos)' : 'var(--color-neg)' }}>{price(l.price)}</span>
        <span className="text-right">{fmtNum(l.qty, 4)}</span>
        <span className="text-right" style={{ color: 'var(--color-mut)' }}>
          {fmtNum(l.cum, 4)}
        </span>
      </div>
    );
  };

  return (
    <Panel label={t('orderbook.title', { symbol })} stagger={2} className="mt-5">
      {error && !book && <NotConnected detail={t('orderbook.unavailable', { detail: error })} />}
      {book && (
        <>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs" style={{ color: 'var(--color-mut)' }}>
            <span className="num">
              {t('orderbook.spread')}: {book.spread === null ? '—' : `${price(book.spread)} (${fmtNum(book.spreadBps ?? 0, 2)} bps)`}
              {book.imbalance !== null && (
                <>
                  {' · '}
                  {t('orderbook.imbalance', { pct: fmtNum(book.imbalance * 100, 0) })}
                </>
              )}
            </span>
            <span className="flex items-center gap-1">
              {t('orderbook.group')}
              {groupSteps(book.mid).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGroup(g)}
                  className="rounded border px-1.5 py-0.5"
                  style={
                    group === g
                      ? { borderColor: 'var(--color-cyan)', color: 'var(--color-ink)' }
                      : { borderColor: 'var(--color-line)', color: 'var(--color-mut)' }
                  }
                >
                  {g === 0 ? t('orderbook.groupNone') : g.toLocaleString(appLocale(), { maximumFractionDigits: bookDigits(g, []) })}
                </button>
              ))}
            </span>
          </div>
          <div className="num mt-2 grid grid-cols-3 px-2 text-[11px] uppercase" style={{ color: 'var(--color-mut)' }}>
            <span>{t('orderbook.price')}</span>
            <span className="text-right">{t('orderbook.qty')}</span>
            <span className="text-right">{t('orderbook.total')}</span>
          </div>
          <div className="mt-1 flex flex-col-reverse">{book.asks.map((l) => row('ask', l))}</div>
          <div className="num my-1 border-y px-2 py-1 text-sm" style={{ borderColor: 'var(--color-line)' }}>
            {book.mid !== null ? price(book.mid) : '—'} <span className="text-xs" style={{ color: 'var(--color-mut)' }}>{t('orderbook.mid')}</span>
          </div>
          <div>{book.bids.map((l) => row('bid', l))}</div>
          <p className="mt-2 text-[11px]" style={{ color: 'var(--color-mut)' }}>
            {t(book.live ? 'orderbook.sourceLive' : 'orderbook.source', { time: new Date(book.ts).toLocaleTimeString(appLocale()) })}
            {error && <span style={{ color: 'var(--color-warn)' }}> · {t('orderbook.stale')}</span>}
          </p>
        </>
      )}
    </Panel>
  );
}
