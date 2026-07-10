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

/**
 * Hintergrund-Tabs geben ihren Socket frei: Chrome erlaubt nur 6 Verbindungen
 * je Host — halten viele offene Tabs ihre SSE-Streams, verhungern neue Tabs
 * endlos im "Lädt …" (Assets/API bleiben pending). Nach 30 s im Hintergrund
 * wird die Verbindung geschlossen; wird der Tab wieder sichtbar, verbindet er
 * sofort neu (Snapshot-Event liefert direkt wieder alle Kurse).
 */
let visibilityRegistered = false;
let hiddenCloseTimer: number | null = null;

function registerVisibilityHandler(): void {
  if (visibilityRegistered || typeof document === 'undefined') return;
  visibilityRegistered = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (hiddenCloseTimer !== null || es === null) return;
      hiddenCloseTimer = window.setTimeout(() => {
        hiddenCloseTimer = null;
        if (document.hidden && es) {
          es.close();
          es = null;
          setState('connecting');
        }
      }, 30_000);
    } else {
      if (hiddenCloseTimer !== null) {
        window.clearTimeout(hiddenCloseTimer);
        hiddenCloseTimer = null;
      }
      ensurePriceStream();
    }
  });
}

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
  registerVisibilityHandler();
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
  es.onerror = () => {
    setState('disconnected');
    // Bei Nicht-200 (z. B. 429 vom Stream-Limit) schließt EventSource DAUERHAFT —
    // sanft selbst heilen: nach 60 s neu versuchen, sobald wieder ein Slot frei
    // ist (etwa weil alte Tabs geschlossen wurden). Netzwerk-Blips (CONNECTING)
    // reconnectet der Browser selbst, da greifen wir nicht ein.
    if (es && es.readyState === EventSource.CLOSED) {
      es = null;
      window.setTimeout(() => {
        if (!document.hidden) ensurePriceStream();
      }, 60_000);
    }
  };
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
