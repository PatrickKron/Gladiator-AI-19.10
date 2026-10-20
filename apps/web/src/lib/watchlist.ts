/**
 * Watchlist der Markt-Bühne (UI-Welle 4): Favoriten zuerst, dann die übrigen
 * Märkte des Scan-Universums; Tastatur-Navigation ↑/↓ (bzw. k/j) mit
 * Umlauf. Rein & getestet.
 */

export function buildWatchlist(universe: string[], favorites: string[], current: string): string[] {
  const fav = new Set(favorites);
  const all = [...new Set([...universe, current])];
  return [...all.filter((s) => fav.has(s)), ...all.filter((s) => !fav.has(s))];
}

/** Nächstes/vorheriges Symbol mit Umlauf; unbekanntes aktuelles → erstes. */
export function stepSymbol(list: string[], current: string, dir: 1 | -1): string {
  if (list.length === 0) return current;
  const i = list.indexOf(current);
  if (i < 0) return list[0]!;
  return list[(i + dir + list.length) % list.length]!;
}

/** Taste → Richtung; null = nicht für die Watchlist. */
export function keyDirection(key: string): 1 | -1 | null {
  if (key === 'ArrowDown' || key === 'j') return 1;
  if (key === 'ArrowUp' || key === 'k') return -1;
  return null;
}

/** In Eingabefeldern, Auswahllisten und editierbaren Bereichen nie Tasten abfangen. */
export function isTypingTarget(el: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!el) return false;
  const tag = (el.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}
