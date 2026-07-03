/**
 * Geteilter Live-Preis-Stream (eine SSE-Verbindung für UI + Daten-Rain).
 * Quelle: /api/stream/prices — ausschließlich ECHTE Binance-Ticks.
 */

export type Tick = { symbol: string; price: number; changePct24h: number | null; ts: string };
export type FeedState = 'connecting' | 'live' | 'disconnected';
export type TickWithDirection = Tick & { direction: 'up' | 'down' | 'flat' };

type TickListener = (t: TickWithDirection) => void;
type StateListener = (s: FeedState) => void;

const tickListeners = new Set<TickListener>();
const stateListeners = new Set<StateListener>();
const lastPrices = new Map<string, number>();
const latest = new Map<string, TickWithDirection>();

let es: EventSource | null = null;
let state: FeedState = 'connecting';

function setState(s: FeedState) {
  if (state === s) return;
  state = s;
  for (const fn of stateListeners) fn(s);
}

function handleTick(t: Tick) {
  const prev = lastPrices.get(t.symbol);
  const direction: TickWithDirection['direction'] =
    prev === undefined || t.price === prev ? 'flat' : t.price > prev ? 'up' : 'down';
  lastPrices.set(t.symbol, t.price);
  const tick: TickWithDirection = { ...t, direction };
  latest.set(t.symbol, tick);
  setState('live');
  for (const fn of tickListeners) fn(tick);
}

/**
 * Startet die Verbindung (idempotent). Läuft app-weit genau einmal.
 * WICHTIG: erst NACH dem window-load-Event verbinden — eine EventSource,
 * die vor "load" öffnet, lässt Chromes Tab-Spinner endlos drehen.
 */
export function ensurePriceStream(): void {
  if (es) return;
  if (document.readyState !== 'complete') {
    window.addEventListener('load', () => ensurePriceStream(), { once: true });
    return;
  }
  es = new EventSource('/api/stream/prices');
  es.addEventListener('snapshot', (e) => {
    const snap = JSON.parse((e as MessageEvent).data) as { tickers: Tick[] };
    for (const t of snap.tickers) handleTick(t);
  });
  es.addEventListener('tick', (e) => handleTick(JSON.parse((e as MessageEvent).data) as Tick));
  es.addEventListener('status', (e) => {
    const s = JSON.parse((e as MessageEvent).data) as { status: string };
    if (s.status === 'disconnected') setState('disconnected');
  });
  es.onerror = () => setState('disconnected');
  es.onopen = () => {
    if (state === 'disconnected') setState('connecting');
  };
}

export function onTick(fn: TickListener): () => void {
  tickListeners.add(fn);
  return () => tickListeners.delete(fn);
}

export function onFeedState(fn: StateListener): () => void {
  stateListeners.add(fn);
  fn(state);
  return () => stateListeners.delete(fn);
}

export function getFeedState(): FeedState {
  return state;
}

export function getLatest(): TickWithDirection[] {
  return [...latest.values()];
}
