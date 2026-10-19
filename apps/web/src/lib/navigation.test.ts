import { describe, expect, it } from 'vitest';
import { AREAS, NAV_PAGES as PAGES, findPage, navEntries, pageForHash, resolveRedirect, searchNav, type NavEntry } from './navigation.js';
import { de } from '../i18n/de.js';

/** Übersetzer-Stub: schlägt Keys im DE-Katalog nach (wie i18next). */
function t(key: string): string {
  let cur: unknown = de;
  for (const part of key.split('.')) cur = (cur as Record<string, unknown> | undefined)?.[part];
  if (typeof cur !== 'string') throw new Error(`fehlender i18n-Key: ${key}`);
  return cur;
}

describe('Funktions-Registry (eine Wahrheit für Sidebar, Suche, Brotkrumen, Weiterleitungen)', () => {
  it('genau 5 Bereiche, jede Seite gehört zu genau einem Bereich', () => {
    expect(AREAS).toHaveLength(5);
    const ids = PAGES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PAGES) expect(AREAS.map((a) => a.id)).toContain(p.area);
  });

  it('Hashes und Tab-IDs sind eindeutig', () => {
    const hashes = PAGES.map((p) => p.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
    for (const p of PAGES) {
      const tabs = (p.tabs ?? []).map((x) => x.id);
      expect(new Set(tabs).size).toBe(tabs.length);
    }
  });

  it('jeder Label-/Beschreibungs-Key existiert im Katalog', () => {
    for (const a of AREAS) t(a.labelKey);
    for (const p of PAGES) {
      t(p.labelKey);
      t(p.descKey);
      for (const tab of p.tabs ?? []) t(tab.labelKey);
    }
  });

  it('pageForHash ignoriert Query-Strings und erkennt die Startseite', () => {
    expect(pageForHash('#/trading?tab=historie')?.id).toBe('trade');
    expect(pageForHash('')?.id).toBe('today');
    expect(pageForHash('#/')?.id).toBe('today');
    expect(pageForHash('#/gibtsnicht')).toBeNull();
    expect(findPage('settings').hash).toBe('#/einstellungen');
  });

  describe('Weiterleitungen alter Links (Bookmarks bleiben gültig)', () => {
    it.each([
      ['#/oracle', '#/marktlage?tab=makro'],
      ['#/aegis', '#/marktlage?tab=risiko'],
      ['#/ml', '#/intelligenz?tab=ml'],
      ['#/rl-agenten', '#/intelligenz?tab=rl'],
      ['#/performance', '#/intelligenz?tab=performance'],
      ['#/intelligenz?tab=intel', '#/marktlage?tab=entscheidung'],
      ['#/charts?symbol=ETH%2FUSDT&tab=makro', '#/marktlage?tab=makro'],
      ['#/charts?tab=risiko', '#/marktlage?tab=risiko'],
    ])('%s → %s', (from, to) => {
      expect(resolveRedirect(from)).toBe(to);
    });

    it('normale Links werden nicht umgeleitet', () => {
      expect(resolveRedirect('#/charts?symbol=BTC%2FUSDT&tab=kontext')).toBeNull();
      expect(resolveRedirect('#/intelligenz?tab=rl')).toBeNull();
      expect(resolveRedirect('#/')).toBeNull();
    });

    it('jedes Weiterleitungsziel ist eine echte Seite mit echtem Tab', () => {
      for (const from of ['#/oracle', '#/aegis', '#/ml', '#/rl-agenten', '#/performance', '#/intelligenz?tab=intel']) {
        const to = resolveRedirect(from)!;
        const page = pageForHash(to)!;
        const tab = new URLSearchParams(to.split('?')[1]).get('tab');
        expect(page.tabs?.some((x) => x.id === tab)).toBe(true);
      }
    });
  });

  describe('Suche (⌘K) über Seiten, Tabs und Suchbegriffe', () => {
    const entries: NavEntry[] = navEntries(t);
    const first = (q: string) => searchNav(entries, q)[0]?.hash;

    it('jede Seite und jeder Tab ist als Eintrag auffindbar', () => {
      const tabCount = PAGES.reduce((n, p) => n + (p.tabs?.length ?? 0), 0);
      expect(entries.filter((e) => e.kind === 'page')).toHaveLength(PAGES.length);
      expect(entries.filter((e) => e.kind === 'tab')).toHaveLength(tabCount);
    });

    it('findet über Synonyme, nicht nur über Seitennamen', () => {
      expect(first('api key')).toBe('#/einstellungen?tab=keys');
      expect(first('binance')).toBe('#/einstellungen?tab=boersen');
      expect(first('backtest')).toBe('#/labor');
      expect(first('pine')).toBe('#/strategien?tab=pine');
      expect(first('cot')).toBe('#/marktlage?tab=entscheidung');
      expect(first('alarm')).toBe('#/trading?tab=alerts');
    });

    it('Groß-/Kleinschreibung und Umlaute egal, mehrere Wörter müssen alle passen', () => {
      expect(first('VERMÖGEN')).toBe('#/vermoegen');
      expect(first('vermogen')).toBe('#/vermoegen');
      expect(searchNav(entries, 'demo historie').every((e) => e.hash.startsWith('#/demo') || e.label.toLowerCase().includes('historie'))).toBe(true);
      expect(searchNav(entries, 'xyzqq')).toEqual([]);
    });

    it('leere Suche zeigt die Seiten in Sidebar-Reihenfolge', () => {
      const res = searchNav(entries, '', 5);
      expect(res.map((e) => e.hash)).toEqual(PAGES.slice(0, 5).map((p) => p.hash));
    });
  });
});
