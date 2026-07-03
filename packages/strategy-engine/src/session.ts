import type { TradingSession } from './scoring.js';

/**
 * Session-Fenster (05_ §8), UTC-basiert:
 * Asia 00–07, London 07–13, New York 13–21, sonst off.
 * Bewusste Vereinfachung mit festen UTC-Fenstern; DST-genaue und pro Strategie
 * konfigurierbare Fenster kommen mit der Strategie-Registry-Konfiguration.
 */
export function sessionOf(ts: Date): TradingSession {
  const hour = ts.getUTCHours();
  if (hour < 7) return 'asia';
  if (hour < 13) return 'london';
  if (hour < 21) return 'newyork';
  return 'off';
}

/** London/New York gelten als aktive Fenster (+0.5 im Scoring). */
export function isActiveSession(session: TradingSession): boolean {
  return session === 'london' || session === 'newyork';
}
