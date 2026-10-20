import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CandlestickSeries, createChart, CrosshairMode, type IChartApi, type UTCTimestamp } from 'lightweight-charts';
import { trpc } from '../api.js';
import { pricePrecision } from '../lib/swap-format.js';

/**
 * Kerzen-Chart eines Tokens im Swap-Ticket (Vision-Punkt 5): echte Kerzen des
 * liquidesten Pools (GeckoTerminal). Keine Kerzen → ehrlicher Hinweis, nie
 * aufgefüllt. Meme-Preise (0,00002 $) bekommen genug Nachkommastellen.
 */

type Chain = Parameters<typeof trpc.swaps.candles.query>[0]['chain'];
type Tf = Parameters<typeof trpc.swaps.candles.query>[0]['tf'];
const TFS: Tf[] = ['5m', '15m', '1h', '4h', '1d'];

export function TokenChart({ chain, pool }: { chain: Chain; pool: string }) {
  const { t } = useTranslation();
  const [tf, setTf] = useState<Tf>('1h');
  const [state, setState] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    void trpc.swaps.candles
      .query({ chain, pool, tf })
      .then((candles) => {
        if (cancelled || !boxRef.current) return;
        chartRef.current?.remove();
        chartRef.current = null;
        if (candles.length === 0) {
          setState('empty');
          return;
        }
        const el = boxRef.current;
        const chart = createChart(el, {
          width: el.clientWidth,
          height: 220,
          layout: { background: { color: 'transparent' }, textColor: '#8b94b8', fontSize: 10 },
          grid: { vertLines: { color: 'rgba(99,140,255,0.05)' }, horzLines: { color: 'rgba(99,140,255,0.05)' } },
          crosshair: { mode: CrosshairMode.Normal },
          rightPriceScale: { borderColor: 'rgba(99,140,255,0.18)' },
          timeScale: { borderColor: 'rgba(99,140,255,0.18)', timeVisible: tf !== '1d', rightOffset: 3 },
        });
        const precision = pricePrecision(candles.at(-1)!.close);
        const series = chart.addSeries(CandlestickSeries, {
          upColor: '#3ddc97',
          downColor: '#ff5c6c',
          borderUpColor: '#3ddc97',
          borderDownColor: '#ff5c6c',
          wickUpColor: 'rgba(61,220,151,0.6)',
          wickDownColor: 'rgba(255,92,108,0.6)',
          priceFormat: { type: 'price', precision, minMove: 10 ** -precision },
        });
        series.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
        chart.timeScale().fitContent();
        chartRef.current = chart;
        setState('ok');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t('common.error'));
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [chain, pool, tf, t]);

  // Breite mitziehen; beim Verlassen aufräumen
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => chartRef.current?.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      chartRef.current?.remove();
      chartRef.current = null;
    };
  }, []);

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {TFS.map((x) => (
          <button
            key={x}
            type="button"
            onClick={() => setTf(x)}
            className="num rounded border px-2 py-0.5 text-[11px]"
            style={{ borderColor: x === tf ? 'var(--color-cyan)' : 'var(--color-line)', color: x === tf ? 'var(--color-ink)' : 'var(--color-mut)' }}
          >
            {x}
          </button>
        ))}
        <span className="ml-auto text-[10px]" style={{ color: 'var(--color-mut)' }}>
          GeckoTerminal
        </span>
      </div>
      <div ref={boxRef} className="mt-2" style={{ height: state === 'ok' ? 220 : 0 }} />
      {state === 'loading' && <p className="mt-2 animate-pulse text-[11px]" style={{ color: 'var(--color-mut)' }}>{t('common.loading')}</p>}
      {state === 'empty' && <p className="mt-2 text-[11px]" style={{ color: 'var(--color-mut)' }}>{t('swap.noCandles')}</p>}
      {state === 'error' && <p className="mt-2 text-[11px]" style={{ color: 'var(--color-warn)' }}>{error}</p>}
    </div>
  );
}
