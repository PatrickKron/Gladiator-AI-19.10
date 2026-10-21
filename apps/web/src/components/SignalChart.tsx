import { useEffect, useRef } from 'react';
import { CandlestickSeries, createChart, CrosshairMode, type IChartApi } from 'lightweight-charts';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';

/**
 * Signal-Chart (Patrick-Lücke 7): echte eigene DB-Kerzen (lightweight-charts,
 * self-hosted) mit eingezeichnetem Entry, Stop-Loss und Take-Profits.
 * Kein CDN, keine erfundenen Kerzen — lädt exakt die Scan-Datenbasis.
 */

export function SignalChart({
  symbol,
  timeframe,
  entry,
  stopLoss,
  takeProfits,
}: {
  symbol: string;
  timeframe: '15m' | '1h' | '4h' | '1d';
  entry: number;
  stopLoss: number;
  takeProfits: number[];
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;

    const chart = createChart(el, {
      width: el.clientWidth,
      height: 260,
      layout: { background: { color: 'transparent' }, textColor: '#8b94b8', fontSize: 10 },
      grid: { vertLines: { color: 'rgba(148,163,184,0.06)' }, horzLines: { color: 'rgba(148,163,184,0.06)' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(148,163,184,0.2)' },
      timeScale: { borderColor: 'rgba(148,163,184,0.2)', timeVisible: timeframe !== '1d' },
    });
    chartRef.current = chart;

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: 'rgba(34,197,94,0.6)',
      wickDownColor: 'rgba(239,68,68,0.6)',
    });

    // Entry/SL/TP als Preislinien — exakt die Signal-Level
    series.createPriceLine({ price: entry, color: '#60a5fa', lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: 'Entry' });
    series.createPriceLine({ price: stopLoss, color: '#ef4444', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'SL' });
    takeProfits.forEach((tp, i) => {
      series.createPriceLine({ price: tp, color: '#22c55e', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: `TP${i + 1}` });
    });

    void trpc.market.chartCandles
      .query({ symbol, timeframe, limit: 200 })
      .then((candles) => {
        if (cancelled || candles.length === 0) return;
        series.setData(candles as Parameters<typeof series.setData>[0]);
        chart.timeScale().fitContent();
      })
      .catch(() => {
        /* Kerzen nicht ladbar → Chart bleibt leer (ehrlich), Level-Linien sichtbar */
      });

    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    const observer = new ResizeObserver(onResize);
    observer.observe(el);

    return () => {
      cancelled = true;
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [symbol, timeframe, entry, stopLoss, takeProfits]);

  return (
    <div className="mt-3">
      <div ref={containerRef} className="w-full overflow-hidden rounded" style={{ background: 'rgba(11,13,18,0.45)' }} />
      <p className="label mt-1.5">{t('signals.chartLegend')}</p>
    </div>
  );
}
