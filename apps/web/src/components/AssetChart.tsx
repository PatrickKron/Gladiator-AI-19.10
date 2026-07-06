import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type LogicalRange,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';

/**
 * Voll-Chart mit Indikatoren (Krypto-Charting):
 * echte DB-Kerzen + EMA 20/50/200, Bollinger, Volumen, Smart-Money-Marker
 * (BOS/CHoCH, Order Blocks, FVG) und synchronisierte RSI/MACD/ATR-Panels.
 * Alle Serien rechnen serverseitig auf denselben Kerzen wie die Signal-Engine —
 * self-hosted (kein CDN), nichts erfunden.
 */

type ChartData = Extract<Awaited<ReturnType<typeof trpc.market.chartData.query>>, { available: true }>;
type Timeframe = '15m' | '1h' | '4h' | '1d';

const TIMEFRAMES: Timeframe[] = ['15m', '1h', '4h', '1d'];

const C = {
  cyan: '#4fd1ff',
  green: '#3ddc97',
  red: '#ff5c6c',
  violet: '#8b5cf6',
  amber: '#f5b642',
  mut: '#8b94b8',
  faint: 'rgba(139,148,184,0.35)',
};

type ToggleKey = 'ema' | 'bollinger' | 'volume' | 'structure' | 'zones' | 'signals' | 'rsi' | 'macd' | 'atr';
const DEFAULT_TOGGLES: Record<ToggleKey, boolean> = {
  ema: true,
  bollinger: false,
  volume: true,
  structure: true,
  zones: true,
  signals: true,
  rsi: true,
  macd: false,
  atr: false,
};

type SignalMarker = {
  createdAt: string;
  direction: 'long' | 'short';
  setupType: string;
  status: 'new' | 'confirmed' | 'rejected' | 'expired' | 'filled' | 'closed';
};

/** Farbe je Signal-Status (Feature 2): offen/bestätigt/gefüllt/geschlossen/abgelehnt. */
const SIGNAL_STATUS_COLOR: Record<SignalMarker['status'], string> = {
  new: '#4fd1ff', // offen — cyan
  confirmed: '#f5b642', // bestätigt — amber
  filled: '#3ddc97', // im Markt — grün
  closed: '#8b94b8', // geschlossen — grau
  rejected: '#ff5c6c', // abgelehnt — rot
  expired: 'rgba(139,148,184,0.6)', // verfallen — blassgrau
};
const SIGNAL_STATUS_LABEL: Record<SignalMarker['status'], string> = {
  new: 'offen',
  confirmed: 'bestät.',
  filled: 'aktiv',
  closed: 'zu',
  rejected: 'abgel.',
  expired: 'verf.',
};

/**
 * Alle Zeitskalen aneinander koppeln, damit die Panels zum Kurs ausgerichtet
 * bleiben. Gibt einen Disposer zurück: der MUSS vor `chart.remove()` laufen,
 * sonst feuert die Sync-Callback während des Entsorgens auf einen bereits
 * disposed Chart (`Object is disposed` / `removeSeries: Value is undefined`)
 * und reißt beim Unmount die ganze App weiß.
 */
function linkTimeScales(charts: IChartApi[]): () => void {
  let syncing = false;
  let disposed = false;
  const offs: (() => void)[] = [];
  for (const src of charts) {
    const handler = (range: LogicalRange | null) => {
      if (disposed || syncing || !range) return;
      syncing = true;
      for (const tgt of charts) {
        if (tgt === src) continue;
        try {
          tgt.timeScale().setVisibleLogicalRange(range);
        } catch {
          /* Ziel-Chart schon entsorgt — ignorieren */
        }
      }
      syncing = false;
    };
    src.timeScale().subscribeVisibleLogicalRangeChange(handler);
    offs.push(() => {
      try {
        src.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
      } catch {
        /* Chart schon entsorgt */
      }
    });
  }
  return () => {
    disposed = true;
    for (const off of offs) off();
  };
}

const baseChartOptions = (timeframe: Timeframe, height: number) => ({
  height,
  layout: { background: { color: 'transparent' }, textColor: C.mut, fontSize: 10 },
  grid: { vertLines: { color: 'rgba(99,140,255,0.05)' }, horzLines: { color: 'rgba(99,140,255,0.05)' } },
  crosshair: { mode: CrosshairMode.Normal },
  rightPriceScale: { borderColor: 'rgba(99,140,255,0.18)' },
  timeScale: { borderColor: 'rgba(99,140,255,0.18)', timeVisible: timeframe !== '1d', rightOffset: 4 },
});

