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
import { loadTf, pickTf, saveTf } from '../lib/chart-tf.js';
import { CHART_TFS, type ChartTf } from '../lib/chart-url.js';
import {
  bollinger as calcBollinger,
  ema as calcEma,
  macd as calcMacd,
  rsi as calcRsi,
  sma as calcSma,
  loadIndicatorConfig,
  MA_COLORS,
  saveIndicatorConfig,
  toTimedSeries,
  type IndicatorConfig,
} from '../lib/indicators.js';
import { ChartIndicatorPanel, type PineStrategy } from './ChartIndicatorPanel.js';

/**
 * Voll-Chart mit Indikatoren (Krypto-Charting):
 * echte DB-Kerzen + EMA 20/50/200, Bollinger, Volumen, Smart-Money-Marker
 * (BOS/CHoCH, Order Blocks, FVG) und synchronisierte RSI/MACD/ATR-Panels.
 * Alle Serien rechnen serverseitig auf denselben Kerzen wie die Signal-Engine —
 * self-hosted (kein CDN), nichts erfunden.
 */

type ChartData = Extract<Awaited<ReturnType<typeof trpc.market.chartData.query>>, { available: true }>;
type Timeframe = ChartTf;

/** Timeframes, die auch ohne DB-Abfrage sicher vorhanden sind (Fallback vor dem Laden). */
const BASE_TIMEFRAMES: Timeframe[] = ['15m', '1h', '4h', '1d'];

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
  /** Slug der erzeugenden Strategie — Grundlage für die Strategie-Marker (Pine/DSL). */
  strategySlug: string;
};

/** Zeitgestempelte Chart-Serie (Form der Server-Serien aus market.chartData). */
type TimedSeries = { time: number; value: number }[];

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
  timeScale: {
    borderColor: 'rgba(99,140,255,0.18)',
    // Uhrzeit nur bei Intraday-TFs; Tages-/Wochen-/Monatskerzen zeigen nur das Datum.
    timeVisible: !['1d', '1w', '1M'].includes(timeframe),
    rightOffset: 4,
  },
});

