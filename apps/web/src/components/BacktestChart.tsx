import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { trpc } from '../api.js';

/**
 * Visuelles Backtesting (Feature 1): echte DB-Kerzen über das Backtest-Fenster
 * (rangedCandles) mit Entry/Exit-Markern je Trade. Der ausgewählte Trade zeigt
 * zusätzlich SL/TP als gestrichelte Preislinien und seinen Verlauf (Entry→Exit)
 * als Trade-Bereich. Nichts erfunden — Marker sitzen exakt auf den Signal-Kerzen.
 */

const C = {
  cyan: '#4fd1ff',
  green: '#3ddc97',
  red: '#ff5c6c',
  amber: '#f5b642',
  mut: '#8b94b8',
};

export type BacktestTradeView = {
  entryTs: string;
  exitTs: string;
  direction: 'long' | 'short';
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  netPnl: number;
  rMultiple: number;
  exitReason: 'tp' | 'sl' | 'be' | 'end-of-data';
};

const EXIT_LABEL: Record<BacktestTradeView['exitReason'], string> = {
  tp: 'TP',
  sl: 'SL',
  be: 'BE',
  'end-of-data': '⏹',
};

const toSec = (iso: string): UTCTimestamp => Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;

export function BacktestChart({
  symbol,
  timeframe,
  from,
  to,
  trades,
  selected,
  onSelect,
}: {
  symbol: string;
  timeframe: string;
  /** ISO-Datetimes des Backtest-Fensters. */
  from: string;
  to: string;
  trades: BacktestTradeView[];
  /** Index des fokussierten Trades (SL/TP-Linien + Bereich). */
  selected: number | null;
  onSelect?: (index: number | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty'>('loading');
  const [truncated, setTruncated] = useState(false);
  const [window, setWindow] = useState<{ first: number; last: number } | null>(null);

  // ── Kerzen laden + Basis-Chart aufbauen (Symbol/TF/Fenster) ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    setState('loading');

    const chart = createChart(el, {
      width: el.clientWidth,
      height: 360,
      layout: { background: { color: 'transparent' }, textColor: C.mut, fontSize: 10 },
      grid: { vertLines: { color: 'rgba(99,140,255,0.05)' }, horzLines: { color: 'rgba(99,140,255,0.05)' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(99,140,255,0.18)' },
      timeScale: { borderColor: 'rgba(99,140,255,0.18)', timeVisible: timeframe !== '1d', rightOffset: 4 },
    });
    chartRef.current = chart;
    const candle = chart.addCandlestickSeries({
      upColor: C.green,
      downColor: C.red,
      borderUpColor: C.green,
      borderDownColor: C.red,
      wickUpColor: 'rgba(61,220,151,0.6)',
      wickDownColor: 'rgba(255,92,108,0.6)',
      priceLineVisible: false,
    });
    candleRef.current = candle;

    // OHLC-Legende
    const legendEl = legendRef.current;
    const onMove = (param: Parameters<Parameters<typeof chart.subscribeCrosshairMove>[0]>[0]) => {
      if (!legendEl) return;
      const bar = param.seriesData.get(candle) as { open: number; high: number; low: number; close: number } | undefined;
      if (!bar) {
        legendEl.style.opacity = '0';
        return;
      }
      const d = bar.close >= bar.open ? C.green : C.red;
      const f = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n >= 1000 ? 1 : 4 });
      legendEl.style.opacity = '1';
      legendEl.innerHTML = `<span style="color:${C.mut}">O</span> ${f(bar.open)}  <span style="color:${C.mut}">H</span> ${f(bar.high)}  <span style="color:${C.mut}">L</span> ${f(bar.low)}  <span style="color:${C.mut}">C</span> <span style="color:${d}">${f(bar.close)}</span>`;
    };
    chart.subscribeCrosshairMove(onMove);

    // Klick auf eine Kerze → nächstgelegenen Trade auswählen
    if (onSelect && trades.length > 0) {
      chart.subscribeClick((param) => {
        if (param.time == null) return;
        const clicked = param.time as number;
        let bestIdx = -1;
        let bestDist = Infinity;
        trades.forEach((tr, i) => {
          const dist = Math.abs(toSec(tr.entryTs) - clicked);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
          }
        });
        if (bestIdx >= 0) onSelect(bestIdx);
      });
    }

    void trpc.market.rangedCandles
      .query({ symbol, timeframe, from, to })
      .then((res) => {
        if (cancelled) return;
        if (res.bars.length === 0) {
          setState('empty');
          return;
        }
        candle.setData(res.bars as never);
        chart.timeScale().fitContent();
        setTruncated(res.truncated);
        setWindow({ first: res.bars[0]!.time, last: res.bars[res.bars.length - 1]!.time });
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('empty');
      });

    const observer = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    observer.observe(el);

    return () => {
      cancelled = true;
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
    };
  }, [symbol, timeframe, from, to, trades, onSelect]);

  // Nur Trades, deren Entry im geladenen Kerzenfenster liegt (Marker sitzen sonst daneben)
  const visibleTrades = useMemo(() => {
    if (!window) return [];
    return trades
      .map((tr, i) => ({ tr, i }))
      .filter(({ tr }) => {
        const e = toSec(tr.entryTs);
        return e >= window.first && e <= window.last;
      });
  }, [trades, window]);

  // ── Marker aller sichtbaren Trades (Entry-Pfeil + Exit-Icon) ──
  useEffect(() => {
    const candle = candleRef.current;
    if (!candle || state !== 'ready') return;
    const markers: SeriesMarker<Time>[] = [];
    for (const { tr, i } of visibleTrades) {
      const isSel = selected === i;
      const long = tr.direction === 'long';
      markers.push({
        time: toSec(tr.entryTs),
        position: long ? 'belowBar' : 'aboveBar',
        color: isSel ? C.cyan : long ? C.green : C.red,
        shape: long ? 'arrowUp' : 'arrowDown',
        text: isSel ? `#${i + 1} ${long ? 'Long' : 'Short'}` : '',
      });
      markers.push({
        time: toSec(tr.exitTs),
        position: long ? 'aboveBar' : 'belowBar',
        color: tr.netPnl >= 0 ? C.green : C.red,
        shape: 'circle',
        text: EXIT_LABEL[tr.exitReason],
      });
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    candle.setMarkers(markers);
  }, [visibleTrades, selected, state]);

  // ── Ausgewählter Trade: SL/TP-Preislinien + Entry→Exit-Bereich ──
  useEffect(() => {
    const chart = chartRef.current;
    const candle = candleRef.current;
    if (!chart || !candle || state !== 'ready' || selected === null) return;
    const tr = trades[selected];
    if (!tr) return;

    const priceLines = [
      candle.createPriceLine({ price: tr.entry, color: C.cyan, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'Entry' }),
      candle.createPriceLine({ price: tr.stopLoss, color: C.red, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'SL' }),
      ...tr.takeProfits.map((tp, i) =>
        candle.createPriceLine({ price: tp, color: C.green, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `TP${i + 1}` }),
      ),
    ];

    // Trade-Bereich: Verlaufslinie Entry→Exit (Farbe nach Ergebnis)
    const entrySec = toSec(tr.entryTs);
    const exitSec = toSec(tr.exitTs);
    const path = chart.addLineSeries({
      color: tr.netPnl >= 0 ? 'rgba(61,220,151,0.9)' : 'rgba(255,92,108,0.9)',
      lineWidth: 2,
      lineStyle: LineStyle.Dotted,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    const exitPrice = tr.exitReason === 'tp' ? tr.takeProfits[tr.takeProfits.length - 1] ?? tr.entry : tr.exitReason === 'sl' ? tr.stopLoss : tr.exitReason === 'be' ? tr.entry : tr.entry;
    const pathPts =
      exitSec > entrySec
        ? [
            { time: entrySec, value: tr.entry },
            { time: exitSec, value: exitPrice },
          ]
        : [{ time: entrySec, value: tr.entry }];
    path.setData(pathPts as never);

    return () => {
      // Wenn der Basis-Effekt den Chart schon entsorgt hat (Unmount/Neuaufbau),
      // würde removeSeries/removePriceLine auf einem disposed Chart werfen
      // (`Value is undefined`) und beim Unmount die ganze App weiß reißen.
      if (chartRef.current !== chart) return;
      try {
        for (const pl of priceLines) candle.removePriceLine(pl);
        chart.removeSeries(path);
      } catch {
        /* Chart bereits entsorgt — ignorieren */
      }
    };
  }, [selected, trades, state]);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]" style={{ color: C.mut }}>
        <span><span style={{ color: C.green }}>▲</span> Long-Entry</span>
        <span><span style={{ color: C.red }}>▼</span> Short-Entry</span>
        <span><span style={{ color: C.green }}>●</span> Exit im Gewinn</span>
        <span><span style={{ color: C.red }}>●</span> Exit im Verlust</span>
        <span>Kerze/Trade anklicken → SL/TP-Linien</span>
      </div>
      {state === 'loading' && (
        <div className="flex h-[360px] items-center justify-center text-sm" style={{ color: C.mut }}>Kerzen laden …</div>
      )}
      {state === 'empty' && (
        <div className="flex h-[200px] items-center justify-center rounded border p-4 text-center text-sm" style={{ borderColor: 'var(--color-line)', color: C.mut }}>
          Keine Kerzen im Backtest-Fenster für {symbol} · {timeframe}.
        </div>
      )}
      <div style={{ display: state === 'ready' ? 'block' : 'none' }}>
        <div className="relative">
          <div ref={legendRef} className="num pointer-events-none absolute left-2 top-1 z-10 text-[11px]" style={{ opacity: 0 }} />
          <div ref={containerRef} className="w-full overflow-hidden rounded" style={{ background: 'rgba(4,6,20,0.45)' }} />
        </div>
        <p className="label mt-1.5 px-2">
          {visibleTrades.length} von {trades.length} Trades im Chartfenster
          {truncated && ' · Fenster gekürzt (zu viele Kerzen — jüngeren Zeitraum wählen)'}
          {selected !== null && trades[selected] && ` · fokussiert: Trade #${selected + 1}`}
        </p>
      </div>
    </div>
  );
}
