import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { IndicatorRenderer, type PlotOverride } from 'lightweight-charts-indicators/render';
import type { Bar as PineBar, IndicatorResult } from 'oakscriptjs';
import { useTranslation } from 'react-i18next';
import { trpc } from '../api.js';
import { paneLayout, type PaneSpec } from '../lib/chart-panes.js';
import { loadTf, pickTf, saveTf } from '../lib/chart-tf.js';
import { CHART_TFS, type ChartTf, type ChartVenue } from '../lib/chart-url.js';
import { loadStrategySlugs, saveStrategySlugs } from '../lib/chart-strategy-markers.js';
import { cachedCatalog, loadCatalog } from '../lib/indicator-catalog.js';
import { CATEGORY_KEYS, firstPlotTime, instanceLabel, legendColor, visiblePlotIds, type InstanceStyle, type MenuEntry } from '../lib/indicator-menu.js';
import { clearVisibleInterval, setVisibleInterval } from '../lib/visible-interval.js';
import { IndicatorMenu, type PineStrategy } from './IndicatorMenu.js';
import { IndicatorSettings } from './IndicatorSettings.js';
import { applyTick, liveBarSeconds, type Bar } from '../lib/live-candle.js';
import { ensurePriceStream, onTick } from '../lib/prices.js';
import { applyDrawingClick, pickDrawing, pointFromChart, translatePoints, type DrawingTool } from '../lib/chart-drawings.js';
import type { DrawingPoint } from '@gladiator/core/drawings';
import { DrawingsPrimitive, type ChartDrawing } from './chart-drawings-primitive.js';
import { SmcBoxesPrimitive, type SmcItem } from './smc-boxes-primitive.js';
import { appLocale } from '../lib/locale.js';

/**
 * Voll-Chart mit Indikatoren (Krypto-Charting):
 * echte DB-Kerzen + EMA 20/50/200, Bollinger, Volumen, Smart-Money-Marker
 * (BOS/CHoCH, Order Blocks, FVG), synchronisierte RSI/MACD/ATR-Panels und die
 * Indikator-Bibliothek (162 Pine-kompatible Indikatoren/Muster, je Nutzer+Symbol
 * in der DB). Alle Serien rechnen serverseitig auf denselben Kerzen wie die
 * Signal-Engine — self-hosted (kein CDN), nichts erfunden.
 */

type ChartData = Extract<Awaited<ReturnType<typeof trpc.market.chartData.query>>, { available: true }>;
type Timeframe = ChartTf;

/** Timeframes, die auch ohne DB-Abfrage sicher vorhanden sind (Fallback vor dem Laden). */
const BASE_TIMEFRAMES: Timeframe[] = ['15m', '1h', '4h', '1d'];

const C = {
  cyan: '#60a5fa',
  green: '#22c55e',
  red: '#ef4444',
  violet: '#94a3b8',
  amber: '#f5b642',
  mut: '#8b94b8',
  faint: 'rgba(139,148,184,0.35)',
};

type ToggleKey = 'ema' | 'bollinger' | 'volume' | 'structure' | 'zones' | 'liquidity' | 'pd' | 'signals' | 'rsi' | 'macd' | 'atr';
const DEFAULT_TOGGLES: Record<ToggleKey, boolean> = {
  ema: true,
  bollinger: false,
  volume: true,
  structure: false,
  zones: false,
  liquidity: false,
  pd: false,
  signals: true,
  rsi: false,
  macd: false,
  atr: false,
};
const TOGGLES_KEY = 'gladiator.chartToggles';
const SMC_KEYS: ToggleKey[] = ['structure', 'zones', 'liquidity'];
const BUILTIN_KEYS: ToggleKey[] = ['ema', 'bollinger', 'volume', 'rsi', 'macd', 'atr'];
const SMC_ALL_KEYS: ToggleKey[] = ['structure', 'zones', 'liquidity', 'pd', 'signals'];

/** Ansicht (welche Serien der Chart zeigt) ist eine Browser-Vorliebe — Unbekanntes → Standard. */
function loadToggles(): Record<ToggleKey, boolean> {
  try {
    const raw = localStorage.getItem(TOGGLES_KEY);
    if (!raw) return DEFAULT_TOGGLES;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out = { ...DEFAULT_TOGGLES };
    for (const k of Object.keys(DEFAULT_TOGGLES) as ToggleKey[]) if (typeof parsed[k] === 'boolean') out[k] = parsed[k] as boolean;
    return out;
  } catch {
    return DEFAULT_TOGGLES;
  }
}
function saveToggles(t: Record<ToggleKey, boolean>): void {
  try {
    localStorage.setItem(TOGGLES_KEY, JSON.stringify(t));
  } catch {
    // nur Komfort
  }
}

/** Kleines Popover unter einem Werkzeug-Knopf (Ansicht, Zeichnen): Klick außerhalb oder Esc schließt. */
function ToolPopover({ label, active, open, onToggle, onClose, children }: { label: string; active?: boolean; open: boolean; onToggle: () => void; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  return (
    <div ref={ref} className="relative">
      <button type="button" className="tbtn" aria-expanded={open} aria-pressed={active} onClick={onToggle}>
        {label} <span aria-hidden="true">▾</span>
      </button>
      {open && <div className="popover">{children}</div>}
    </div>
  );
}

type SignalMarker = {
  createdAt: string;
  direction: 'long' | 'short';
  setupType: string;
  status: 'new' | 'confirmed' | 'rejected' | 'expired' | 'filled' | 'closed';
  /** Slug der erzeugenden Strategie — Grundlage für die Strategie-Marker (Pine/DSL). */
  strategySlug: string;
};

/** Farbe je Signal-Status (Feature 2): offen/bestätigt/gefüllt/geschlossen/abgelehnt. */
const SIGNAL_STATUS_COLOR: Record<SignalMarker['status'], string> = {
  new: '#60a5fa', // offen — cyan
  confirmed: '#f5b642', // bestätigt — amber
  filled: '#22c55e', // im Markt — grün
  closed: '#8b94b8', // geschlossen — grau
  rejected: '#ef4444', // abgelehnt — rot
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

const fmtPx = (n: number) => n.toLocaleString(appLocale(), { maximumFractionDigits: n >= 1000 ? 1 : 4 });

const MAIN_HEIGHT = 340;
const PANE_HEIGHT = 120;

const baseChartOptions = (timeframe: Timeframe, height: number) => ({
  height,
  layout: { background: { color: 'transparent' }, textColor: C.mut, fontSize: 10 },
  grid: { vertLines: { color: 'rgba(148,163,184,0.05)' }, horzLines: { color: 'rgba(148,163,184,0.05)' } },
  crosshair: { mode: CrosshairMode.Normal },
  panes: { separatorColor: 'rgba(148,163,184,0.18)', separatorHoverColor: 'rgba(96,165,250,0.35)', enableResize: false },
  rightPriceScale: { borderColor: 'rgba(148,163,184,0.18)' },
  timeScale: {
    borderColor: 'rgba(148,163,184,0.18)',
    // Uhrzeit nur bei Intraday-TFs; Tages-/Wochen-/Monatskerzen zeigen nur das Datum.
    timeVisible: !['1d', '1w', '1M'].includes(timeframe),
    rightOffset: 4,
  },
});

/** Gespeicherte Instanz eines Bibliotheks-Indikators (DB-Zeile, Browser-Form). */
type IndicatorInstance = { id: string; indicatorId: string; inputs: Record<string, unknown>; style: InstanceStyle; position: number };
type ComputedItem = Awaited<ReturnType<typeof trpc.indicators.compute.query>>['items'][number];

function toInstance(row: { id: string; indicatorId: string; inputs: unknown; style: unknown; position: number }): IndicatorInstance {
  return {
    id: row.id,
    indicatorId: row.indicatorId,
    inputs: (row.inputs ?? {}) as Record<string, unknown>,
    style: (row.style ?? null) as InstanceStyle,
    position: row.position,
  };
}

/** Kerzen für den Renderer (Sekunden, mit Volumen); die Live-Kerze ersetzt/ergänzt die letzte. */
function toPineBars(data: ChartData, live: PineBar | null): PineBar[] {
  const bars: PineBar[] = data.candles.map((c, i) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: data.volume[i]?.value }));
  const last = bars[bars.length - 1];
  if (live && last && live.time === last.time) bars[bars.length - 1] = { ...live, volume: last.volume };
  else if (live && last && live.time > last.time) bars.push(live);
  return bars;
}

