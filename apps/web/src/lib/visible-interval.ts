/**
 * Polling nur bei sichtbarem Tab: Ticks im Hintergrund-Tab werden übersprungen
 * (kein Server-/Akku-Verbrauch für ungesehene Daten), beim Zurückkehren wird
 * sofort einmal aktualisiert — die Seite ist dann nie veraltet.
 * Drop-in für window.setInterval/clearInterval.
 */
const active = new Map<number, () => void>();
let listening = false;

function onVisibility(): void {
  if (document.visibilityState !== 'visible') return;
  for (const fn of active.values()) fn();
}

export function setVisibleInterval(fn: () => void, ms: number): number {
  if (!listening && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
    listening = true;
  }
  const id = window.setInterval(() => {
    if (document.visibilityState === 'visible') fn();
  }, ms);
  active.set(id, fn);
  return id;
}

export function clearVisibleInterval(id: number): void {
  window.clearInterval(id);
  active.delete(id);
}
