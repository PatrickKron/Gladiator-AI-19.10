import { describe, expect, it } from 'vitest';
import { AREAS, NAV_PAGES, NAV_PAGES as PAGES, findPage, navEntries, pageForHash, resolveRedirect, searchNav, subnavPages, tabForHash, type NavEntry } from './navigation.js';
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
    // jeder Bereich hat eine Einstiegsseite in seinem eigenen Bereich und ein Icon (Tableiste)
    for (const a of AREAS) {
      const landing = PAGES.find((p) => p.hash === a.hash);
      expect(landing?.area).toBe(a.id);
      expect(a.icon.length).toBeGreaterThan(5);
    }
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
    expect(pageForHash('#/traden?tab=historie')?.id).toBe('trade');
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
      // Welle 3: alte Konto-Seiten → #/traden, Unter-Tab bleibt erhalten
      ['#/strategie-workshop', '#/strategien?tab=workshop'],
      ['#/demo', '#/traden?tab=demo'],
      ['#/wallet', '#/traden?tab=wallet'],
      ['#/trading', '#/traden?tab=positionen'],
      ['#/trading?tab=risiko', '#/traden?tab=risiko'],
    ])('%s → %s', (from, to) => {
      expect(resolveRedirect(from)).toBe(to);
    });

    it('normale Links werden nicht umgeleitet', () => {
      expect(resolveRedirect('#/charts?symbol=BTC%2FUSDT&tab=kontext')).toBeNull();
      // Makro/Risiko sind wieder Tabs der Chart-Seite (wie v2) — keine Umleitung mehr in die Marktlage
      expect(resolveRedirect('#/charts?tab=makro')).toBeNull();
      expect(resolveRedirect('#/charts?symbol=ETH%2FUSDT&tab=risiko')).toBeNull();
      expect(resolveRedirect('#/intelligenz?tab=rl')).toBeNull();
      expect(resolveRedirect('#/')).toBeNull();
    });

    it('jedes Weiterleitungsziel ist eine echte Seite mit echtem Tab', () => {
      for (const from of ['#/oracle', '#/aegis', '#/ml', '#/rl-agenten', '#/performance', '#/intelligenz?tab=intel', '#/demo', '#/wallet', '#/trading', '#/trading?tab=alerts', '#/strategie-workshop']) {
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
      expect(first('alarm')).toBe('#/traden?tab=alerts');
      expect(first('memecoin')).toBe('#/traden?tab=wallet');
      expect(first('demo')).toBe('#/traden?tab=demo');
      expect(first('audit')).toBe('#/protokoll');
      expect(first('wer hat')).toBe('#/protokoll');
    });

    it('Groß-/Kleinschreibung und Umlaute egal, mehrere Wörter müssen alle passen', () => {
      expect(first('VERMÖGEN')).toBe('#/vermoegen');
      expect(first('vermogen')).toBe('#/vermoegen');
      expect(searchNav(entries, 'konto historie').every((e) => e.hash.startsWith('#/traden') || e.label.toLowerCase().includes('historie'))).toBe(true);
      expect(searchNav(entries, 'xyzqq')).toEqual([]);
    });

    it('leere Suche zeigt die Seiten in Sidebar-Reihenfolge', () => {
      const res = searchNav(entries, '', 5);
      expect(res.map((e) => e.hash)).toEqual(PAGES.slice(0, 5).map((p) => p.hash));
    });
  });

  describe('Welle F: Segmentleiste im Einfach-Modus', () => {
    it('Profi zeigt alle Seiten des Bereichs, nichts hinter „Mehr"', () => {
      const r = subnavPages('agents', 'profi', '#/strategien');
      expect(r.shown.map((p) => p.id)).toEqual(['agents', 'strategies', 'lab', 'aiModels']);
      expect(r.more).toEqual([]);
    });
    it('Einfach: Labor und KI-Modelle hinter „Mehr", Agenten und Strategien bleiben', () => {
      const r = subnavPages('agents', 'einfach', '#/strategien');
      expect(r.shown.map((p) => p.id)).toEqual(['agents', 'strategies']);
      expect(r.more.map((p) => p.id)).toEqual(['lab', 'aiModels']);
    });
    it('die aktive Seite bleibt immer sichtbar, auch wenn sie „advanced" ist', () => {
      const r = subnavPages('agents', 'einfach', '#/labor');
      expect(r.shown.map((p) => p.id)).toEqual(['agents', 'strategies', 'lab']);
      expect(r.more.map((p) => p.id)).toEqual(['aiModels']);
    });
    it('jede Seite bleibt erreichbar: shown + more = alle Seiten des Bereichs, kein Hash ändert sich', () => {
      for (const area of ['market', 'trade', 'agents', 'system', 'today'] as const) {
        const all = NAV_PAGES.filter((p) => p.area === area).map((p) => p.hash);
        const r = subnavPages(area, 'einfach', '#/');
        expect([...r.shown, ...r.more].map((p) => p.hash).sort()).toEqual([...all].sort());
      }
    });
  });

  it('Chart-Seite: Tabs Chart · Analyse · Makro · Risiko (wie v2); Marktlage behält Makro und Risiko', () => {
    const chart = pageForHash('#/charts')!;
    expect(chart.tabs?.map((x) => x.id)).toEqual(['chart', 'kontext', 'makro', 'risiko']);
    expect(tabForHash(chart, '#/charts?symbol=ETH%2FUSDT&tab=makro')?.labelKey).toBe('asset.tab_makro');
    expect(tabForHash(chart, '#/charts?tab=risiko')?.labelKey).toBe('asset.tab_risiko');
    expect(pageForHash('#/marktlage')?.tabs?.map((x) => x.id)).toEqual(['makro', 'risiko', 'entscheidung', 'daten']);
    // Suche findet beide Orte
    const hashes = searchNav(navEntries(t), 'makro', 20).map((e) => e.hash);
    expect(hashes).toContain('#/charts?tab=makro');
    expect(hashes).toContain('#/marktlage?tab=makro');
  });

  it('Welle E: alte Werkstatt-Links landen als Tab unter Agenten', () => {
    expect(resolveRedirect('#/werkstatt')).toBe('#/agenten?tab=werkstatt');
    expect(pageForHash('#/werkstatt')).toBeNull();
    expect(pageForHash('#/agenten')?.tabs?.map((t) => t.id)).toEqual(['uebersicht', 'werkstatt']);
  });
});
