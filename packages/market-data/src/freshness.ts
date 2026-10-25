import { TIMEFRAME_MS } from './timeframes.js';

/**
 * Frische-Regel für Kerzen (Asset-Register, Patrick 2026-10-25): Screener, Screen-Alarme und
 * Preis-Alarme dürfen nie auf alten Kerzen handeln. Eine Reihe ist frisch, solange ihre
 * neueste Kerze jünger ist als FRESH_INTERVALS Kerzenlängen — mit einer Untergrenze je
 * Quelle: 24/7-Märkte (Binance) mindestens 1 h (der Refresh-Job läuft alle 15 min),
 * Börsenzeiten-Quellen (Yahoo, Twelve Data) mindestens 4 Tage, damit ein Wochenende plus
 * Feiertag den Freitags-Schluss nicht „veralten“ lässt. Unbekannte Quellen gelten als 24/7
 * (strenger). Rein, ohne DB — dieselbe Regel für SQL-Abfragen (freshCutoff) und Einzelprüfung.
 */

export const FRESH_INTERVALS = 3;

const HOUR_MS = 3_600_000;
const CONTINUOUS_FLOOR_MS = HOUR_MS;
const SESSION_FLOOR_MS = 4 * 24 * HOUR_MS;
const SESSION_VENUES = new Set(['yahoo', 'twelvedata']);

/** Maximales Alter der neuesten Kerze, bis die Reihe als veraltet gilt. */
export function freshnessLimitMs(timeframe: string, venue = 'binance'): number {
  const interval = (TIMEFRAME_MS as Record<string, number>)[timeframe] ?? HOUR_MS;
  const floor = SESSION_VENUES.has(venue) ? SESSION_FLOOR_MS : CONTINUOUS_FLOOR_MS;
  return Math.max(FRESH_INTERVALS * interval, floor);
}

/** Ältester noch frischer Zeitpunkt der neuesten Kerze. */
export function freshCutoff(timeframe: string, venue = 'binance', now: Date = new Date()): Date {
  return new Date(now.getTime() - freshnessLimitMs(timeframe, venue));
}

/** Ist die neueste Kerze (Zeitstempel) frisch genug? Fehlend/unlesbar = veraltet. */
export function isCandleFresh(lastTs: Date | string | number | null | undefined, timeframe: string, venue = 'binance', now: Date = new Date()): boolean {
  if (lastTs == null) return false;
  const t = new Date(lastTs).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= freshCutoff(timeframe, venue, now).getTime();
}

export type CloseCandidate = { timeframe: string; ts: Date; close: number };
export type LatestClose =
  | { ok: true; price: number; timeframe: string; ts: Date }
  | { ok: false; reason: 'no_candles' | 'stale'; lastTs: Date | null };

/**
 * Letzter echter Schlusskurs aus den neuesten Kerzen mehrerer Zeitrahmen: die neueste FRISCHE
 * Kerze gewinnt. Nur veraltete Kerzen ⇒ `stale` (mit Zeitpunkt der neuesten) — nie ein alter
 * Kurs als „aktuell“.
 */
export function pickLatestClose(candles: CloseCandidate[], venue: string, now: Date = new Date()): LatestClose {
  const valid = candles.filter((c) => Number.isFinite(c.close) && c.close > 0);
  if (valid.length === 0) return { ok: false, reason: 'no_candles', lastTs: null };
  const fresh = valid.filter((c) => isCandleFresh(c.ts, c.timeframe, venue, now));
  if (fresh.length === 0) {
    const lastTs = valid.reduce((a, b) => (b.ts > a.ts ? b : a)).ts;
    return { ok: false, reason: 'stale', lastTs };
  }
  const best = fresh.reduce((a, b) => (b.ts > a.ts ? b : a));
  return { ok: true, price: best.close, timeframe: best.timeframe, ts: best.ts };
}
