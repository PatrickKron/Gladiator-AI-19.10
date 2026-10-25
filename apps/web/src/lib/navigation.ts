/**
 * Funktions-Registry: EINE Wahrheit darüber, welche Seiten und Tabs es gibt,
 * wo sie liegen, wie sie heißen und unter welchen Begriffen man sie findet.
 *
 * Sidebar, ⌘K-Suche, Brotkrumen, die „Alle Funktionen"-Übersicht und die
 * Weiterleitungen alter Links lesen ALLE aus dieser Datei. Eine neue Funktion
 * wird hier einmal eingetragen und taucht danach automatisch überall auf —
 * nichts kann mehr „irgendwo versteckt" sein. Die Komponenten-Zuordnung
 * (Hash → View) liegt in App.tsx und ist dort typgeprüft gegen PageHash.
 *
 * Rein (kein React, kein DOM) → vollständig getestet (navigation.test.ts).
 */

export type AreaId = 'today' | 'market' | 'trade' | 'agents' | 'system';

/** Bereich = Eintrag in Seitenleiste (Desktop) und Tableiste (Handy); `hash` = Einstiegsseite. */
export type NavArea = { id: AreaId; labelKey: string; hash: string; icon: string };

export type NavTab = {
  id: string;
  labelKey: string;
  /** Zusätzliche Suchbegriffe (DE+EN, Kleinschreibung), z. B. Synonyme. */
  keywords?: string[];
};

export type NavPage = {
  id: string;
  hash: string;
  area: AreaId;
  labelKey: string;
  descKey: string;
  /** SVG-Pfad (24er-Viewbox, Stroke) für Sidebar & Übersicht. */
  icon: string;
  keywords?: string[];
  tabs?: NavTab[];
  /** Einfach-Modus (Welle F): Seite steht in der Segmentleiste hinter „Mehr" — bleibt erreichbar, kein Link ändert sich. */
  advanced?: boolean;
};

/** Genau 5 Bereiche (Patricks Vorgabe aus dem Umbau 2026-07-10). */
export const AREAS: NavArea[] = [
  { id: 'today', labelKey: 'ia.area_today', hash: '#/', icon: 'M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10' },
  { id: 'market', labelKey: 'ia.area_market', hash: '#/charts', icon: 'M4 19V5m0 14h16M8 14l3-3 2 2 4-5' },
  { id: 'trade', labelKey: 'ia.area_trade', hash: '#/traden', icon: 'M7 10l5-5 5 5M7 14l5 5 5-5' },
  { id: 'agents', labelKey: 'ia.area_agents', hash: '#/strategien', icon: 'M12 3l2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6L7.1 18.2l.9-5.5-4-3.9L9.5 8z' },
  { id: 'system', labelKey: 'ia.area_system', hash: '#/einstellungen', icon: 'M5 12h.01M12 12h.01M19 12h.01M6 12a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0z' },
];

