import { useEffect, useState } from 'react';
import { buildTabHash, parseTab } from './tab-hash.js';

/**
 * Aktiver Tab im Location-Hash (`#/seite?tab=x`): Deep-Links, ⌘K-Suche und
 * Brotkrumen landen damit direkt im richtigen Tab. Reagiert auf Hash-Wechsel
 * (Palette/Weiterleitungen) und schreibt Wechsel per replaceState zurück.
 */
export function useHashTab<T extends string>(base: string, tabs: readonly T[], fallback: T): [T, (tab: T) => void] {
  const [tab, setTab] = useState<T>(() => parseTab(window.location.hash, tabs, fallback) as T);

  useEffect(() => {
    const onHash = () => setTab(parseTab(window.location.hash, tabs, fallback) as T);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [tabs, fallback]);

  function change(next: T) {
    setTab(next);
    window.history.replaceState(null, '', buildTabHash(base, next));
    // Brotkrumen (Shell) hören auf hashchange — replaceState feuert keinen.
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }

  return [tab, change];
}
