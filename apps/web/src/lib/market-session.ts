/**
 * Handels-Sessions (Patricks Wunsch: „welche Session läuft gerade") —
 * exakt dieselben UTC-Fenster wie packages/strategy-engine/src/session.ts
 * (eine Wahrheit): Asia 00–07 · London 07–13 · Overlap 13–16 · New York
 * 16–21 · sonst off. Deterministisch aus der Uhrzeit, kein Netz nötig.
 */

export type MarketSession = 'asia' | 'london' | 'overlap' | 'newyork' | 'off';

export const SESSION_WINDOWS: { session: Exclude<MarketSession, 'off'>; fromH: number; toH: number }[] = [
  { session: 'asia', fromH: 0, toH: 7 },
  { session: 'london', fromH: 7, toH: 13 },
  { session: 'overlap', fromH: 13, toH: 16 },
  { session: 'newyork', fromH: 16, toH: 21 },
];

export function sessionAt(date: Date): MarketSession {
  const h = date.getUTCHours();
  for (const w of SESSION_WINDOWS) {
    if (h >= w.fromH && h < w.toH) return w.session;
  }
  return 'off';
}

/** Nächster Session-Start (für „beginnt in …"). */
export function nextSessionStart(date: Date): { session: Exclude<MarketSession, 'off'>; startsAt: Date } {
  const h = date.getUTCHours();
  for (const w of SESSION_WINDOWS) {
    if (h < w.fromH) {
      const startsAt = new Date(date);
      startsAt.setUTCHours(w.fromH, 0, 0, 0);
      return { session: w.session, startsAt };
    }
  }
  // Nach New York (≥21 h) → Asia am Folgetag 00:00 UTC
  const startsAt = new Date(date);
  startsAt.setUTCDate(startsAt.getUTCDate() + 1);
  startsAt.setUTCHours(0, 0, 0, 0);
  return { session: 'asia', startsAt };
}

/** Ende der aktuell laufenden Session (null wenn gerade keine läuft). */
export function currentSessionEnd(date: Date): Date | null {
  const h = date.getUTCHours();
  for (const w of SESSION_WINDOWS) {
    if (h >= w.fromH && h < w.toH) {
      const end = new Date(date);
      end.setUTCHours(w.toH, 0, 0, 0);
      return end;
    }
  }
  return null;
}
