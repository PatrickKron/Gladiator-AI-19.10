/**
 * UI-Modus (UI-Konzept „Beste beider Welten", Patrick-Abnahme 2026-07-08):
 * - 'einfach' | 'profi' — Progressive Disclosure, verlustfrei & sofort
 *   reversibel (Binance-Lite/Pro-Muster). Default: einfach; die Wahl bleibt.
 * - 'classicNav' — Sofort-Rückweg zur alten 17-Punkte-Navigation OHNE Deploy
 *   (Patricks Bedingung: alles muss ganz rückgängig machbar sein).
 * Reine UI-Präferenzen im localStorage — es hängt KEINE Sicherheit daran.
 */

export type UiMode = 'einfach' | 'profi';

const MODE_KEY = 'gladiator.uiMode';
const CLASSIC_KEY = 'gladiator.classicNav';
const EVENT = 'gladiator:ui-mode';

export function getUiMode(): UiMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'profi' ? 'profi' : 'einfach';
  } catch {
    return 'einfach';
  }
}

export function setUiMode(mode: UiMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // localStorage gesperrt → Modus gilt nur für die Laufzeit der Seite
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function isClassicNav(): boolean {
  try {
    return window.localStorage.getItem(CLASSIC_KEY) === '1';
  } catch {
    return false;
  }
}

export function setClassicNav(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(CLASSIC_KEY, '1');
    else window.localStorage.removeItem(CLASSIC_KEY);
  } catch {
    // s. o.
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Auf Modus-/Nav-Änderungen hören (gleiche Seite + andere Tabs). */
export function onUiModeChange(fn: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === MODE_KEY || e.key === CLASSIC_KEY) fn();
  };
  window.addEventListener(EVENT, fn);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener('storage', onStorage);
  };
}
