/**
 * Live-Kerze aus echten SSE-Ticks (kein Fake: nur reale Binance-Preise).
 * Der Chart lädt 400 historische Kerzen; danach bewegt jeder Tick die letzte
 * Kerze bzw. eröffnet nach Ablauf des Zeitfensters eine neue — wie bei
 * TradingView. Rein & getestet (live-candle.test.ts).
 */

export type Bar = { time: number; open: number; high: number; low: number; close: number };

const FIXED: Record<string, number> = {
  '5m': 300,
  '15m': 900,
  '30m': 1_800,
  '1h': 3_600,
  '2h': 7_200,
  '4h': 14_400,
  '12h': 43_200,
  '1d': 86_400,
};

/** Kerzenlänge in Sekunden; null = Kalender-Timeframe (1w/1M) → keine neuen Kerzen erzeugen. */
export function liveBarSeconds(tf: string): number | null {
  return FIXED[tf] ?? null;
}

/**
 * Nächster Zustand der letzten Kerze nach einem Tick; null = Tick ignorieren.
 * `barSec` null → nur die laufende Kerze aktualisieren (nie eine neue erfinden).
 */
export function applyTick(last: Bar, price: number, tickMs: number, barSec: number | null): Bar | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  const t = Math.floor(tickMs / 1000);
  if (t < last.time) return null;
  if (barSec !== null && t >= last.time + barSec) {
    const time = last.time + Math.floor((t - last.time) / barSec) * barSec;
    return { time, open: price, high: price, low: price, close: price };
  }
  return { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price };
}
