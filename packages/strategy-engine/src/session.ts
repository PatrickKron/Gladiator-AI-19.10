import type { TradingSession } from './scoring.js';

/**
 * Session-Fenster (05_ §8), UTC-basiert:
 * Asia 00–07 · London 07–13 · Overlap (London∩NY) 13–16 · New York 16–21 · sonst off.
 * Der Overlap ist separat, damit Session-Statistiken ihn eigenständig bewerten können
 * (Patrick-Anforderung). Bewusste Vereinfachung mit festen UTC-Fenstern; DST-genaue,
 * pro Strategie konfigurierbare Fenster kommen mit der Registry-Konfiguration.
 */
export function sessionOf(ts: Date): TradingSession {
  const hour = ts.getUTCHours();
  if (hour < 7) return 'asia';
  if (hour < 13) return 'london';
  if (hour < 16) return 'overlap';
  if (hour < 21) return 'newyork';
  return 'off';
}

/** London/Overlap/New York gelten als aktive Fenster (+0.5 im Scoring). */
export function isActiveSession(session: TradingSession): boolean {
  return session === 'london' || session === 'newyork' || session === 'overlap';
}
