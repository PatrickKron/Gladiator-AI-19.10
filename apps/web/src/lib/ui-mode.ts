/**
 * UI-Modus: 'einfach' | 'profi' — Progressive Disclosure, verlustfrei &
 * sofort reversibel (Binance-Lite/Pro-Muster). Default: einfach; Wahl bleibt.
 * Die klassische Navigation wurde mit dem Umbau 2026-07-10 GELÖSCHT
 * (Patrick-Freigabe: eine Navigation, eine Wahrheit).
 * Reine UI-Präferenz im localStorage — es hängt KEINE Sicherheit daran.
 */

export type UiMode = 'einfach' | 'profi';

const MODE_KEY = 'gladiator.uiMode';
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

/** Auf Modus-Änderungen hören (gleiche Seite + andere Tabs). */
export function onUiModeChange(fn: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === MODE_KEY) fn();
  };
  window.addEventListener(EVENT, fn);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener('storage', onStorage);
  };
}