/** Reihenfolge = Sidebar-Reihenfolge. */
export const PAGES = [
  {
    id: 'today',
    hash: '#/',
    area: 'today',
    labelKey: 'ia.page_today',
    descKey: 'ia.desc_today',
    icon: 'M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10',
    keywords: ['dashboard', 'start', 'home', 'briefing', 'favoriten', 'watchlist'],
  },
  {
    id: 'chart',
    hash: '#/charts',
    area: 'market',
    labelKey: 'ia.page_chart',
    descKey: 'ia.desc_chart',
    icon: 'M4 19V5m0 14h16M8 14l3-3 2 2 4-5',
    keywords: ['kerzen', 'candles', 'indikator', 'indicator', 'asset', 'symbol', 'timeframe'],
    tabs: [
      { id: 'chart', labelKey: 'asset.tab_chart', keywords: ['kerzen', 'indikatoren', 'orderbuch', 'order book', 'tiefe', 'zeichnen', 'trendlinie', 'fibonacci'] },
      { id: 'kontext', labelKey: 'asset.tab_kontext', keywords: ['rsi', 'atr', 'funding', 'struktur', 'regime'] },
      // Wie v2 (Patrick 2026-10-24): Makro und Risiko auch direkt am Chart — dieselben Komponenten wie die Marktlage.
      { id: 'makro', labelKey: 'asset.tab_makro', keywords: ['makro am chart', 'macro'] },
      { id: 'risiko', labelKey: 'asset.tab_risiko', keywords: ['risiko am chart', 'risk'] },
    ],
  },
  {
    id: 'screener',
    advanced: true,
    hash: '#/screener',
    area: 'market',
    labelKey: 'ia.page_screener',
    descKey: 'ia.desc_screener',
    icon: 'M3 5h18l-7 8v6l-4 2v-8L3 5z',
    keywords: ['scanner', 'screener', 'filter', 'bedingungen', 'conditions', 'rsi', 'überverkauft', 'oversold', 'muster', 'pattern', 'sweep', 'discount', 'universum', 'vorlagen', 'presets'],
  },
  {
    id: 'signals',
    hash: '#/signals',
    area: 'market',
    labelKey: 'ia.page_signals',
    descKey: 'ia.desc_signals',
    icon: 'M3 12h4l3-8 4 16 3-8h4',
    keywords: ['setup', 'signal', 'bestätigen', 'confirm', 'ticket', 'smc', 'was wäre passiert', 'abgelaufen', 'hindsight'],
  },
  {
    id: 'marketState',
    advanced: true,
    hash: '#/marktlage',
    area: 'market',
    labelKey: 'ia.page_marketState',
    descKey: 'ia.desc_marketState',
    icon: 'M12 3a9 9 0 100 18 9 9 0 000-18zm-9 9h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z',
    keywords: ['makro', 'macro', 'oracle', 'aegis', 'vix', 'dxy', 'zinsen'],
    tabs: [
      { id: 'makro', labelKey: 'asset.tab_makro', keywords: ['vix', 'dxy', 'us10y', 'funding', 'open interest', 'grs'] },
      { id: 'risiko', labelKey: 'asset.tab_risiko', keywords: ['gates', 'risk', 'aegis', 'was funktioniert'] },
      { id: 'entscheidung', labelKey: 'ia.tab_entscheidung', keywords: ['cpi', 'cot', 'buffett', 'no-trade', 'intelligence'] },
      { id: 'daten', labelKey: 'ia.tab_daten', keywords: ['fred', 'datenquellen', 'data', 'geldmenge', 'm2', 'zinskurve', 'fed bilanz', 'arbeitsmarkt', 'watchlist'] },
    ],
  },
  {
    id: 'discover',
    hash: '#/pakete',
    area: 'market',
    labelKey: 'ia.page_discover',
    descKey: 'ia.desc_discover',
    icon: 'M21 8l-9-5-9 5 9 5 9-5zm-18 0v8l9 5 9-5V8M12 13v8',
    keywords: ['pakete', 'packages', 'assets', 'aktien', 'stocks', 'etf', 'krypto', 'suche'],
  },
  {
    // Patrick 2026-10-25: „Heatmaps und so weiter sollen benutzbar sein — die Übersicht." Nur echte Kurse/Kerzen.
    id: 'heatmap',
    hash: '#/heatmap',
    area: 'market',
    labelKey: 'ia.page_heatmap',
    descKey: 'ia.desc_heatmap',
    icon: 'M3 3h10v10H3zM15 3h6v6h-6zM15 11h6v10h-6zM3 15h10v6H3z',
    keywords: ['heatmap', 'heat map', 'performance', 'korrelation', 'correlation', 'übersicht', 'overview', 'treemap', 'kacheln', 'tiles', 'gewinner', 'verlierer', 'winners', 'losers', 'tagesänderung'],
    tabs: [
      { id: 'performance', labelKey: 'ia.tab_heatmapPerformance', keywords: ['performance', 'tagesänderung', 'daily change', '24h', 'gewinner', 'verlierer', 'treemap', 'kacheln'] },
      { id: 'korrelation', labelKey: 'ia.tab_heatmapKorrelation', keywords: ['korrelation', 'correlation', 'matrix', 'gleichlauf', 'diversifikation', 'diversification', 'pearson'] },
    ],
  },
  {
    id: 'calendar',
    hash: '#/kalender',
    area: 'market',
    labelKey: 'ia.page_calendar',
    descKey: 'ia.desc_calendar',
    icon: 'M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2zm3-3v4m8-4v4M3 10h18',
    keywords: ['termine', 'events', 'cpi', 'fomc', 'nfp', 'sessions', 'wirtschaft'],
  },
  {
    id: 'news',
    hash: '#/magazine',
    area: 'market',
    labelKey: 'ia.page_news',
    descKey: 'ia.desc_news',
    icon: 'M4 4h11a3 3 0 013 3v13H7a3 3 0 01-3-3V4zm14 4h2v12a2 2 0 01-2 2M8 8h6M8 12h6',
    keywords: ['magazin', 'magazine', 'artikel', 'zusammenfassung', 'summary'],
  },
  {
    // Welle 3: EINE Seite fürs Traden mit Konto-Schalter (Demo · Agenten-Konto · Wallets).
    // Die Konten sind Tabs: `demo`/`wallet` wählen das Konto, die übrigen Tabs gehören zum Agenten-Konto.
    id: 'trade',
    hash: '#/traden',
    area: 'trade',
    labelKey: 'ia.page_tradeHub',
    descKey: 'ia.desc_tradeHub',
    icon: 'M4 19V5m0 14h16M8 15l3-4 3 2 5-7',
    keywords: ['traden', 'trade', 'konto', 'order', 'kaufen', 'verkaufen', 'buy', 'sell', 'agenten-konto', 'paper', 'kill-switch'],
    tabs: [
      { id: 'demo', labelKey: 'ia.page_demo', keywords: ['demo', 'selbst handeln', 'orderbuch', 'limit', 'market', 'manuell', 'üben', 'hebel', 'leverage', 'börsenvergleich'] },
      {
        id: 'wallet',
        labelKey: 'ia.page_wallet',
        keywords: ['wallet', 'swap', 'spot', 'meme', 'memecoin', 'token', 'solana', 'jupiter', 'uniswap', 'kyberswap', 'trojan', 'dex', 'base', 'ethereum', 'auto-sell', 'take profit', 'stop loss', 'honeypot'],
      },
      { id: 'positionen', labelKey: 'trading.tab_positionen', keywords: ['position', 'stop', 'sl', 'tp', 'schliessen', 'close', 'stop verschieben', 'agenten'] },
      { id: 'historie', labelKey: 'trading.tab_historie', keywords: ['journal', 'notiz', 'trades', 'history'] },
      { id: 'risiko', labelKey: 'trading.tab_risiko', keywords: ['positionsgröße', 'sizing', 'rechner', 'live-freigabe', 'venue'] },
      { id: 'alerts', labelKey: 'trading.tab_alerts', keywords: ['alarm', 'preisalarm', 'benachrichtigung'] },
      { id: 'performance', labelKey: 'trading.tab_performance', keywords: ['pnl', 'winrate', 'profit factor', 'erwartungswert'] },
    ],
  },
  {
    // Patricks Mängelliste 2026-10-22, Punkt 5: echtes Geld auf einen Blick erklärt — drei Wege, Status, nächster Schritt.
    id: 'realMoney',
    hash: '#/echtes-geld',
    area: 'trade',
    labelKey: 'ia.page_realMoney',
    descKey: 'ia.desc_realMoney',
    icon: 'M3 7h18v10H3zM7 7V5h10v2M12 10a2 2 0 100 4 2 2 0 000-4z',
    keywords: ['echtes geld', 'real money', 'börse', 'exchange', 'wallet anschließen', 'dezentral', 'dex', 'live', 'freigabe', 'api-key'],
  },
  {
    id: 'wealth',
    hash: '#/vermoegen',
    area: 'trade',
    labelKey: 'ia.page_wealth',
    descKey: 'ia.desc_wealth',
    icon: 'M3 7h18v12H3zM3 11h18M7 15h4m5-11l2 3h-4l2-3z',
    keywords: ['portfolio', 'kontostand', 'balance', 'equity', 'geld', 'euro'],
  },
  {
    id: 'agents',
    hash: '#/agenten',
    area: 'agents',
    labelKey: 'ia.page_agents',
    descKey: 'ia.desc_agents',
    icon: 'M12 8a4 4 0 100-8 4 4 0 000 8zm-7 13a7 7 0 0114 0M2 21h20',
    keywords: ['schwarm', 'swarm', 'bots', 'übersicht', 'llm'],
    // Welle E: Agenten-Werkstatt ist ein Tab der Agenten-Seite (eine Seite statt zwei)
    tabs: [
      { id: 'uebersicht', labelKey: 'agents.tabOverview', keywords: ['meine agenten', 'schwarm', 'llm', 'urteile'] },
      { id: 'werkstatt', labelKey: 'ia.page_agentWorkshop', keywords: ['sub-agent', 'agent bauen', 'vorlage', 'template', 'pausieren', 'duplizieren', 'werkstatt'] },
    ],
  },
  {
    id: 'strategies',
    hash: '#/strategien',
    area: 'agents',
    labelKey: 'ia.page_strategies',
    descKey: 'ia.desc_strategies',
    icon: 'M4 6h16M4 12h10M4 18h7m5-3l4 4m0-4l-4 4',
    keywords: ['builder', 'strategie', 'aktivieren', 'promote', 'paper'],
    tabs: [
      { id: 'katalog', labelKey: 'builder.tabCatalog', keywords: ['vorlagen', 'presets', 'konservativ', 'aggressiv', 'galerie'] },
      { id: 'workshop', labelKey: 'builder.tabWorkshop', keywords: ['workshop', 'dsl', 'chat', 'ki', 'claude', 'entwurf', 'versionen', 'eigene strategie'] },
      { id: 'builtin', labelKey: 'builder.tabBuiltin', keywords: ['eingebaut', 'dsl'] },
      { id: 'pine', labelKey: 'builder.tabPine', keywords: ['pine', 'tradingview', 'pinescript', 'import'] },
    ],
  },
  {
    id: 'lab',
    advanced: true,
    hash: '#/labor',
    area: 'agents',
    labelKey: 'ia.page_lab',
    descKey: 'ia.desc_lab',
    icon: 'M9 3v6l-5 9a2 2 0 002 3h12a2 2 0 002-3l-5-9V3M7 3h10',
    keywords: ['backtest', 'walk-forward', 'kalibrieren', 'vergleich', 'mfe', 'mae', 'optimierung', 'vorschlag', 'optimierungs-vorschläge', 'proposal'],
  },
  {
    id: 'aiModels',
    advanced: true,
    hash: '#/intelligenz',
    area: 'agents',
    labelKey: 'ia.page_aiModels',
    descKey: 'ia.desc_aiModels',
    icon: 'M4 20V10l4-6h8l4 6v10M9 20v-6h6v6M2 10h20M12 4v6',
    keywords: ['intelligenz', 'ki', 'ai', 'machine learning'],
    tabs: [
      { id: 'ml', labelKey: 'hub.tab_ml', keywords: ['labels', 'random forest', 'modell'] },
      { id: 'rl', labelKey: 'hub.tab_rl', keywords: ['reinforcement', 'ppo', 'episode', 'portfolio-gewichte'] },
      { id: 'performance', labelKey: 'hub.tab_performance', keywords: ['sharpe', 'drawdown', 'equity'] },
      { id: 'posttrade', labelKey: 'hub.tab_posttrade', keywords: ['lernen', 'review', 'fehler', 'learning'] },
    ],
  },
  {
    id: 'settings',
    hash: '#/einstellungen',
    area: 'system',
    labelKey: 'ia.page_settings',
    descKey: 'ia.desc_settings',
    icon: 'M12 15a3 3 0 100-6 3 3 0 000 6zm8-3l2-1-2-4-2.2.7a8 8 0 00-1.5-.9L16 4h-4l-.3 2.8a8 8 0 00-1.5.9L8 7 6 11l2 1v0l-2 1 2 4 2.2-.7c.5.4 1 .7 1.5.9L12 20h4l.3-2.8c.5-.2 1-.5 1.5-.9L20 17l2-4z',
    keywords: ['config', 'konfiguration', 'optionen'],
    tabs: [
      { id: 'risiko', labelKey: 'ia.tab_settingsRisk', keywords: ['hebel', 'leverage', 'verlustlimit', 'drawdown', 'exposure', 'gates'] },
      { id: 'boersen', labelKey: 'ia.tab_settingsExchanges', keywords: ['binance', 'bybit', 'kraken', 'exchange', 'börse verbinden', 'ccxt'] },
      { id: 'keys', labelKey: 'ia.tab_settingsKeys', keywords: ['api key', 'secret', 'anthropic', 'telegram', 'fred', 'neustart'] },
      { id: 'daten', labelKey: 'ia.tab_settingsData', keywords: ['twelve data', 'aktien', 'stocks', 'import', 'kerzen laden'] },
    ],
  },
  {
    id: 'profile',
    hash: '#/profil',
    area: 'system',
    labelKey: 'ia.page_profile',
    descKey: 'ia.desc_profile',
    icon: 'M12 12a4 4 0 100-8 4 4 0 000 8zm-8 9a8 8 0 0116 0',
    keywords: ['sprache', 'language', 'konto', 'abmelden', 'logout'],
  },
  {
    id: 'protocol',
    advanced: true,
    hash: '#/protokoll',
    area: 'system',
    labelKey: 'ia.page_protocol',
    descKey: 'ia.desc_protocol',
    icon: 'M9 4h6l1 2h3v15H5V6h3l1-2zm-1 7h8m-8 4h8m-8 4h5',
    keywords: ['audit', 'log', 'protokoll', 'verlauf', 'wer hat', 'risk check', 'sicherheit', 'login'],
  },
  {
    id: 'sitemap',
    hash: '#/funktionen',
    area: 'system',
    labelKey: 'ia.page_sitemap',
    descKey: 'ia.desc_sitemap',
    icon: 'M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z',
    keywords: ['hilfe', 'help', 'sitemap', 'wo finde ich', 'übersicht', 'alle seiten'],
  },
] as const satisfies readonly NavPage[];