export function AssetChart({
  symbol,
  initialTimeframe = '1h',
  timeframeOverride,
  levels,
  rememberTf = true,
  onTimeframeChange,
  venue = 'binance',
  mainHeight = MAIN_HEIGHT,
}: {
  symbol: string;
  /** Kerzenquelle: 'binance' (Krypto, Live-Ticks) oder 'twelvedata'/'yahoo' (Aktien/ETF/Forex, nur DB-Kerzen). */
  venue?: ChartVenue;
  initialTimeframe?: Timeframe;
  /** Erzwungener Timeframe aus einem Deep-Link (`?tf=`) — schlägt das Gedächtnis. */
  timeframeOverride?: Timeframe;
  /** Optionale Signal-Level (Entry/SL/TP) — für die Einbettung in Signal-Karten. */
  levels?: { entry: number; stopLoss: number; takeProfits: number[] };
  /** false = Zelle eines Mehrfach-Layouts: Zeitrahmen nicht je Symbol merken (die Zelle hält ihn selbst). */
  rememberTf?: boolean;
  onTimeframeChange?: (tf: Timeframe) => void;
  /** Höhe des Kurs-Charts in px (Vollfläche auf der Chart-Seite, kleiner in Zellen). */
  mainHeight?: number;
}) {
  const { t } = useTranslation();
  // Timeframe pro Asset gemerkt (P0.2): Query-Override > gemerkt > Default.
  const [tf, setTf] = useState<Timeframe>(() => pickTf(timeframeOverride ?? null, rememberTf ? loadTf(symbol) : null, initialTimeframe));
  const firstSymbolRender = useRef(true);
  // Symbolwechsel (z. B. via Dropdown): den für dieses Asset gemerkten Timeframe laden.
  useEffect(() => {
    if (firstSymbolRender.current) {
      firstSymbolRender.current = false;
      return;
    }
    setTf((rememberTf ? loadTf(symbol) : null) ?? timeframeOverride ?? initialTimeframe);
    // timeframeOverride absichtlich nicht als Auslöser (nur beim Symbolwechsel lesen)
  }, [symbol, initialTimeframe, rememberTf]);
  const changeTf = (next: Timeframe) => {
    setTf(next);
    if (rememberTf) saveTf(symbol, next);
    onTimeframeChange?.(next);
  };
  // Verfügbare Timeframes je Asset (Feature A): nur die, für die echte Kerzen in
  // der DB liegen. Vor dem Laden Fallback auf die Basis-TFs; der aktuelle TF wird
  // immer angeboten (sonst säße man auf einem leeren Chart fest).
  const [availableTfs, setAvailableTfs] = useState<Timeframe[]>(BASE_TIMEFRAMES);
  useEffect(() => {
    let cancelled = false;
    void trpc.market.availableTimeframes
      .query({ symbol, venue })
      .then((tfs) => {
        if (!cancelled && tfs.length > 0) setAvailableTfs(tfs as Timeframe[]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [symbol, venue]);
  const shownTfs = CHART_TFS.filter((f) => availableTfs.includes(f) || f === tf);
  const [toggles, setTogglesState] = useState<Record<ToggleKey, boolean>>(loadToggles);
  const setToggle = (key: ToggleKey, on: boolean) =>
    setTogglesState((prev) => {
      const next = { ...prev, [key]: on };
      saveToggles(next);
      return next;
    });
  const smcOn = SMC_KEYS.every((k) => toggles[k]);
  const toggleSmc = () =>
    setTogglesState((prev) => {
      const next = { ...prev };
      for (const k of SMC_KEYS) next[k] = !smcOn;
      saveToggles(next);
      return next;
    });
  const [viewOpen, setViewOpen] = useState(false);
  const [drawOpen, setDrawOpen] = useState(false);
  const [data, setData] = useState<ChartData | null>(null);
  const [signals, setSignals] = useState<SignalMarker[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'empty'>('loading');
  const stateRef = useRef(state);
  stateRef.current = state;

  // ── Bar-Replay (Repo-Masterliste, Phase 3): Kerzen nur bis zum Stichtag; der
  // Server rechnet Indikatoren, Zonen und Liquidität aus genau diesen Kerzen
  // (kein Blick in die Zukunft). Live-Ticks pausieren. Der Zeitstrahl ist das
  // zuletzt ohne Replay geladene Fenster.
  const [replay, setReplay] = useState<{ until: number; playing: boolean; speed: number } | null>(null);
  const replayRef = useRef(replay);
  replayRef.current = replay;
  const replayUntil = replay?.until ?? null;
  const replayTimesRef = useRef<number[]>([]);
  const [replayMsg, setReplayMsg] = useState<string | null>(null);
  const REPLAY_MIN = 60;
  const startReplay = () => {
    const times = replayTimesRef.current;
    if (times.length < REPLAY_MIN) {
      setReplayMsg(t('chart.replay.tooFew'));
      return;
    }
    setReplayMsg(null);
    setReplay({ until: times[Math.max(30, times.length - 100)]!, playing: false, speed: 1 });
  };
  const replayIndex = replay ? replayTimesRef.current.indexOf(replay.until) : -1;
  const replayStep = (k: number) => {
    const times = replayTimesRef.current;
    const cur = replayRef.current;
    if (!cur) return;
    const i = times.indexOf(cur.until);
    const next = times[Math.min(times.length - 1, Math.max(30, i + k))];
    if (next === undefined) return;
    const atEnd = next === cur.until;
    setReplay({ ...cur, until: next, playing: atEnd ? false : cur.playing });
  };
  useEffect(() => {
    if (!replay?.playing) return;
    const id = window.setInterval(() => {
      if (stateRef.current !== 'ready') return; // vorigen Schritt erst fertig laden
      replayStep(1);
    }, 1000 / replay.speed);
    return () => window.clearInterval(id);
  }, [replay?.playing, replay?.speed]);

  // ── Zeichenwerkzeuge (Plan §5): pro Nutzer + Symbol in der DB, Timeframe-
  // unabhängig (Zeit/Preis-Anker). Der Chart-Aufbau liest Werkzeug/Zeichnungen
  // über Refs, damit ein Werkzeugwechsel den Chart NICHT neu aufbaut.
  const [drawings, setDrawings] = useState<ChartDrawing[]>([]);
  const [drawErr, setDrawErr] = useState<string | null>(null);
  const [tool, setTool] = useState<DrawingTool>('none');
  const drawingsRef = useRef<ChartDrawing[]>([]);
  const toolRef = useRef<DrawingTool>('none');
  const pendingRef = useRef<DrawingPoint | null>(null);
  const primitiveRef = useRef<DrawingsPrimitive | null>(null);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;

  useEffect(() => {
    let cancelled = false;
    setDrawings([]);
    setDrawErr(null);
    pendingRef.current = null;
    void trpc.drawings.list
      .query({ symbol })
      .then((rows) => {
        if (!cancelled) setDrawings(rows as ChartDrawing[]);
      })
      .catch((e: unknown) => {
        if (!cancelled) setDrawErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  useEffect(() => {
    drawingsRef.current = drawings;
    primitiveRef.current?.setDrawings(drawings);
  }, [drawings]);

  const selectTool = (next: DrawingTool) => {
    const value = toolRef.current === next ? 'none' : next;
    toolRef.current = value;
    pendingRef.current = null;
    primitiveRef.current?.setPreview(null);
    setTool(value);
  };

  // Esc bricht das aktive Werkzeug bzw. den halben Zug ab.
  useEffect(() => {
    if (tool === 'none') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      toolRef.current = 'none';
      pendingRef.current = null;
      primitiveRef.current?.setPreview(null);
      setTool('none');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool]);

  const drawFail = (e: unknown) => setDrawErr(e instanceof Error ? e.message : String(e));

  const createDrawing = (kind: ChartDrawing['kind'], points: DrawingPoint[]) => {
    const forSymbol = symbolRef.current;
    void trpc.drawings.create
      .mutate({ symbol: forSymbol, kind, points })
      .then((row) => {
        if (symbolRef.current !== forSymbol) return;
        setDrawErr(null);
        setDrawings((prev) => [...prev, row as ChartDrawing]);
      })
      .catch(drawFail);
  };

  /** Verschieben speichern (optimistisch; bei Fehler zurück auf den Server-Stand). */
  const moveDrawing = (id: string, points: DrawingPoint[]) => {
    const before = drawingsRef.current;
    setDrawings((prev) => prev.map((d) => (d.id === id ? { ...d, points } : d)));
    void trpc.drawings.update
      .mutate({ id, points })
      .then(() => setDrawErr(null))
      .catch((e: unknown) => {
        setDrawings(before);
        drawFail(e);
      });
  };
  const moveDrawingRef = useRef(moveDrawing);
  moveDrawingRef.current = moveDrawing;

  const deleteDrawing = (id: string) => {
    void trpc.drawings.delete
      .mutate({ id })
      .then(() => {
        setDrawErr(null);
        setDrawings((prev) => prev.filter((d) => d.id !== id));
      })
      .catch(drawFail);
  };

  const clearDrawings = () => {
    if (drawings.length === 0) return;
    if (!window.confirm(t('chart.draw.clearConfirm', { count: drawings.length, symbol }))) return;
    const forSymbol = symbol;
    void trpc.drawings.clear
      .mutate({ symbol: forSymbol })
      .then(() => {
        if (symbolRef.current !== forSymbol) return;
        setDrawErr(null);
        setDrawings([]);
      })
      .catch(drawFail);
  };

  // Klick-Handler des Charts über Ref (der Chart-Aufbau-Effekt hängt nicht davon ab).
  const handleChartClickRef = useRef<(p: { x: number; y: number }, point: DrawingPoint | null) => void>(() => undefined);
  handleChartClickRef.current = (px, point) => {
    const current = toolRef.current;
    if (current === 'none' || current === 'move') return;
    if (current === 'delete') {
      const id = primitiveRef.current ? pickDrawing(primitiveRef.current.shapes(), px, 6) : null;
      if (id) deleteDrawing(id);
      return;
    }
    if (!point) return;
    const res = applyDrawingClick(current, pendingRef.current, point);
    pendingRef.current = res.pending;
    primitiveRef.current?.setPreview(res.pending ? { kind: current, points: [res.pending] } : null);
    if (res.create) createDrawing(res.create.kind, res.create.points);
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

  // ── Indikator-Bibliothek (Repo-Masterliste, Phase 1) ──
  // Katalog einmal je Sitzung; Instanzen je Nutzer+Symbol in der DB; gerechnet
  // wird auf dem Server (@gladiator/indicators, dieselben Kerzen wie die Engine);
  // der Browser zeichnet die Ergebnisse mit dem IndicatorRenderer der Bibliothek.
  const [catalog, setCatalog] = useState<MenuEntry[] | 'error' | null>(cachedCatalog());
  const [instances, setInstances] = useState<IndicatorInstance[]>([]);
  const [computed, setComputed] = useState<Map<string, ComputedItem>>(() => new Map());
  const [computing, setComputing] = useState(false);
  const [indErr, setIndErr] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const chartApiRef = useRef<{ chart: IChartApi; candle: ISeriesApi<'Candlestick'> } | null>(null);
  const renderersRef = useRef<Map<string, IndicatorRenderer>>(new Map());
  const barsRef = useRef<PineBar[]>([]);
  const liveBarRef = useRef<PineBar | null>(null);
  const liveDirtyRef = useRef(false);
  const computeSeq = useRef(0);

  // Strategie-Marker (Pine/DSL): Browser-Vorliebe je Symbol (localStorage).
  const [strategySlugs, setStrategySlugs] = useState<string[]>(() => loadStrategySlugs(symbol));
  const firstSlugRender = useRef(true);
  useEffect(() => {
    if (firstSlugRender.current) {
      firstSlugRender.current = false;
      return;
    }
    setStrategySlugs(loadStrategySlugs(symbol));
  }, [symbol]);
  const toggleStrategySlug = (slug: string) => {
    const next = strategySlugs.includes(slug) ? strategySlugs.filter((s) => s !== slug) : [...strategySlugs, slug];
    setStrategySlugs(next);
    saveStrategySlugs(symbol, next);
  };

  useEffect(() => {
    let cancelled = false;
    loadCatalog()
      .then((c) => {
        if (!cancelled) setCatalog(c);
      })
      .catch(() => {
        if (!cancelled) setCatalog('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setInstances([]);
    setComputed(new Map());
    setIndErr(null);
    setSettingsFor(null);
    void trpc.indicators.list
      .query({ symbol })
      .then((rows) => {
        if (!cancelled) setInstances(rows.map(toInstance));
      })
      .catch((e: unknown) => {
        if (!cancelled) setIndErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const entryOf = (indicatorId: string): MenuEntry | undefined => (Array.isArray(catalog) ? catalog.find((e) => e.id === indicatorId) : undefined);
  const indFail = (e: unknown) => setIndErr(e instanceof Error ? e.message : String(e));
  const labelOf = (inst: IndicatorInstance) => {
    const entry = entryOf(inst.indicatorId);
    return entry ? instanceLabel(entry, { ...entry.defaultInputs, ...inst.inputs }) : inst.indicatorId;
  };
  const categories = useMemo(() => {
    if (!Array.isArray(catalog)) return [] as string[];
    const present = new Set(catalog.map((e) => e.category));
    return [...Object.keys(CATEGORY_KEYS).filter((c) => present.has(c)), ...[...present].filter((c) => !CATEGORY_KEYS[c])];
  }, [catalog]);

  const addIndicator = async (entry: MenuEntry) => {
    const forSymbol = symbol;
    const row = await trpc.indicators.add.mutate({ symbol: forSymbol, indicatorId: entry.id });
    if (symbolRef.current !== forSymbol) return;
    setIndErr(null);
    setInstances((prev) => [...prev, toInstance(row)]);
  };
  const updateInstance = async (id: string, patch: { inputs?: Record<string, unknown>; style?: InstanceStyle }) => {
    const row = await trpc.indicators.update.mutate({ id, ...patch });
    setIndErr(null);
    setInstances((prev) => prev.map((i) => (i.id === id ? toInstance(row) : i)));
  };
  const removeInstance = (id: string) => {
    void trpc.indicators.remove
      .mutate({ id })
      .then(() => {
        setIndErr(null);
        setInstances((prev) => prev.filter((i) => i.id !== id));
        setComputed((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
      })
      .catch(indFail);
  };
  const toggleInstance = (inst: IndicatorInstance) => {
    void updateInstance(inst.id, { style: { ...(inst.style ?? {}), visible: inst.style?.visible === false } }).catch(indFail);
  };

  // Rechnung auf dem Server: bei Symbol/TF-Wechsel, neuer Instanz oder
  // geänderten Eingaben — NICHT bei reinen Stil-Änderungen. `liveBar`: die vom
  // Tick fortgeschriebene letzte Kerze, damit der letzte Wert nicht nachhinkt.
  const computeKey = useMemo(() => JSON.stringify(instances.map((i) => [i.id, i.indicatorId, i.inputs])), [instances]);
  const computeRef = useRef<(withLive: boolean) => void>(() => undefined);
  computeRef.current = (withLive) => {
    if (state !== 'ready' || instances.length === 0) return;
    const seq = ++computeSeq.current;
    const forSymbol = symbol;
    const until = replayRef.current?.until;
    const liveBar = withLive && until === undefined ? liveBarRef.current : null;
    setComputing(true);
    void trpc.indicators.compute
      .query({
        symbol: forSymbol,
        timeframe: tf,
        limit: 400,
        venue,
        items: instances.map((i) => ({ key: i.id, id: i.indicatorId, inputs: i.inputs })),
        ...(until !== undefined ? { until } : liveBar ? { liveBar } : {}),
      })
      .then((res) => {
        if (seq !== computeSeq.current || symbolRef.current !== forSymbol) return;
        setComputed(new Map(res.items.map((it) => [it.key, it])));
        setIndErr(null);
      })
      .catch((e: unknown) => {
        if (seq === computeSeq.current) indFail(e);
      })
      .finally(() => {
        if (seq === computeSeq.current) setComputing(false);
      });
  };
  useEffect(() => {
    if (state !== 'ready' || instances.length === 0) {
      setComputed((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    liveDirtyRef.current = false;
    computeRef.current(liveBarRef.current !== null);
  }, [symbol, tf, computeKey, state, instances.length, replayUntil, venue]);
  // Live: nach Ticks alle 10 s (nur sichtbar, nur wenn sich die Kerze bewegt hat) neu rechnen.
  useEffect(() => {
    if (state !== 'ready' || instances.length === 0 || replayUntil !== null) return;
    const id = setVisibleInterval(() => {
      if (!liveDirtyRef.current) return;
      liveDirtyRef.current = false;
      computeRef.current(true);
    }, 10_000);
    return () => clearVisibleInterval(id);
  }, [state, instances.length, replayUntil]);

  const priceRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);

  // Daten laden (Symbol/TF) — echte Kerzen + alle Indikatorserien
  useEffect(() => {
    let cancelled = false;
    if (replayUntil === null) {
      setState('loading');
      setData(null);
    }
    liveBarRef.current = null;
    liveDirtyRef.current = false;
    void trpc.market.chartData
      .query({ symbol, timeframe: tf, limit: 400, venue, ...(replayUntil !== null ? { until: replayUntil } : {}) })
      .then((res) => {
        if (cancelled) return;
        if (!res.available || res.candles.length === 0) {
          setState('empty');
          return;
        }
        if (replayUntil === null) replayTimesRef.current = res.candles.map((c) => c.time);
        setData(res as ChartData);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('empty');
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, tf, replayUntil, venue]);
  // Symbol-/TF-Wechsel beendet ein laufendes Replay (der Zeitstrahl gehört zum alten Fenster).
  useEffect(() => {
    setReplay(null);
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


  /** Signale der im Menü gewählten Pine-/DSL-Strategien (für Entry-Marker). */
  const strategySignals = useMemo(() => (strategySlugs.length === 0 ? [] : signals.filter((s) => strategySlugs.includes(s.strategySlug))), [signals, strategySlugs]);


  /**
   * Indikator-Warmup (Patrick: „ab welcher Kerze läuft ein Indikator wirklich"):
   * die erste definierte Kerze je aktivem Indikator. EMA200 braucht 200 Kerzen,
   * RSI 14 usw. — bis dahin ist der Indikator ehrlich NICHT definiert.
   */
  // Unterfenster (v5-Panes) unter den Kerzen — Reihenfolge: Standard, dann eigene.
  const panes = useMemo(() => {
    const specs: PaneSpec[] = [];
    if (data) {
      if (toggles.rsi && data.rsi.length > 0) specs.push({ key: 'rsi', label: 'RSI 14' });
      if (toggles.macd && data.macd.line.length > 0) specs.push({ key: 'macd', label: 'MACD 12/26/9' });
      if (toggles.atr && data.atr.length > 0) specs.push({ key: 'atr', label: 'ATR 14' });
    }
    // Bibliotheks-Indikatoren ohne Overlay: ein Fenster je sichtbarer Instanz
    // (unabhängig vom Ergebnis — ein Fehler steht dann im leeren Fenster).
    if (Array.isArray(catalog)) {
      for (const inst of instances) {
        const entry = catalog.find((e) => e.id === inst.indicatorId);
        if (!entry || entry.overlay || inst.style?.visible === false) continue;
        specs.push({ key: `ind:${inst.id}`, label: instanceLabel(entry, { ...entry.defaultInputs, ...inst.inputs }) });
      }
    }
    return paneLayout(specs, mainHeight, PANE_HEIGHT);
  }, [data, toggles, catalog, instances, mainHeight]);

  /** Nur wenn sich die erste Wert-Kerze eines Indikators ändert, soll der Warmup (und damit der Chart) neu gebaut werden. */
  const indWarmupKey = useMemo(
    () =>
      JSON.stringify(
        instances.map((i) => {
          const entry = Array.isArray(catalog) ? catalog.find((e) => e.id === i.indicatorId) : undefined;
          return [i.id, i.style?.visible === false, firstPlotTime(computed.get(i.id)?.result, entry ? visiblePlotIds(entry) : [])];
        }),
      ),
    [instances, computed, catalog],
  );

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
    // Bibliotheks-Indikatoren — auch für sie gilt der ehrliche Warmup.
    if (Array.isArray(catalog)) {
      for (const inst of instances) {
        const entry = catalog.find((e) => e.id === inst.indicatorId);
        const item = computed.get(inst.id);
        if (!entry || !item?.result || inst.style?.visible === false) continue;
        const t0 = firstPlotTime(item.result, visiblePlotIds(entry));
        if (t0 !== null) add(true, instanceLabel(entry, { ...entry.defaultInputs, ...inst.inputs }), [{ time: t0 }]);
      }
    }
    return items.sort((a, b) => a.bar - b.bar);
    // computed/instances absichtlich nur über indWarmupKey (sonst Chart-Neubau je Live-Rechnung)
  }, [data, toggles, catalog, indWarmupKey]);

  /**
   * Bibliotheks-Indikatoren zeichnen: je Instanz ein IndicatorRenderer auf dem
   * Chart (Overlay → Kursfenster, sonst das vorab angelegte Unterfenster). Nur
   * ausdrückliche Stil-Übersteuerungen gehen mit — sonst würden per-Kerze
   * gefärbte Plots (MACD-Histogramm) und bedingt sichtbare Plots plattgemacht.
   * `reuse`: Serien der vorigen Zeichnung weiterverwenden (Live-Nachrechnung).
   */
  const applyIndicatorsRef = useRef<(reuse: boolean) => void>(() => undefined);
  applyIndicatorsRef.current = (reuse) => {
    const api = chartApiRef.current;
    if (!api || !Array.isArray(catalog)) return;
    const renderers = renderersRef.current;
    const wanted = new Set<string>();
    for (const inst of instances) {
      const entry = catalog.find((e) => e.id === inst.indicatorId);
      const item = computed.get(inst.id);
      if (!entry || !item?.result || inst.style?.visible === false) continue;
      const paneIndex = entry.overlay ? 0 : (panes.panes.find((p) => p.key === `ind:${inst.id}`)?.index ?? -1);
      if (paneIndex < 0) continue;
      wanted.add(inst.id);
      let r = renderers.get(inst.id);
      if (!r) {
        r = new IndicatorRenderer(api.chart, { paneIndex, mainSeries: api.candle, preserveEmptyPane: true });
        renderers.set(inst.id, r);
      } else {
        r.setPaneIndex(paneIndex);
      }
      const plots: Record<string, PlotOverride> = {};
      for (const [pid, o] of Object.entries(inst.style?.plots ?? {})) plots[pid] = { visible: o.visible, color: o.color, lineWidth: o.lineWidth };
      try {
        r.render(
          { overlay: entry.overlay, plotConfig: entry.plots, hlineConfig: entry.hlines, fillConfig: entry.fills },
          item.result as unknown as IndicatorResult,
          barsRef.current,
          { inputs: item.inputs, plots, lastValueVisible: true, reuseSeries: reuse },
        );
      } catch (e) {
        indFail(e);
      }
    }
    for (const [id, r] of renderers) {
      if (wanted.has(id)) continue;
      try {
        r.clear();
      } catch {
        /* Chart schon entsorgt */
      }
      renderers.delete(id);
    }
    // Fensterhöhen erneut setzen — vom Renderer neu angelegte Fenster hätten sonst Standardhöhe.
    const paneApis = api.chart.panes();
    paneApis[0]?.setStretchFactor(MAIN_HEIGHT);
    for (const p of panes.panes) paneApis[p.index]?.setStretchFactor(p.height);
  };

  // Charts (neu)bauen bei Daten- oder Toggle-Änderung
  useEffect(() => {
    if (state !== 'ready' || !data || !priceRef.current) return;
    const cleanups: (() => void)[] = [];

    // ── Hauptchart: Kerzen ──
    const priceEl = priceRef.current;
    const price = createChart(priceEl, { width: priceEl.clientWidth, ...baseChartOptions(tf, panes.total) });
    const candle = price.addSeries(CandlestickSeries, {
      upColor: C.green,
      downColor: C.red,
      borderUpColor: C.green,
      borderDownColor: C.red,
      wickUpColor: 'rgba(34,197,94,0.6)',
      wickDownColor: 'rgba(239,68,68,0.6)',
      priceLineVisible: false,
    });
    candle.setData(data.candles as never);

    // Zeichnungen (Plan §5): Primitive an die Kerzenserie hängen; sie rechnet
    // Zeit/Preis-Anker bei jedem Neuzeichnen in Pixel um.
    const barTimes = data.candles.map((c) => c.time as number);
    const drawPrim = new DrawingsPrimitive();
    drawPrim.setTimes(barTimes);
    drawPrim.setDrawings(drawingsRef.current);
    candle.attachPrimitive(drawPrim);
    primitiveRef.current = drawPrim;
    // Smart-Money-Flächen (Zonen, Liquidität, Premium/Discount) — Inhalte weiter unten
    const smcPrim = new SmcBoxesPrimitive();
    smcPrim.setTimes(barTimes);
    candle.attachPrimitive(smcPrim);
    pendingRef.current = null;
    cleanups.push(() => {
      if (primitiveRef.current === drawPrim) primitiveRef.current = null;
    });
    const chartPointAt = (pt: { x: number; y: number }): DrawingPoint | null =>
      pointFromChart(barTimes, price.timeScale().coordinateToLogical(pt.x), candle.coordinateToPrice(pt.y));
    const onDrawClick = (param: Parameters<Parameters<typeof price.subscribeClick>[0]>[0]) => {
      if (!param.point || (param.paneIndex ?? 0) > 0) return; // Zeichnen nur im Kursfenster
      handleChartClickRef.current(param.point, chartPointAt(param.point));
    };
    price.subscribeClick(onDrawClick);
    cleanups.push(() => price.unsubscribeClick(onDrawClick));
    // Vorschau des zweiten Ankers (Trend/Fibonacci) unter dem Fadenkreuz
    const onDrawMove = (param: Parameters<Parameters<typeof price.subscribeCrosshairMove>[0]>[0]) => {
      const current = toolRef.current;
      const start = pendingRef.current;
      if (!start || (current !== 'trend' && current !== 'fib') || !param.point || (param.paneIndex ?? 0) > 0) return;
      const p = chartPointAt(param.point);
      drawPrim.setPreview({ kind: current, points: p ? [start, p] : [start] });
    };
    price.subscribeCrosshairMove(onDrawMove);
    cleanups.push(() => price.unsubscribeCrosshairMove(onDrawMove));

    // Verschieben (Werkzeug „Verschieben"): Zeichnung greifen, ziehen, loslassen →
    // speichern. Die Chart-Bibliothek kennt kein Drag-Ereignis, daher Pointer-Events
    // am Chart-Element; Scrollen/Zoomen ist während des Ziehens aus.
    let drag: { id: string; logical: number; price: number; orig: DrawingPoint[]; moved: DrawingPoint[] | null } | null = null;
    const localPt = (e: PointerEvent) => {
      const r = priceEl.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onPointerDown = (e: PointerEvent) => {
      if (toolRef.current !== 'move') return;
      const px = localPt(e);
      if (px.y > MAIN_HEIGHT) return; // Unterfenster: kein Zeichnungs-Griff
      const id = pickDrawing(drawPrim.shapes(), px, 6);
      const d = id ? drawingsRef.current.find((x) => x.id === id) : undefined;
      const logical = price.timeScale().coordinateToLogical(px.x);
      const pr = candle.coordinateToPrice(px.y);
      if (!d || logical == null || pr == null) return;
      drag = { id: d.id, logical, price: pr, orig: d.points, moved: null };
      price.applyOptions({ handleScroll: false, handleScale: false });
      priceEl.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!drag) return;
      const px = localPt(e);
      const logical = price.timeScale().coordinateToLogical(px.x);
      const pr = candle.coordinateToPrice(px.y);
      if (logical == null || pr == null) return;
      const moved = translatePoints(barTimes, drag.orig, logical - drag.logical, pr - drag.price);
      if (!moved) return;
      drag.moved = moved;
      const id = drag.id;
      drawPrim.setDrawings(drawingsRef.current.map((x) => (x.id === id ? { ...x, points: moved } : x)));
    };
    const endDrag = () => {
      if (!drag) return;
      const { id, moved } = drag;
      drag = null;
      price.applyOptions({ handleScroll: true, handleScale: true });
      if (moved) moveDrawingRef.current(id, moved);
      else drawPrim.setDrawings(drawingsRef.current);
    };
    priceEl.addEventListener('pointerdown', onPointerDown, true);
    priceEl.addEventListener('pointermove', onPointerMove);
    priceEl.addEventListener('pointerup', endDrag);
    priceEl.addEventListener('pointercancel', endDrag);
    cleanups.push(() => {
      priceEl.removeEventListener('pointerdown', onPointerDown, true);
      priceEl.removeEventListener('pointermove', onPointerMove);
      priceEl.removeEventListener('pointerup', endDrag);
      priceEl.removeEventListener('pointercancel', endDrag);
    });

    // Live: echte SSE-Ticks bewegen die letzte Kerze (wie TradingView) —
    // nur für Symbole im Live-Feed; ohne Ticks bleibt der geladene Stand.
    let lastBar = data.candles[data.candles.length - 1] as Bar | undefined;
    const barSec = liveBarSeconds(tf);
    // Live-Ticks gibt es nur für Krypto (Binance-Stream); Aktien/Forex zeigen den DB-Stand.
    if (lastBar && replayRef.current === null && venue === 'binance') {
      ensurePriceStream();
      cleanups.push(
        onTick((tick) => {
          if (tick.symbol !== symbol || !lastBar) return;
          const next = applyTick(lastBar, tick.price, Date.parse(tick.ts) || Date.now(), barSec);
          if (!next) return;
          lastBar = next;
          candle.update(next as never);
          // Neue Live-Kerze → Zeitachse der Zeichnungen mitführen
          const nt = next.time as number;
          if (nt > barTimes[barTimes.length - 1]!) {
            barTimes.push(nt);
            drawPrim.setTimes(barTimes);
            smcPrim.setTimes(barTimes);
          }
          // Live-Kerze für die Indikator-Rechnung merken. Volumen nur, solange
          // die DB-Kerze dieselbe Zeit hat — für eine neue Kerze ist es unbekannt.
          const bars = barsRef.current;
          const lastDb = bars[bars.length - 1];
          const live: PineBar = {
            time: nt,
            open: next.open,
            high: next.high,
            low: next.low,
            close: next.close,
            ...(lastDb && lastDb.time === nt && lastDb.volume !== undefined ? { volume: lastDb.volume } : {}),
          };
          liveBarRef.current = live;
          liveDirtyRef.current = true;
          if (lastDb && lastDb.time === nt) bars[bars.length - 1] = live;
          else if (!lastDb || nt > lastDb.time) bars.push(live);
        }),
      );
    }

    // Volumen (Overlay unten)
    if (toggles.volume) {
      const vol = price.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
      price.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      vol.setData(data.volume as never);
    }

    // EMA-Overlays
    if (toggles.ema) {
      const addLine = (pts: { time: number; value: number }[], color: string) => {
        if (pts.length === 0) return;
        const s = price.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
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
        const s = price.addSeries(LineSeries, { color: C.faint, lineWidth: 1, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
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
    // Liquiditäts-Sweeps: Docht über ein Hoch (BSL) / unter ein Tief (SSL) ohne Schluss jenseits
    if (toggles.liquidity) {
      for (const sw of data.liquidity.sweeps) {
        const buy = sw.side === 'buy-side';
        markers.push({ time: sw.time as UTCTimestamp, position: buy ? 'aboveBar' : 'belowBar', color: buy ? C.amber : C.cyan, shape: 'circle', text: buy ? 'BSL' : 'SSL' });
      }
    }
    const selectedSlugs = new Set(strategySlugs);
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
          color: '#f59e0b', // magenta — im Marker-Farbschema sonst ungenutzt
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
      createSeriesMarkers(candle, markers);
    }

    // Smart-Money-Flächen: Zonen als Boxen (Entstehung → Mitigation, offen bis zum
    // rechten Rand), Liquiditäts-Level als Segmente, Premium/Discount als getönte
    // Dealing Range — ein Primitive, bei jedem Pan/Zoom neu projiziert.
    const smcItems: SmcItem[] = [];
    if (toggles.zones) {
      for (const z of activeZones) {
        const bull = z.kind.startsWith('bullish');
        const isFvg = z.kind.endsWith('fvg');
        smcItems.push({
          kind: 'box',
          fromTime: z.fromTime,
          toTime: z.active ? null : z.toTime,
          top: z.top,
          bottom: z.bottom,
          fill: bull ? 'rgba(34,197,94,0.10)' : 'rgba(239,68,68,0.10)',
          stroke: bull ? 'rgba(34,197,94,0.45)' : 'rgba(239,68,68,0.45)',
          label: `${isFvg ? 'FVG' : 'OB'} ${bull ? '↑' : '↓'}`,
        });
      }
    }
    if (toggles.liquidity) {
      for (const lv of data.liquidity.levels) {
        const eqh = lv.kind === 'eqh';
        smcItems.push({
          kind: 'line',
          fromTime: lv.fromTime,
          toTime: lv.active ? null : lv.toTime,
          price: lv.price,
          color: eqh ? C.amber : C.cyan,
          width: 1,
          ...(lv.active ? {} : { dash: [3, 3] }),
          label: `${eqh ? 'EQH' : 'EQL'}${lv.active ? '' : ' ✓'}`,
        });
      }
    }
    if (toggles.pd && data.range) {
      const r = data.range;
      smcItems.push({ kind: 'box', fromTime: r.fromTime, toTime: null, top: r.high, bottom: r.equilibrium, fill: 'rgba(239,68,68,0.06)', label: 'Premium', labelColor: 'rgba(239,68,68,0.8)' });
      smcItems.push({ kind: 'box', fromTime: r.fromTime, toTime: null, top: r.equilibrium, bottom: r.low, fill: 'rgba(34,197,94,0.06)', label: 'Discount', labelColor: 'rgba(34,197,94,0.8)' });
      smcItems.push({ kind: 'line', fromTime: r.fromTime, toTime: null, price: r.equilibrium, color: C.faint, dash: [4, 4], label: 'EQ' });
    }
    smcPrim.setItems(smcItems);

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
      const f = (n: number) => n.toLocaleString(appLocale(), { maximumFractionDigits: n >= 1000 ? 1 : 4 });
      legendEl.style.opacity = '1';
      legendEl.innerHTML = `<span style="color:${C.mut}">O</span> ${f(bar.open)}  <span style="color:${C.mut}">H</span> ${f(bar.high)}  <span style="color:${C.mut}">L</span> ${f(bar.low)}  <span style="color:${C.mut}">C</span> <span style="color:${d}">${f(bar.close)}</span>`;
    };
    price.subscribeCrosshairMove(onMove);
    cleanups.push(() => price.unsubscribeCrosshairMove(onMove));

    // ── Oszillator-Unterfenster (v5-Panes im selben Chart) ──
    const paneOf = (key: string) => panes.panes.find((p) => p.key === key)?.index;
    const levels3070 = (s: ReturnType<typeof price.addSeries<'Line'>>) => {
      s.createPriceLine({ price: 70, color: 'rgba(239,68,68,0.4)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '70' });
      s.createPriceLine({ price: 30, color: 'rgba(34,197,94,0.4)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '30' });
    };
    const addMacd = (pane: number, m: { line: unknown[]; signal: unknown[]; histogram: unknown[] }) => {
      price.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane).setData(m.histogram as never);
      price.addSeries(LineSeries, { color: C.cyan, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, pane).setData(m.line as never);
      price.addSeries(LineSeries, { color: C.amber, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, pane).setData(m.signal as never);
    };
    const rsiPane = paneOf('rsi');
    if (rsiPane) {
      const s = price.addSeries(LineSeries, { color: C.cyan, lineWidth: 1, priceLineVisible: false, lastValueVisible: true }, rsiPane);
      s.setData(data.rsi as never);
      levels3070(s);
    }
    const macdPane = paneOf('macd');
    if (macdPane) addMacd(macdPane, data.macd);
    const atrPane = paneOf('atr');
    if (atrPane) price.addSeries(LineSeries, { color: C.violet, lineWidth: 1, priceLineVisible: false, lastValueVisible: true }, atrPane).setData(data.atr as never);
    // Höhen über Stretch-Faktoren (proportional zu den Pixelhöhen): nacheinander
    // gesetzte setHeight-Aufrufe verteilen den Rest neu und quetschen Fenster.
    // Fenster der Bibliotheks-Indikatoren vorab anlegen (leer, bis das Ergebnis
    // vom Server da ist) — so stimmen Pane-Indizes und Beschriftungen immer.
    for (const p of panes.panes) if (p.key.startsWith('ind:') && price.panes().length <= p.index) price.addPane(true);
    const paneApis = price.panes();
    paneApis[0]?.setStretchFactor(MAIN_HEIGHT);
    for (const p of panes.panes) paneApis[p.index]?.setStretchFactor(p.height);

    // Bibliotheks-Indikatoren zeichnen (Ergebnisse vom Server, Live-Kerze mitgeführt)
    barsRef.current = toPineBars(data, liveBarRef.current);
    chartApiRef.current = { chart: price, candle };
    renderersRef.current = new Map();
    applyIndicatorsRef.current(false);
    cleanups.push(() => {
      for (const r of renderersRef.current.values()) {
        try {
          r.clear();
        } catch {
          /* Chart schon entsorgt */
        }
      }
      renderersRef.current = new Map();
      chartApiRef.current = null;
    });

    price.timeScale().fitContent();

    const observer = new ResizeObserver(() => price.applyOptions({ width: priceEl.clientWidth }));
    observer.observe(priceEl);
    cleanups.push(() => observer.disconnect());

    return () => {
      // Reihenfolge ist kritisch: erst Observer/Subscriptions lösen, DANN den
      // Chart entsorgen — sonst feuert eine Callback auf einen disposed Chart
      // und der Fehler reißt beim Unmount die App weiß.
      for (const fn of cleanups) fn();
      try {
        price.remove();
      } catch {
        /* schon entsorgt — ignorieren */
      }
    };
  }, [state, data, toggles, tf, levels, activeZones, signals, warmupInfo, t, strategySignals, strategySlugs, symbol, panes, venue]);

  // Neue Ergebnisse oder Stil-Änderungen zeichnen, ohne den Chart neu zu bauen.
  useEffect(() => {
    applyIndicatorsRef.current(true);
  }, [computed, instances, catalog]);

  const settingsInst = settingsFor ? instances.find((i) => i.id === settingsFor) : undefined;
  const settingsEntry = settingsInst ? entryOf(settingsInst.indicatorId) : undefined;

  const viewRow = (key: ToggleKey, label: string) => (
    <label key={key}>
      <input type="checkbox" className="accent-[#3b82f6]" checked={toggles[key]} onChange={(e) => setToggle(key, e.target.checked)} />
      <span style={{ color: toggles[key] ? 'var(--color-ink)' : 'var(--color-mut)' }}>{label}</span>
    </label>
  );
  const viewLabel: Record<ToggleKey, string> = {
    ema: 'EMA 20/50/200',
    bollinger: 'Bollinger',
    volume: t('chart.volume'),
    rsi: 'RSI 14',
    macd: 'MACD 12/26/9',
    atr: 'ATR 14',
    structure: 'BOS/CHoCH',
    zones: 'OB/FVG',
    liquidity: t('chart.liquidity'),
    pd: t('chart.pd'),
    signals: 'Signale',
  };
  const toolRow = (key: Exclude<DrawingTool, 'none'>, label: string) => (
    <button
      key={key}
      type="button"
      onClick={() => {
        selectTool(tool === key ? 'none' : key);
        setDrawOpen(false);
      }}
      aria-pressed={tool === key}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]"
      style={{ color: tool === key ? 'var(--color-ink)' : 'var(--color-mut)', background: tool === key ? 'rgba(59,130,246,0.16)' : 'transparent' }}
    >
      {label}
    </button>
  );

  return (
    <div>
      {/* EINE Werkzeugzeile (Welle C): Zeitrahmen · Ansicht ▾ · Smart Money · Bibliothek · Zeichnen ▾ · Replay */}
      <div className="toolbar mb-2" role="toolbar" aria-label={t('chart.view')}>
        <div className="flex gap-0.5 rounded-lg p-0.5" style={{ background: 'var(--color-bg3)' }}>
          {shownTfs.map((f) => (
            <button
              key={f}
              onClick={() => changeTf(f)}
              aria-pressed={tf === f}
              className="num rounded-md px-2 py-0.5 text-[11px] font-semibold transition-colors"
              style={tf === f ? { background: 'rgba(59,130,246,0.2)', color: 'var(--color-ink)' } : { color: 'var(--color-mut)' }}
            >
              {f}
            </button>
          ))}
        </div>
        <ToolPopover label={t('chart.view')} open={viewOpen} onToggle={() => setViewOpen((o) => !o)} onClose={() => setViewOpen(false)}>
          <p className="label px-1.5 pb-1">{t('chart.builtin')}</p>
          {BUILTIN_KEYS.map((k) => viewRow(k, viewLabel[k]))}
          <p className="label px-1.5 pt-2 pb-1">{t('chart.smc')}</p>
          {SMC_ALL_KEYS.map((k) => viewRow(k, viewLabel[k]))}
          <p className="label px-1.5 pt-2">{t('chart.viewHint')}</p>
        </ToolPopover>
        <button type="button" className="tbtn" aria-pressed={smcOn} onClick={toggleSmc} title={t('chart.smcHint')}>
          {t('chart.smc')}
        </button>
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          className="tbtn"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          aria-pressed={instances.length > 0 || strategySlugs.length > 0}
        >
          ＋ {t('chart.library')}
          {instances.length > 0 ? <span className="num"> {instances.length}</span> : null}
          {strategySlugs.length > 0 ? (
            <span className="num" style={{ color: 'var(--color-warn)' }}>
              {' '}
              ▣{strategySlugs.length}
            </span>
          ) : null}
        </button>
        <ToolPopover label={t('chart.drawMenu')} active={tool !== 'none'} open={drawOpen} onToggle={() => setDrawOpen((o) => !o)} onClose={() => setDrawOpen(false)}>
          <div role="group" aria-label={t('chart.draw.title')}>
            {toolRow('hline', `― ${t('chart.draw.hline')}`)}
            {toolRow('trend', `╱ ${t('chart.draw.trend')}`)}
            {toolRow('fib', `≡ ${t('chart.draw.fib')}`)}
            {toolRow('move', `✥ ${t('chart.draw.move')}`)}
            {toolRow('delete', `✕ ${t('chart.draw.delete')}`)}
            <button
              type="button"
              onClick={() => {
                clearDrawings();
                setDrawOpen(false);
              }}
              disabled={drawings.length === 0}
              className="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] disabled:opacity-40"
              style={{ color: 'var(--color-neg)' }}
              title={t('chart.draw.count', { count: drawings.length })}
            >
              {t('chart.draw.clear')}
              {drawings.length > 0 ? <span className="num"> ({drawings.length})</span> : null}
            </button>
          </div>
        </ToolPopover>
        <button type="button" onClick={() => (replay ? setReplay(null) : startReplay())} className="tbtn tbtn--warn" aria-pressed={replay !== null}>
          ⏮ {t('chart.replay.button')}
        </button>
      </div>

      {replayMsg && (
        <p className="label mb-1.5 px-2" style={{ color: 'var(--color-warn)' }}>
          {replayMsg}
        </p>
      )}
      {replay && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded border px-2 py-1.5" style={{ borderColor: 'rgba(245,182,66,0.45)', background: 'rgba(245,182,66,0.05)' }} role="group" aria-label={t('chart.replay.title')}>
          <span className="label" style={{ color: 'var(--color-warn)' }}>
            ⏮ {t('chart.replay.title')}
          </span>
          <button type="button" onClick={() => replayStep(-1)} className="rounded border px-2 py-0.5 text-[11px]" style={{ borderColor: 'var(--color-line)', color: 'var(--color-ink)' }} aria-label={t('chart.replay.back')} title={t('chart.replay.back')}>
            ◀
          </button>
          <button
            type="button"
            onClick={() => setReplay((r) => (r ? { ...r, playing: !r.playing } : r))}
            className="rounded border px-2 py-0.5 text-[11px]"
            style={{ borderColor: 'rgba(245,182,66,0.6)', color: 'var(--color-warn)' }}
            aria-label={replay.playing ? t('chart.replay.pause') : t('chart.replay.play')}
            title={replay.playing ? t('chart.replay.pause') : t('chart.replay.play')}
          >
            {replay.playing ? '⏸' : '▶'}
          </button>
          <button type="button" onClick={() => replayStep(1)} className="rounded border px-2 py-0.5 text-[11px]" style={{ borderColor: 'var(--color-line)', color: 'var(--color-ink)' }} aria-label={t('chart.replay.forward')} title={t('chart.replay.forward')}>
            ▶|
          </button>
          <label className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--color-mut)' }}>
            {t('chart.replay.speed')}
            <select value={replay.speed} onChange={(e) => setReplay((r) => (r ? { ...r, speed: Number(e.target.value) } : r))} className="field cursor-pointer px-1 py-0.5 text-[11px]" aria-label={t('chart.replay.speed')}>
              {[1, 2, 4].map((v) => (
                <option key={v} value={v}>
                  {v}×
                </option>
              ))}
            </select>
          </label>
          <input
            type="range"
            min={30}
            max={Math.max(30, replayTimesRef.current.length - 1)}
            value={Math.max(30, replayIndex)}
            onChange={(e) => {
              const next = replayTimesRef.current[Number(e.target.value)];
              if (next !== undefined) setReplay((r) => (r ? { ...r, until: next, playing: false } : r));
            }}
            className="w-40 accent-[#f5b642]"
            aria-label={t('chart.replay.position', { i: replayIndex + 1, n: replayTimesRef.current.length })}
          />
          <span className="num text-[11px]" style={{ color: 'var(--color-ink)' }}>
            {t('chart.replay.position', { i: replayIndex + 1, n: replayTimesRef.current.length })} · {new Date(replay.until * 1000).toLocaleString(appLocale())}
          </span>
          {state === 'loading' ? <span className="label">…</span> : null}
          <button type="button" onClick={() => setReplay(null)} className="ml-auto rounded border px-2 py-0.5 text-[11px]" style={{ borderColor: 'var(--color-line)', color: 'var(--color-mut)' }}>
            {t('chart.replay.end')}
          </button>
          <p className="label w-full" style={{ color: 'var(--color-warn)' }}>
            {t('chart.replay.note', { time: new Date(replay.until * 1000).toLocaleString(appLocale()) })}
          </p>
        </div>
      )}
      {tool !== 'none' && (
        <p className="label mb-1.5 px-2" style={{ color: 'var(--color-cyan)' }}>
          {tool === 'hline'
            ? t('chart.draw.hintHline')
            : tool === 'delete'
              ? t('chart.draw.hintDelete')
              : tool === 'move'
                ? t('chart.draw.hintMove')
                : t('chart.draw.hintTwo')}
        </p>
      )}
      {drawErr && (
        <p className="label mb-1.5 px-2" style={{ color: 'var(--color-warn)' }}>
          {t('chart.draw.error', { msg: drawErr })}
        </p>
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
          <div ref={priceRef} className="w-full overflow-hidden rounded" style={{ background: 'rgba(11,13,18,0.45)' }} />
          {panes.panes.map((p) => {
            const err = p.key.startsWith('ind:') ? computed.get(p.key.slice(4))?.error : undefined;
            return (
              <p key={p.key} className="label pointer-events-none absolute left-2 z-10 px-1" style={{ top: p.top + 2, background: 'rgba(11,13,18,0.6)' }}>
                {p.label}
                {err ? <span style={{ color: 'var(--color-warn)' }}> · ⚠ {err}</span> : null}
              </p>
            );
          })}
        </div>
        {(instances.length > 0 || indErr) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 px-2">
            {instances.map((inst) => {
              const entry = entryOf(inst.indicatorId);
              const item = computed.get(inst.id);
              const hidden = inst.style?.visible === false;
              const noValues = entry?.group === 'standard' && item?.result != null && visiblePlotIds(entry).length > 0 && firstPlotTime(item.result, visiblePlotIds(entry)) === null;
              const iconBtn = (onClick: () => void, label: string, glyph: string, color = 'var(--color-mut)') => (
                <button type="button" onClick={onClick} aria-label={label} title={label} className="px-0.5 leading-none" style={{ color }}>
                  {glyph}
                </button>
              );
              return (
                <span
                  key={inst.id}
                  className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]"
                  style={{ borderColor: item?.error ? 'rgba(239,68,68,0.5)' : 'rgba(148,163,184,0.35)', color: hidden ? 'var(--color-mut)' : 'var(--color-ink)', opacity: hidden ? 0.6 : 1 }}
                  title={item?.error ?? entry?.name ?? inst.indicatorId}
                >
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: entry ? legendColor(entry, inst.style) : C.mut }} />
                  <span className="num">{labelOf(inst)}</span>
                  {item?.error ? <span style={{ color: 'var(--color-neg)' }}>⚠</span> : null}
                  {noValues ? (
                    <span style={{ color: 'var(--color-warn)' }} title={t('chart.ind.noValues')}>
                      ∅
                    </span>
                  ) : null}
                  {entry ? iconBtn(() => setSettingsFor(inst.id), t('chart.ind.settings'), '⚙') : null}
                  {iconBtn(() => toggleInstance(inst), hidden ? t('chart.ind.show') : t('chart.ind.hide'), hidden ? '○' : '◉')}
                  {iconBtn(() => removeInstance(inst.id), t('chart.ind.remove'), '✕')}
                </span>
              );
            })}
            {computing ? <span className="label">{t('chart.ind.computing')}</span> : null}
            {indErr ? (
              <span className="label" style={{ color: 'var(--color-warn)' }}>
                {t('chart.ind.error', { msg: indErr })}
              </span>
            ) : null}
          </div>
        )}
        {instances.some((i) => computed.get(i.id)?.error) && (
          <p className="label mt-1 px-2" style={{ color: 'var(--color-warn)' }}>
            {instances
              .filter((i) => computed.get(i.id)?.error)
              .map((i) => `⚠ ${labelOf(i)}: ${computed.get(i.id)?.error ?? ''}`)
              .join(' · ')}
          </p>
        )}
        {data && data.zonesTotal > activeZones.length && (
          <p className="label mt-1.5 px-2">{t('chart.zonesInfo', { shown: activeZones.length, total: data.zonesTotal })}</p>
        )}
        {toggles.liquidity && data && (
          <p className="label mt-1.5 px-2">
            {t('chart.liqInfo', { levels: data.liquidity.levels.filter((l) => l.active).length, total: data.liquidity.levelsTotal, sweeps: data.liquidity.sweeps.length })}
          </p>
        )}
        {toggles.pd && data?.range && (
          <p className="label mt-1.5 px-2" style={{ color: data.range.zone === 'premium' ? C.red : data.range.zone === 'discount' ? C.green : C.mut }}>
            {t('chart.rangeInfo', { low: fmtPx(data.range.low), high: fmtPx(data.range.high), pct: Math.round(data.range.position * 100), zone: t(`chart.zone_${data.range.zone}`) })}
          </p>
        )}
        {warmupInfo.length > 0 && (
          <p className="label mt-1.5 px-2">
            {t('chart.warmupTitle')}{' '}
            {warmupInfo.map((w) => `${w.label} ${t('chart.warmupBar', { bar: w.bar })}`).join(' · ')}
          </p>
        )}
        <p className="label mt-1.5 px-2">{t('chart.legend')}</p>
      </div>

      <IndicatorMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        catalog={catalog}
        categories={categories}
        activeCount={instances.length}
        onAdd={addIndicator}
        strategies={pineStrategies}
        strategySlugs={strategySlugs}
        onToggleStrategy={toggleStrategySlug}
        strategySignalCount={strategySignals.length}
      />
      {settingsInst && settingsEntry ? (
        <IndicatorSettings
          key={settingsInst.id}
          entry={settingsEntry}
          label={labelOf(settingsInst)}
          inputs={{ ...settingsEntry.defaultInputs, ...settingsInst.inputs }}
          style={settingsInst.style}
          onApply={async (inputs, style) => {
            await updateInstance(settingsInst.id, { inputs, style });
            setSettingsFor(null);
          }}
          onClose={() => setSettingsFor(null)}
        />
      ) : null}
    </div>
  );
}
