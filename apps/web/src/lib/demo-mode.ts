/**
 * Demo-Modus-Schalter (Session 5): reine UI-Präferenz im localStorage —
 * die SICHERHEIT hängt nicht daran (der Demo-Pfad ist serverseitig ein
 * eigener Router auf eigene Tabellen; echte Order-Pfade existieren im
 * Demo-Router nicht). Topbar-Badge und Trading-Seite hören auf Änderungen.
 */

const KEY = 'gladiator.demoMode';
const EVENT = 'gladiator:demo-mode';

export function isDemoMode(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setDemoMode(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(KEY, '1');
    else window.localStorage.removeItem(KEY);
  } catch {
    // localStorage gesperrt → Modus gilt nur für die Laufzeit der Seite
  }
  window.dispatchEvent(new CustomEvent<boolean>(EVENT, { detail: on }));
}

/** Auf Änderungen hören (gleiche Seite via CustomEvent, andere Tabs via storage). */
export function onDemoModeChange(fn: (on: boolean) => void): () => void {
  const onCustom = (e: Event) => fn(Boolean((e as CustomEvent<boolean>).detail));
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) fn(e.newValue === '1');
  };
  window.addEventListener(EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}