/** Breiter Typ für Iteration (Tabs/Keywords optional). */
export const NAV_PAGES: readonly NavPage[] = PAGES;

/**
 * Segmentleiste eines Bereichs (Welle F): im Einfach-Modus stehen „advanced"-Seiten
 * hinter „Mehr" — außer der gerade aktiven, die bleibt sichtbar. Profi zeigt alles.
 */
export function subnavPages(area: AreaId, mode: 'einfach' | 'profi', activeHash: string): { shown: NavPage[]; more: NavPage[] } {
  const pages = NAV_PAGES.filter((p) => p.area === area);
  if (mode === 'profi') return { shown: pages, more: [] };
  return {
    shown: pages.filter((p) => !p.advanced || p.hash === activeHash),
    more: pages.filter((p) => p.advanced && p.hash !== activeHash),
  };
}

/**
 * Seitenleiste (Desktop) wie in v2: jeder Bereich als Gruppe mit ALLEN seinen Seiten als
 * Direktlink — jede Seite mit einem Klick (Patrick 2026-10-24: v2 war näher an dem, was er will).
 * Im Einfach-Modus fehlen die Profi-Seiten (außer der aktiven); `hidden` zählt sie für den
 * Hinweis „n weitere im Profi-Modus“, damit nichts unbemerkt verschwindet.
 */
