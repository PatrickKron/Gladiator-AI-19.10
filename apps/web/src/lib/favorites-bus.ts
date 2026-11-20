const EVENT = 'gladiator:favorites-changed';

/** Informiert Watchlist, AssetSelect & CommandPalette sofort über geänderte Favoriten / neue Märkte. */
export function notifyFavoritesChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT));
}

export function onFavoritesChange(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