export function AssetChart({
  symbol,
  initialTimeframe = '1h',
  levels,
}: {
  symbol: string;
  initialTimeframe?: Timeframe;
  /** Optionale Signal-Level (Entry/SL/TP) — für die Einbettung in Signal-Karten. */
  levels?: { entry: number; stopLoss: number; takeProfits: number[] };
}) {
  const { t } = useTranslation();
  const [tf, setTf] = useState<Timeframe>(initialTimeframe);
  const [toggles, setToggles] = useState<Record<ToggleKey, boolean>>(DEFAULT_TOGGLES);
  const [data, setData] = useState<ChartData | null>(null);
  const [signals, setSignals] = useState<SignalMarker[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'empty'>('loading');

  const priceRef = useRef<HTMLDivElement>(null);
  const rsiRef = useRef<HTMLDivElement>(null);
  const macdRef = useRef<HTMLDivElement>(null);
  const atrRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);

  // Daten laden (Symbol/TF) — echte Kerzen + alle Indikatorserien
  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setData(null);
    void trpc.market.chartData
      .query({ symbol, timeframe: tf, limit: 400 })
      .then((res) => {
        if (cancelled) return;
        if (!res.available || res.candles.length === 0) {
          setState('empty');
          return;
        }
        setData(res as ChartData);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('empty');
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, tf]);

  // Signale dieses Symbols (Feature 2): offen + Historie, als Chart-Marker
  useEffect(() => {
    let cancelled = false;
    void trpc.signals.list
      .query({ symbol, status: ['new', 'confirmed', 'filled', 'closed', 'rejected', 'expired'], limit: 200 })
      .then((rows) => {
        if (!cancelled) {
          setSignals(
            rows.map((r) => ({
              createdAt: new Date(r.createdAt as unknown as string).toISOString(),
              direction: r.direction,
              setupType: r.setupType,
              status: r.status,
            })),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setSignals([]);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const activeZones = useMemo(() => (data?.zones ?? []).filter((z) => z.active).slice(0, 6), [data]);

  // Charts (neu)bauen bei Daten- oder Toggle-Änderung
  useEffect(() => {
    if (state !== 'ready' || !data || !priceRef.current) return;
    const charts: IChartApi[] = [];
    const cleanups: (() => void)[] = [];

    // ── Hauptchart: Kerzen ──
    const priceEl = priceRef.current;
    const price = createChart(priceEl, { width: priceEl.clientWidth, ...baseChartOptions(tf, 340) });
    charts.push(price);
    const candle = price.addCandlestickSeries({
      upColor: C.green,
      downColor: C.red,
      borderUpColor: C.green,
      borderDownColor: C.red,
      wickUpColor: 'rgba(61,220,151,0.6)',
      wickDownColor: 'rgba(255,92,108,0.6)',
      priceLineVisible: false,
    });
    candle.setData(data.candles as never);

    // Volumen (Overlay unten)
    if (toggles.volume) {
      const vol = price.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
      price.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      vol.setData(data.volume as never);
    }

    // EMA-Overlays
    if (toggles.ema) {
      const addLine = (pts: { time: number; value: number }[], color: string) => {
        if (pts.length === 0) return;
        const s = price.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        s.setData(pts as never);
      };
      addLine(data.ema.e20, C.amber);
      addLine(data.ema.e50, C.cyan);
      addLine(data.ema.e200, C.violet);
    }

    // Bollinger-Bänder
    if (toggles.bollinger) {
      const addBand = (pts: { time: number; value: number }[], style: LineStyle) => {
        if (pts.length === 0) return;
        const s = price.addLineSeries({ color: C.faint, lineWidth: 1, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        s.setData(pts as never);
      };
      addBand(data.bollinger.upper, LineStyle.Dotted);
      addBand(data.bollinger.middle, LineStyle.Dashed);
      addBand(data.bollinger.lower, LineStyle.Dotted);
    }

    // Marker: Smart-Money-Struktur (BOS/CHoCH) + Signale (Feature 2) auf EINER
    // Serie zusammengeführt (setMarkers ersetzt sonst die jeweils anderen).
    const markers: SeriesMarker<Time>[] = [];
    if (toggles.structure && data.structure.length > 0) {
      for (const e of data.structure.slice(-40)) {
        markers.push({
          time: e.time as UTCTimestamp,
          position: e.direction === 'bullish' ? 'belowBar' : 'aboveBar',
          color: e.kind === 'CHoCH' ? C.amber : e.direction === 'bullish' ? C.green : C.red,
          shape: e.direction === 'bullish' ? 'arrowUp' : 'arrowDown',
          text: e.kind,
        });
      }
    }
    if (toggles.signals && signals.length > 0 && data.candles.length > 0) {
      const first = data.candles[0]!.time as number;
      const last = data.candles[data.candles.length - 1]!.time as number;
      for (const s of signals) {
        const sec = Math.floor(new Date(s.createdAt).getTime() / 1000);
        if (sec < first || sec > last) continue; // außerhalb des Fensters → kein Marker
        const long = s.direction === 'long';
        markers.push({
          time: sec as UTCTimestamp,
          position: long ? 'belowBar' : 'aboveBar',
          color: SIGNAL_STATUS_COLOR[s.status],
          shape: long ? 'arrowUp' : 'arrowDown',
          text: `${long ? 'L' : 'S'}·${s.setupType.slice(0, 4)}·${SIGNAL_STATUS_LABEL[s.status]}`,
        });
      }
    }
    if (markers.length > 0) {
      markers.sort((a, b) => (a.time as number) - (b.time as number));
      candle.setMarkers(markers);
    }

    // Zonen (Order Blocks / FVG) — aktive als farbige Level-Paare
    if (toggles.zones) {
      for (const z of activeZones) {
        const bull = z.kind.startsWith('bullish');
        const isFvg = z.kind.endsWith('fvg');
        const color = bull ? 'rgba(61,220,151,0.5)' : 'rgba(255,92,108,0.5)';
        const title = `${isFvg ? 'FVG' : 'OB'} ${bull ? '↑' : '↓'}`;
        candle.createPriceLine({ price: z.top, color, lineWidth: 1, lineStyle: LineStyle.SparseDotted, axisLabelVisible: false, title });
        candle.createPriceLine({ price: z.bottom, color, lineWidth: 1, lineStyle: LineStyle.SparseDotted, axisLabelVisible: false, title: '' });
      }
    }

    // Signal-Level (nur bei Einbettung in Signal-Karten)
    if (levels) {
      candle.createPriceLine({ price: levels.entry, color: C.cyan, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'Entry' });
      candle.createPriceLine({ price: levels.stopLoss, color: C.red, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'SL' });
      levels.takeProfits.forEach((tp, i) =>
        candle.createPriceLine({ price: tp, color: C.green, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `TP${i + 1}` }),
      );
    }

    // Crosshair-Legende (OHLC-Readout)
    const legendEl = legendRef.current;
    const onMove = (param: Parameters<Parameters<typeof price.subscribeCrosshairMove>[0]>[0]) => {
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
    price.subscribeCrosshairMove(onMove);
    cleanups.push(() => price.unsubscribeCrosshairMove(onMove));

    // ── Oszillator-Panels (separate, zeitsynchrone Charts) ──
    const buildPane = (
      el: HTMLDivElement,
      draw: (chart: IChartApi) => void,
    ): IChartApi => {
      const c = createChart(el, { width: el.clientWidth, ...baseChartOptions(tf, 120) });
      c.timeScale().applyOptions({ visible: false });
      draw(c);
      charts.push(c);
      return c;
    };

    if (toggles.rsi && rsiRef.current && data.rsi.length > 0) {
      buildPane(rsiRef.current, (c) => {
        const s = c.addLineSeries({ color: C.cyan, lineWidth: 1, priceLineVisible: false, lastValueVisible: true });
        s.setData(data.rsi as never);
        s.createPriceLine({ price: 70, color: 'rgba(255,92,108,0.4)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '70' });
        s.createPriceLine({ price: 30, color: 'rgba(61,220,151,0.4)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '30' });
      });
    }
    if (toggles.macd && macdRef.current && data.macd.line.length > 0) {
      buildPane(macdRef.current, (c) => {
        const h = c.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
        h.setData(data.macd.histogram as never);
        const line = c.addLineSeries({ color: C.cyan, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
        line.setData(data.macd.line as never);
        const sig = c.addLineSeries({ color: C.amber, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
        sig.setData(data.macd.signal as never);
      });
    }
    if (toggles.atr && atrRef.current && data.atr.length > 0) {
      buildPane(atrRef.current, (c) => {
        const s = c.addLineSeries({ color: C.violet, lineWidth: 1, priceLineVisible: false, lastValueVisible: true });
        s.setData(data.atr as never);
      });
    }

    price.timeScale().fitContent();
    const unlinkTimeScales = linkTimeScales(charts);

    // Alle Charts teilen sich die Spaltenbreite (gleiche linke/rechte Kante).
    const observer = new ResizeObserver(() => {
      const w = priceEl.clientWidth;
      for (const c of charts) c.applyOptions({ width: w });
    });
    observer.observe(priceEl);
    cleanups.push(() => observer.disconnect());

    return () => {
      // Reihenfolge ist kritisch: erst Sync-Kopplung + Observer/Subscriptions
      // lösen, DANN die Charts entsorgen — sonst feuert eine Callback auf einen
      // schon disposed Chart und der Fehler reißt beim Unmount die App weiß.
      unlinkTimeScales();
      for (const fn of cleanups) fn();
      for (const c of charts) {
        try {
          c.remove();
        } catch {
          /* schon entsorgt — ignorieren */
        }
      }
    };
  }, [state, data, toggles, tf, levels, activeZones, signals]);

  const chip = (key: ToggleKey, label: string) => (
    <button
      key={key}
      onClick={() => setToggles((prev) => ({ ...prev, [key]: !prev[key] }))}
      className="rounded border px-2 py-0.5 text-[11px] transition-colors"
      style={{
        borderColor: toggles[key] ? 'rgba(79,209,255,0.5)' : 'var(--color-line)',
        color: toggles[key] ? 'var(--color-cyan)' : 'var(--color-mut)',
        background: toggles[key] ? 'rgba(79,209,255,0.08)' : 'transparent',
      }}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {TIMEFRAMES.map((f) => (
            <button
              key={f}
              onClick={() => setTf(f)}
              className="num rounded border px-2 py-0.5 text-[11px] transition-colors"
              style={{
                borderColor: tf === f ? 'rgba(79,209,255,0.5)' : 'var(--color-line)',
                color: tf === f ? 'var(--color-cyan)' : 'var(--color-mut)',
                background: tf === f ? 'rgba(79,209,255,0.08)' : 'transparent',
              }}
            >
              {f}
            </button>
          ))}
        </div>
        <span className="mx-1 h-4 w-px" style={{ background: 'var(--color-line)' }} />
        <div className="flex flex-wrap gap-1">
          {chip('ema', 'EMA 20/50/200')}
          {chip('bollinger', 'Bollinger')}
          {chip('volume', t('chart.volume'))}
          {chip('structure', 'BOS/CHoCH')}
          {chip('zones', 'OB/FVG')}
          {chip('signals', 'Signale')}
          {chip('rsi', 'RSI')}
          {chip('macd', 'MACD')}
          {chip('atr', 'ATR')}
        </div>
      </div>

      {state === 'loading' && (
        <div className="flex h-[340px] items-center justify-center text-sm" style={{ color: 'var(--color-mut)' }}>
          {t('common.loading')}
        </div>
      )}
      {state === 'empty' && (
        <div className="flex h-[200px] items-center justify-center rounded border p-4 text-center text-sm leading-relaxed" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
          {t('chart.noData', { symbol })}
        </div>
      )}

      <div style={{ display: state === 'ready' ? 'block' : 'none' }}>
        <div className="relative">
          <div ref={legendRef} className="num pointer-events-none absolute left-2 top-1 z-10 text-[11px]" style={{ opacity: 0 }} />
          <div ref={priceRef} className="w-full overflow-hidden rounded" style={{ background: 'rgba(4,6,20,0.45)' }} />
        </div>
        {toggles.rsi && (
          <div className="mt-1">
            <p className="label px-2">RSI 14</p>
            <div ref={rsiRef} className="w-full overflow-hidden rounded" style={{ background: 'rgba(4,6,20,0.45)' }} />
          </div>
        )}
        {toggles.macd && (
          <div className="mt-1">
            <p className="label px-2">MACD 12/26/9</p>
            <div ref={macdRef} className="w-full overflow-hidden rounded" style={{ background: 'rgba(4,6,20,0.45)' }} />
          </div>
        )}
        {toggles.atr && (
          <div className="mt-1">
            <p className="label px-2">ATR 14</p>
            <div ref={atrRef} className="w-full overflow-hidden rounded" style={{ background: 'rgba(4,6,20,0.45)' }} />
          </div>
        )}
        {data && data.zonesTotal > activeZones.length && (
          <p className="label mt-1.5 px-2">{t('chart.zonesInfo', { shown: activeZones.length, total: data.zonesTotal })}</p>
        )}
        <p className="label mt-1.5 px-2">{t('chart.legend')}</p>
      </div>
    </div>
  );
}