export function sidebarGroups(mode: 'einfach' | 'profi', activeHash: string): { area: NavArea; pages: NavPage[]; hidden: number }[] {
  return AREAS.map((area) => {
    const { shown, more } = subnavPages(area.id, mode, activeHash);
    return { area, pages: shown, hidden: more.length };
  });
}

export type PageHash = (typeof PAGES)[number]['hash'];
export type PageId = (typeof PAGES)[number]['id'];

export function findPage(id: PageId): NavPage {
  return NAV_PAGES.find((p) => p.id === id)!;
}

/** Seite zu einem Location-Hash (Query wird ignoriert); unbekannt → null. */
export function pageForHash(hash: string): NavPage | null {
  const clean = hash.split('?')[0] || '#/';
  const normalized = clean === '#' ? '#/' : clean;
  return NAV_PAGES.find((p) => p.hash === normalized) ?? null;
}

/** Aktiver Tab aus `?tab=` (nur wenn die Seite ihn kennt). */
export function tabForHash(page: NavPage, hash: string): NavTab | null {
  const q = hash.indexOf('?');
  if (q < 0 || !page.tabs) return null;
  const id = new URLSearchParams(hash.slice(q + 1)).get('tab');
  return page.tabs.find((x) => x.id === id) ?? null;
}

