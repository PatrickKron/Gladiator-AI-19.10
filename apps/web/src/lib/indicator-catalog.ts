import { trpc } from '../api.js';
import type { MenuEntry } from './indicator-menu.js';

/**
 * Katalog der Indikator-Bibliothek einmal je Sitzung laden (reine Metadaten,
 * ~160 Einträge) — geteilt von Chart-Menü und Markt-Screener.
 */
let catalogCache: MenuEntry[] | null = null;
let catalogPromise: Promise<MenuEntry[]> | null = null;

export function cachedCatalog(): MenuEntry[] | null {
  return catalogCache;
}

export function loadCatalog(): Promise<MenuEntry[]> {
  if (catalogCache) return Promise.resolve(catalogCache);
  catalogPromise ??= trpc.indicators.catalog
    .query()
    .then((rows) => {
      catalogCache = rows as MenuEntry[];
      return catalogCache;
    })
    .catch((e: unknown) => {
      catalogPromise = null;
      throw e;
    });
  return catalogPromise;
}