export function AssetChart({
  symbol,
  initialTimeframe = '1h',
  timeframeOverride,
  levels,
}: {
  symbol: string;
  initialTimeframe?: Timeframe;
  /** Erzwungener Timeframe aus einem Deep-Link (`?tf=`) — schlägt das Gedächtnis. */
  timeframeOverride?: Timeframe;
  /** Optionale Signal-Level (Entry/SL/TP) — für die Einbettung in Signal-Karten. */
  levels?: { entry: number; stopLoss: number; takeProfits: number[] };
}) {
  const { t } = useTranslation();
  // Timeframe pro Asset gemerkt (P0.2): Query-Override > gemerkt > Default.
  const [tf, setTf] = useState<Timeframe>(() => pickTf(timeframeOverride ?? null, loadTf(symbol), initialTimeframe));
  const firstSymbolRender = useRef(true);
  // Symbolwechsel (z. B. via Dropdown): den für dieses Asset gemerkten Timeframe laden.
  useEffect(() => {
    if (firstSymbolRender.current) {
      firstSymbolRender.current = false;
      return;
    }
    setTf(loadTf(symbol) ?? initialTimeframe);
  }, [symbol, initialTimeframe]);
  const changeTf = (next: Timeframe) => {
    setTf(next);
    saveTf(symbol, next);
  };
  // Verfügbare Timeframes je Asset (Feature A): nur die, für die echte Kerzen in
  // der DB liegen. Vor dem Laden Fallback auf die Basis-TFs; der aktuelle TF wird
  // immer angeboten (sonst säße man auf einem leeren Chart fest).
  const [availableTfs, setAvailableTfs] = useState<Timeframe[]>(BASE_TIMEFRAMES);
  useEffect(() => {
    let cancelled = false;
    void trpc.market.availableTimeframes
      .query({ symbol })
      .then((tfs) => {
        if (!cancelled && tfs.length > 0) setAvailableTfs(tfs as Timeframe[]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [symbol]);
  const shownTfs = CHART_TFS.filter((f) => availableTfs.includes(f) || f === tf);
  const [toggles, setToggles] = useState<Record<ToggleKey, boolean>>(DEFAULT_TOGGLES);
  const [data, setData] = useState<ChartData | null>(null);
  const [signals, setSignals] = useState<SignalMarker[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'empty'>('loading');

  // Eigene Indikatoren (Patrick): Konfiguration pro Symbol in localStorage
  // ('gladiator.chartIndicators.<symbol>'), Panel auf-/zuklappbar.
  const [indCfg, setIndCfg] = useState<IndicatorConfig>(() => loadIndicatorConfig(symbol));
  const [showIndPanel, setShowIndPanel] = useState(false);
  const firstCfgRender = useRef(true);
  useEffect(() => {
    // Beim Mount hat der useState-Initializer schon geladen — nur bei echtem
    // Symbolwechsel neu laden (sonst unnötiger Chart-Neubau direkt nach Start).
    if (firstCfgRender.current) {
      firstCfgRender.current = false;
      return;
    }
    setIndCfg(loadIndicatorConfig(symbol));
  }, [symbol]);
  const updateIndCfg = (next: IndicatorConfig) => {
    setIndCfg(next);
    saveIndicatorConfig(symbol, next);
  };

  // Pine-/DSL-Strategien für die Strategie-Marker (einmal laden; 'error' = ehrlich).
  const [pineStrategies, setPineStrategies] = useState<PineStrategy[] | 'error' | null>(null);
  useEffect(() => {
    let cancelled = false;
    void trpc.strategies.list
      .query()
      .then((rows) => {
        if (cancelled) return;
        setPineStrategies(
          rows
            .filter((r) => r.kind === 'pine' || r.kind === 'dsl')
            .map((r) => ({ slug: r.slug, name: r.name, kind: r.kind as 'pine' | 'dsl' })),
        );
      })
      .catch(() => {
        if (!cancelled) setPineStrategies('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const priceRef = useRef<HTMLDivElement>(null);
  const rsiRef = useRef<HTMLDivElement>(null);
  const macdRef = useRef<HTMLDivElement>(null);
  const atrRef = useRef<HTMLDivElement>(null);
  const custRsiRef = useRef<HTMLDivElement>(null);
  const custMacdRef = useRef<HTMLDivElement>(null);
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
              strategySlug: r.strategySlug,
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

  /**
   * Eigene Indikator-Serien aus der Panel-Konfiguration. WARUM so: wo die
   * Periode den Server-Defaults entspricht (EMA 20/50/200, RSI 14, MACD 12/26/9,
   * Bollinger 20/2), wird die Server-Serie WIEDERVERWENDET (eine Wahrheit, exakt
   * die Zahlen der Signal-Engine); alle anderen Perioden rechnet der Browser mit
   * identischer Mathematik (lib/indicators.ts) auf denselben Kerzen.
   */
  const customSeries = useMemo(() => {
    if (!data) return null;
    const times = data.candles.map((c) => c.time);
    const closes = data.candles.map((c) => c.close);

    const mas = indCfg.mas.map((m, i) => {
      const server =
        m.kind === 'ema'
          ? m.period === 20
            ? data.ema.e20
            : m.period === 50
              ? data.ema.e50
              : m.period === 200
                ? data.ema.e200
                : null
          : null;
      return {
        label: `${m.kind.toUpperCase()} ${m.period}`,
        color: MA_COLORS[i % MA_COLORS.length]!,
        points: server ?? toTimedSeries(times, (m.kind === 'ema' ? calcEma : calcSma)(closes, m.period)),
      };
    });

    const rsiSeries: TimedSeries | null = indCfg.rsi.on
      ? indCfg.rsi.period === 14
        ? data.rsi
        : toTimedSeries(times, calcRsi(closes, indCfg.rsi.period))
      : null;

    let macdSeries: { line: TimedSeries; signal: TimedSeries; histogram: { time: number; value: number; color: string }[] } | null = null;
    if (indCfg.macd.on) {
      const { fast, slow, signal } = indCfg.macd;
      if (fast === 12 && slow === 26 && signal === 9) {
        macdSeries = data.macd;
      } else {
        const m = calcMacd(closes, fast, slow, signal);
        macdSeries = {
          line: toTimedSeries(times, m.macd),
          signal: toTimedSeries(times, m.signal),
          // Histogramm-Färbung wie die Server-Serie (grün ≥ 0, rot < 0)
          histogram: m.histogram
            .map((v, i) => (v != null && Number.isFinite(v) ? { time: times[i]!, value: v, color: v >= 0 ? '#3ddc97' : '#ff5c6c' } : null))
            .filter((x): x is { time: number; value: number; color: string } => x !== null),
        };
      }
    }

    let bollSeries: { upper: TimedSeries; middle: TimedSeries; lower: TimedSeries } | null = null;
    if (indCfg.bollinger.on) {
      if (indCfg.bollinger.period === 20 && indCfg.bollinger.mult === 2) {
        bollSeries = data.bollinger;
      } else {
        const b = calcBollinger(closes, indCfg.bollinger.period, indCfg.bollinger.mult);
        bollSeries = {
          upper: toTimedSeries(times, b.upper),
          middle: toTimedSeries(times, b.middle),
          lower: toTimedSeries(times, b.lower),
        };
      }
    }

    return { mas, rsi: rsiSeries, macd: macdSeries, bollinger: bollSeries };
  }, [data, indCfg]);

  /** Signale der im Panel gewählten Pine-/DSL-Strategien (für Entry-Marker). */
  const strategySignals = useMemo(
    () => (indCfg.strategySlugs.length === 0 ? [] : signals.filter((s) => indCfg.strategySlugs.includes(s.strategySlug))),
    [signals, indCfg.strategySlugs],
  );

  /** Anzahl aktiver eigener Elemente — für die Zahl am Panel-Knopf. */
  const activeCustomCount =
    indCfg.mas.length +
    (indCfg.rsi.on ? 1 : 0) +
    (indCfg.macd.on ? 1 : 0) +
    (indCfg.bollinger.on ? 1 : 0) +
    indCfg.strategySlugs.length;

  /** Ehrlicher Hinweis: aktive eigene Serien, die (noch) keine Werte haben (Periode > geladene Kerzen). */
  const emptyCustomLabels = useMemo(() => {
    if (!customSeries) return [] as string[];
    const out: string[] = [];
    for (const m of customSeries.mas) if (m.points.length === 0) out.push(m.label);
    if (customSeries.rsi && customSeries.rsi.length === 0) out.push(`RSI ${indCfg.rsi.period}`);
    if (customSeries.macd && customSeries.macd.signal.length === 0) out.push(`MACD ${indCfg.macd.fast}/${indCfg.macd.slow}/${indCfg.macd.signal}`);
    if (customSeries.bollinger && customSeries.bollinger.middle.length === 0) out.push(`Bollinger ${indCfg.bollinger.period}`);
    return out;
  }, [customSeries, indCfg]);

  /**
   * Indikator-Warmup (Patrick: „ab welcher Kerze läuft ein Indikator wirklich"):
   * die erste definierte Kerze je aktivem Indikator. EMA200 braucht 200 Kerzen,
   * RSI 14 usw. — bis dahin ist der Indikator ehrlich NICHT definiert.
   */
  const warmupInfo = useMemo(() => {
    const items: { label: string; bar: number; time: number }[] = [];
    if (!data) return items;
    const idxOf = (time?: number) => (time == null ? -1 : data.candles.findIndex((c) => c.time === time));
    const add = (on: boolean, label: string, series: { time: number }[]) => {
      if (!on || series.length === 0) return;
      const t0 = series[0]!.time;
      const bar = idxOf(t0);
      if (bar >= 0) items.push({ label, bar: bar + 1, time: t0 });
    };
    add(toggles.ema, 'EMA200', data.ema.e200);
    add(toggles.bollinger, 'Bollinger', data.bollinger.middle);
    add(toggles.rsi, 'RSI', data.rsi);
    add(toggles.macd, 'MACD', data.macd.signal);
    add(toggles.atr, 'ATR', data.atr);
    // Eigene Indikatoren aus dem Panel — auch für sie gilt der ehrliche Warmup.
    if (customSeries) {
      for (const m of customSeries.mas) add(true, m.label, m.points);
      add(customSeries.rsi != null, `RSI ${indCfg.rsi.period}`, customSeries.rsi ?? []);
      add(customSeries.macd != null, `MACD ${indCfg.macd.fast}/${indCfg.macd.slow}/${indCfg.macd.signal}`, customSeries.macd?.signal ?? []);
      add(customSeries.bollinger != null, `BB ${indCfg.bollinger.period}`, customSeries.bollinger?.middle ?? []);
    }
    return items.sort((a, b) => a.bar - b.bar);
  }, [data, toggles, customSeries, indCfg]);

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

    // ── Eigene Indikatoren (Panel): frei gewählte EMA/SMA + eigenes Bollinger ──
    // Eigene Linien bewusst kräftiger (lineWidth 2) und mit Achsen-Label,
    // damit Patrick SEINE Linien sofort von den Standard-EMAs unterscheidet.
    if (customSeries) {
      for (const m of customSeries.mas) {
        if (m.points.length === 0) continue;
        const s = price.addLineSeries({
          color: m.color,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
          title: m.label,
        });
        s.setData(m.points as never);
      }
      if (customSeries.bollinger) {
        const addCustomBand = (pts: { time: number; value: number }[], style: LineStyle) => {
          if (pts.length === 0) return;
          const s = price.addLineSeries({
            color: 'rgba(139,92,246,0.5)', // violett — unterscheidbar vom grauen Standard-Bollinger
            lineWidth: 1,
            lineStyle: style,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          s.setData(pts as never);
        };
        addCustomBand(customSeries.bollinger.upper, LineStyle.Dotted);
        addCustomBand(customSeries.bollinger.middle, LineStyle.Dashed);
        addCustomBand(customSeries.bollinger.lower, LineStyle.Dotted);
      }
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
    const selectedSlugs = new Set(indCfg.strategySlugs);
    if (toggles.signals && signals.length > 0 && data.candles.length > 0) {
      const first = data.candles[0]!.time as number;
      const last = data.candles[data.candles.length - 1]!.time as number;
      for (const s of signals) {
        // Signale gewählter Strategien bekommen unten einen eigenen, aussage-
        // kräftigeren Strategie-Marker — Doppel-Marker auf derselben Kerze vermeiden.
        if (selectedSlugs.has(s.strategySlug)) continue;
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
    // Strategie-Marker (Patrick: „eigene Pine Scripts anzeigen"): Entry-Marker
    // der gewählten Pine-/DSL-Strategien. EHRLICH: kein Pine-Rendering — die
    // Signale stammen aus Strategien → Import (TradingView-Alert bzw. DSL-Engine).
    if (strategySignals.length > 0 && data.candles.length > 0) {
      const first = data.candles[0]!.time as number;
      const last = data.candles[data.candles.length - 1]!.time as number;
      for (const s of strategySignals) {
        const sec = Math.floor(new Date(s.createdAt).getTime() / 1000);
        if (sec < first || sec > last) continue;
        const long = s.direction === 'long';
        markers.push({
          time: sec as UTCTimestamp,
          position: long ? 'belowBar' : 'aboveBar',
          color: '#e14ecf', // magenta — im Marker-Farbschema sonst ungenutzt
          shape: 'square',
          text: `▣ ${s.strategySlug.slice(0, 12)}·${long ? 'L' : 'S'}·${SIGNAL_STATUS_LABEL[s.status]}`,
        });
      }
    }
    // Warmup-Markierung: ab welcher Kerze der langsamste aktive Indikator läuft
    if (warmupInfo.length > 0) {
      const slowest = warmupInfo[warmupInfo.length - 1]!;
      markers.push({
        time: slowest.time as UTCTimestamp,
        position: 'aboveBar',
        color: C.mut,
        shape: 'circle',
        text: `▸ ${t('chart.warmupMarker')}`,
      });
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

    // ── Eigene Oszillator-Panels (Panel-Konfiguration, freie Perioden) ──
    const custRsi = customSeries?.rsi ?? null;
    if (custRsi && custRsi.length > 0 && custRsiRef.current) {
      buildPane(custRsiRef.current, (c) => {
        const s = c.addLineSeries({ color: '#e14ecf', lineWidth: 1, priceLineVisible: false, lastValueVisible: true });
        s.setData(custRsi as never);
        s.createPriceLine({ price: 70, color: 'rgba(255,92,108,0.4)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '70' });
        s.createPriceLine({ price: 30, color: 'rgba(61,220,151,0.4)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '30' });
      });
    }
    const custMacd = customSeries?.macd ?? null;
    if (custMacd && custMacd.line.length > 0 && custMacdRef.current) {
      buildPane(custMacdRef.current, (c) => {
        const h = c.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
        h.setData(custMacd.histogram as never);
        const line = c.addLineSeries({ color: C.cyan, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
        line.setData(custMacd.line as never);
        const sig = c.addLineSeries({ color: C.amber, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
        sig.setData(custMacd.signal as never);
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
  }, [state, data, toggles, tf, levels, activeZones, signals, warmupInfo, t, customSeries, strategySignals, indCfg]);

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
        <div className="flex flex-wrap gap-1">
          {shownTfs.map((f) => (
            <button
              key={f}
              onClick={() => changeTf(f)}
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
        <span className="mx-1 h-4 w-px" style={{ background: 'var(--color-line)' }} />
        {/* Eigene Indikatoren + Strategie-Marker (Patricks Wunsch) — violett = „meins" */}
        <button
          onClick={() => setShowIndPanel((v) => !v)}
          className="rounded border px-2 py-0.5 text-[11px] transition-colors"
          aria-expanded={showIndPanel}
          style={{
            borderColor: showIndPanel || activeCustomCount > 0 ? 'rgba(139,92,246,0.55)' : 'var(--color-line)',
            color: showIndPanel || activeCustomCount > 0 ? 'var(--color-violet)' : 'var(--color-mut)',
            background: showIndPanel ? 'rgba(139,92,246,0.1)' : 'transparent',
          }}
        >
          ⚙ {t('chart.ind.button')}
          {activeCustomCount > 0 ? <span className="num"> ({activeCustomCount})</span> : null}
        </button>
      </div>

      {showIndPanel && (
        <div className="mb-2">
          <ChartIndicatorPanel
            config={indCfg}
            onChange={updateIndCfg}
            strategies={pineStrategies}
            strategySignalCount={strategySignals.length}
          />
        </div>
      )}

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
        {/* Eigene Oszillator-Panels — Beschriftung mit Periode + „eigene", damit
            sie neben den Standard-Panels klar zuzuordnen sind */}
        {customSeries?.rsi && customSeries.rsi.length > 0 && (
          <div className="mt-1">
            <p className="label px-2">RSI {indCfg.rsi.period} · {t('chart.ind.customTag')}</p>
            <div ref={custRsiRef} className="w-full overflow-hidden rounded" style={{ background: 'rgba(4,6,20,0.45)' }} />
          </div>
        )}
        {customSeries?.macd && customSeries.macd.line.length > 0 && (
          <div className="mt-1">
            <p className="label px-2">
              MACD {indCfg.macd.fast}/{indCfg.macd.slow}/{indCfg.macd.signal} · {t('chart.ind.customTag')}
            </p>
            <div ref={custMacdRef} className="w-full overflow-hidden rounded" style={{ background: 'rgba(4,6,20,0.45)' }} />
          </div>
        )}
        {emptyCustomLabels.length > 0 && (
          <p className="label mt-1.5 px-2" style={{ color: 'var(--color-warn)' }}>
            {t('chart.ind.tooFewCandles', { list: emptyCustomLabels.join(', ') })}
          </p>
        )}
        {data && data.zonesTotal > activeZones.length && (
          <p className="label mt-1.5 px-2">{t('chart.zonesInfo', { shown: activeZones.length, total: data.zonesTotal })}</p>
        )}
        {warmupInfo.length > 0 && (
          <p className="label mt-1.5 px-2">
            {t('chart.warmupTitle')}{' '}
            {warmupInfo.map((w) => `${w.label} ${t('chart.warmupBar', { bar: w.bar })}`).join(' · ')}
          </p>
        )}
        <p className="label mt-1.5 px-2">{t('chart.legend')}</p>
      </div>
    </div>
  );
}