/**
 * Alte Links → neuer Ort. Reihenfolge zählt: spezifische (mit Tab) zuerst.
 * `tab: null` = gilt unabhängig vom Tab.
 */
const REDIRECTS: { from: string; tab: string | null; to: string; keepQuery?: boolean }[] = [
  // Welle 3: Konten unter #/traden — alte Seiten (auch aus Benachrichtigungen) bleiben gültig
  // Welle 5: Strategie-Workshop ist ein Tab unter Strategien
  { from: '#/strategie-workshop', tab: null, to: '#/strategien?tab=workshop' },
  // Welle E: Agenten-Werkstatt lebt als Tab unter Agenten
  { from: '#/werkstatt', tab: null, to: '#/agenten?tab=werkstatt' },
  { from: '#/demo', tab: null, to: '#/traden?tab=demo' },
  { from: '#/wallet', tab: null, to: '#/traden?tab=wallet' },
  { from: '#/trading', tab: null, to: '#/traden?tab=positionen', keepQuery: true },
  { from: '#/oracle', tab: null, to: '#/marktlage?tab=makro' },
  { from: '#/aegis', tab: null, to: '#/marktlage?tab=risiko' },
  { from: '#/ml', tab: null, to: '#/intelligenz?tab=ml' },
  { from: '#/rl-agenten', tab: null, to: '#/intelligenz?tab=rl' },
  { from: '#/performance', tab: null, to: '#/intelligenz?tab=performance' },
  // Entscheidungslogik ist Marktlage (Makro/CPI/COT), kein KI-Modell.
  { from: '#/intelligenz', tab: 'intel', to: '#/marktlage?tab=entscheidung' },
  // #/charts?tab=makro|risiko wird NICHT mehr umgeleitet: Makro/Risiko sind wieder Tabs der Chart-Seite (wie v2).
];

export function resolveRedirect(hash: string): string | null {
  const [path = '', query = ''] = hash.split('?');
  const tab = new URLSearchParams(query).get('tab');
  const hit = REDIRECTS.find((r) => r.from === path && (r.tab === null || r.tab === tab));
  if (!hit) return null;
  if (!hit.keepQuery || !query) return hit.to;
  // übrige Parameter (z. B. der Unter-Tab) mitnehmen; Werte aus dem Link schlagen den Standard
  const [toPath, toQuery = ''] = hit.to.split('?');
  const merged = new URLSearchParams(toQuery);
  for (const [k, v] of new URLSearchParams(query)) merged.set(k, v);
  return `${toPath}?${merged.toString()}`;
}

// ── Suche ──────────────────────────────────────────────────────────────────

export type NavEntry = {
  kind: 'page' | 'tab';
  hash: string;
  /** Anzeigename, bei Tabs „Seite › Tab". */
  label: string;
  description: string;
  area: string;
  /** Normalisierter Suchtext (Label, Beschreibung, Bereich, Begriffe). */
  haystack: string;
  /** Normalisiertes Label (für Ranking). */
  title: string;
};

/** Kleinschreibung + Umlaute/Akzente weg, damit „vermogen" „Vermögen" findet. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Alle Seiten + Tabs als durchsuchbare Einträge (Labels übersetzt). */
export function navEntries(t: (key: string) => string): NavEntry[] {
  const out: NavEntry[] = [];
  for (const p of NAV_PAGES) {
    const area = t(AREAS.find((a) => a.id === p.area)!.labelKey);
    const label = t(p.labelKey);
    const description = t(p.descKey);
    const kw = (p.keywords ?? []).join(' ');
    out.push({
      kind: 'page',
      hash: p.hash,
      label,
      description,
      area,
      title: normalize(label),
      haystack: normalize(`${label} ${description} ${area} ${kw}`),
    });
    for (const tab of p.tabs ?? []) {
      const tabLabel = t(tab.labelKey);
      out.push({
        kind: 'tab',
        hash: `${p.hash}?tab=${tab.id}`,
        label: `${label} › ${tabLabel}`,
        description,
        area,
        title: normalize(tabLabel),
        haystack: normalize(`${tabLabel} ${label} ${(tab.keywords ?? []).join(' ')}`),
      });
    }
  }
  return out;
}

/**
 * Rangfolge: Titel beginnt mit Suche < Titel enthält < Suchbegriff/Text enthält.
 * Mehrere Wörter: jedes muss vorkommen. Bei Gleichstand gewinnt die Seite vor
 * dem Tab, sonst Sidebar-Reihenfolge.
 */
export function searchNav(entries: NavEntry[], query: string, limit = 8): NavEntry[] {
  const q = normalize(query.trim());
  if (q === '') return entries.filter((e) => e.kind === 'page').slice(0, limit);
  const words = q.split(/\s+/);
  const scored: { e: NavEntry; s: number; i: number }[] = [];
  entries.forEach((e, i) => {
    if (!words.every((w) => e.haystack.includes(w) || e.title.includes(w))) return;
    let s = 3;
    if (e.title.startsWith(q)) s = 0;
    else if (e.title.includes(q)) s = 1;
    else if (words.some((w) => e.title.includes(w))) s = 2;
    // Exakter Suchbegriff-Treffer (z. B. „pine") schlägt bloßes Vorkommen im Fließtext.
    if (s === 3 && new RegExp(`(^|\\s)${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(e.haystack)) s = 2.5;
    scored.push({ e, s: s + (e.kind === 'tab' ? 0.1 : 0), i });
  });
  return scored
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.e);
}
