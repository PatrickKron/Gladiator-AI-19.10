import { z } from 'zod';
import { detectStructure } from './structure.js';
import type { Candle } from './types.js';

/**
 * Szenario-Playbooks / Wenn-Dann-Wetten (Welle 24).
 *
 * Rein & deterministisch:
 * - Zod-Schemas für Auslöser (News-Keywords, Makro-Events, VIX/GRS, Manuell),
 *   technische Bestätigung (BOS/CHoCH/Kursbruch auf echten Kerzen via `detectStructure`)
 *   und Aktions-Pläne (Asset/Asset-Gruppe long/short mit Hebel, Spot-/Wallet-Bestand
 *   verkaufen, Portfolio-Hedging hochfahren).
 * - Deterministischer Freitext-Parser (`parseScenarioFromText`) für deutsche & englische
 *   Szenario-Beschreibungen inkl. ehrlicher Machbarkeits- & Sicherheitsprüfung.
 * - Look-ahead-freie Auswertungsfunktionen gegen echte News, Kalender-Events, Makrodaten
 *   und abgeschlossene OHLCV-Kerzen.
 */

export const SCENARIO_STATUSES = ['draft', 'armed', 'triggered', 'executed', 'paused'] as const;
export type ScenarioStatus = (typeof SCENARIO_STATUSES)[number];

export const SCENARIO_EXECUTION_MODES = ['signal_only', 'demo_auto'] as const;
export type ScenarioExecutionMode = (typeof SCENARIO_EXECUTION_MODES)[number];

export const SCENARIO_CONFIRMATION_KINDS = [
  'none',
  'bos_down',
  'bos_up',
  'choch_down',
  'choch_up',
  'price_below',
  'price_above',
] as const;
export type ScenarioConfirmationKind = (typeof SCENARIO_CONFIRMATION_KINDS)[number];

export const SCENARIO_TARGET_SCOPES = ['symbol', 'all_crypto', 'top_crypto', 'all_stocks'] as const;
export type ScenarioTargetScope = (typeof SCENARIO_TARGET_SCOPES)[number];

export const SCENARIO_EVENT_CATEGORIES = [
  'any',
  'inflation',
  'central_bank',
  'labor',
  'growth_pmi',
] as const;
export type ScenarioEventCategory = (typeof SCENARIO_EVENT_CATEGORIES)[number];

export const scenarioTriggerSchema = z.object({
  /** Auslöser-Typ: News-Schlagwörter, Makro/VIX/GRS, Kalender-Event oder rein manuell. */
  kind: z.enum(['news_keywords', 'macro_threshold', 'calendar_event', 'manual_only']).default('news_keywords'),
  /** Schlagwörter für echten RSS-/News-Abgleich (case-insensitive). */
  keywords: z.array(z.string().trim().min(2).max(60)).max(20).default([]),
  /** Mindestanzahl passender News-Meldungen im Zeitfenster (verhindert Einzelfehlalarm). */
  minKeywordHits: z.number().int().min(1).max(10).default(1),
  /** Rückblick-Fenster in Stunden für News-Abgleich. */
  lookbackHours: z.number().int().min(1).max(168).default(24),
  /** Optionale Makro-Schwellen (echte `macro_series` / GRS). */
  vixMin: z.number().min(10).max(120).optional(),
  grsMax: z.number().min(-100).max(100).optional(),
  grsMin: z.number().min(-100).max(100).optional(),
  /** Optionale Kalender-Event-Kategorie (±12 h). */
  eventCategory: z.enum(SCENARIO_EVENT_CATEGORIES).optional(),
});

export type ScenarioTrigger = z.infer<typeof scenarioTriggerSchema>;

export const scenarioConfirmationSchema = z.object({
  kind: z.enum(SCENARIO_CONFIRMATION_KINDS).default('none'),
  /** Referenz-Asset für BOS/CHoCH/Kursbruch (z. B. 'BTC/USDT'); leer ⇒ erstes Ziel-Asset. */
  symbol: z.string().trim().min(1).max(30).optional(),
  timeframe: z.enum(['15m', '1h', '4h', '1d']).default('1h'),
  /** Wie viele der letzten geschlossenen Kerzen für einen frischen BOS/CHoCH gelten. */
  lookbackBars: z.number().int().min(1).max(24).default(6),
  /** Zielpreis für `price_below` / `price_above`. */
  priceLevel: z.number().positive().optional(),
});

export type ScenarioConfirmation = z.infer<typeof scenarioConfirmationSchema>;

export const scenarioTradeActionSchema = z.object({
  type: z.literal('trade'),
  targetScope: z.enum(SCENARIO_TARGET_SCOPES).default('symbol'),
  /** Konkrete Symbole bei `targetScope === 'symbol'` (z. B. ['BTC/USDT', 'ETH/USDT']). */
  symbols: z.array(z.string().trim().min(1).max(30)).max(25).default([]),
  direction: z.enum(['long', 'short']),
  /** Gewünschter Hebel — wird im Ausführungsfall IMMER vom Risk-Gate `maxLeverage` gedeckelt. */
  leverage: z.number().min(1).max(25).default(3),
  /** Risiko pro Position in % vom Konto. */
  riskPct: z.number().min(0.25).max(5).default(1),
  /** Stop-Loss-Abstand in % (für sofortige Schutz-Order). */
  stopLossPct: z.number().min(0.5).max(25).default(3),
  /** Take-Profit-Abstand in % (Basis für TP1/TP2/TP3). */
  takeProfitPct: z.number().min(1).max(100).default(9),
});

export const scenarioSellSpotActionSchema = z.object({
  type: z.literal('sell_spot_holdings'),
  /** Verbindungs-ID aus `exchange_connections` (optional). */
  connectionId: z.string().uuid().optional(),
  /** Frei benannte Börse/Wallet (z. B. 'binance', 'kraken', 'wallet', 'all'). */
  venueHint: z.string().trim().min(1).max(60).default('all'),
  /** Zu verkaufende Assets (['ALL'] für gesamten Spot-Bestand). */
  assets: z.array(z.string().trim().min(1).max(20)).max(25).default(['ALL']),
  /** Anteil des Bestands in % (z. B. 50 oder 100). */
  sellPct: z.number().min(1).max(100).default(100),
});

export const scenarioActivateHedgeActionSchema = z.object({
  type: z.literal('activate_hedge'),
  hedgeRatioPct: z.number().min(10).max(100).default(75),
});

export const scenarioActionSchema = z.discriminatedUnion('type', [
  scenarioTradeActionSchema,
  scenarioSellSpotActionSchema,
  scenarioActivateHedgeActionSchema,
]);

export type ScenarioAction = z.infer<typeof scenarioActionSchema>;

export const scenarioPlaybookSpecSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(600).optional(),
  rawText: z.string().trim().max(2000).optional(),
  executionMode: z.enum(SCENARIO_EXECUTION_MODES).default('signal_only'),
  trigger: scenarioTriggerSchema,
  confirmation: scenarioConfirmationSchema,
  actions: z.array(scenarioActionSchema).min(1).max(10),
});

export type ScenarioPlaybookSpec = z.infer<typeof scenarioPlaybookSpecSchema>;

export type ScenarioFeasibility = {
  verdict: 'feasible' | 'partial';
  checks: Array<{ ok: boolean; label: string; detail: string }>;
  notes: string[];
};

export type ParsedScenarioResult = {
  spec: ScenarioPlaybookSpec;
  detectedTheme: string;
  feasibility: ScenarioFeasibility;
};

type ThemeDef = {
  id: string;
  label: string;
  match: RegExp;
  keywords: string[];
  vixMin?: number;
  grsMax?: number;
  defaultDirection: 'short' | 'long';
  defaultConfirmation: ScenarioConfirmationKind;
};

const SCENARIO_THEMES: ThemeDef[] = [
  {
    id: 'pandemic',
    label: 'Pandemie / Gesundheitskrise',
    match: /(?:^|[\s(,])(pandemi\w*|seuche|virus|lockdown|who\s*notstand|covid|epidemie)/i,
    keywords: ['pandemic', 'pandemie', 'lockdown', 'who emergency', 'outbreak', 'virus'],
    vixMin: 30,
    defaultDirection: 'short',
    defaultConfirmation: 'bos_down',
  },
  {
    id: 'war_geopolitics',
    label: 'Krieg / Geopolitische Eskalation',
    match: /(?:^|[\s(,])(krieg|war|eskalation|angriff|invasion|sanktion|nahost|taiwan)/i,
    keywords: ['war', 'krieg', 'escalation', 'invasion', 'airstrike', 'sanctions', 'conflict'],
    vixMin: 28,
    defaultDirection: 'short',
    defaultConfirmation: 'bos_down',
  },
  {
    id: 'bank_crisis',
    label: 'Bankenkrise / Liquiditätsschock',
    match: /(?:^|[\s(,])(bankenkrise|bank\s*run|insolvenz|pleite|lehman|kreditkrise|liquidit[äa]t)/i,
    keywords: ['bank run', 'bank failure', 'insolvency', 'bankenkrise', 'bailout', 'liquidity crisis'],
    vixMin: 30,
    defaultDirection: 'short',
    defaultConfirmation: 'bos_down',
  },
  {
    id: 'etf_bullish',
    label: 'ETF-Zulassung / Bullische Adoption',
    match: /(?:^|[\s(,])(etf\s*genehm|etf\s*approv|spot\s*etf|sec\s*approv|zinssenkung|rate\s*cut|stimul)/i,
    keywords: ['etf approved', 'sec approves', 'rate cut', 'zinssenkung', 'stimulus'],
    defaultDirection: 'long',
    defaultConfirmation: 'bos_up',
  },
  {
    id: 'inflation_rates',
    label: 'Inflations- / Zinsschock',
    match: /(?:^|[\s(,])(inflation|cpi|fomc|zinsanhebung|zinserh[öo]hung|rate\s*hike|hawkish)/i,
    keywords: ['cpi', 'inflation surge', 'rate hike', 'fomc', 'hawkish', 'zinserhöhung'],
    defaultDirection: 'short',
    defaultConfirmation: 'bos_down',
  },
  {
    id: 'hack_exploit',
    label: 'Börsen-Hack / Depeg / Exploit',
    match: /(?:^|[\s(,])(hack|exploit|depeg|tether|usdt\s*crash|b[öo]rsenpleite)/i,
    keywords: ['exchange hack', 'depeg', 'exploit', 'insolvent', 'withdrawals halted'],
    defaultDirection: 'short',
    defaultConfirmation: 'bos_down',
  },
  {
    id: 'recession_crash',
    label: 'Rezession / Crash / Black Swan',
    match: /(?:^|[\s(,])(rezession|recession|black\s*swan|crash|marktcrash|panik|panic)/i,
    keywords: ['recession', 'rezession', 'market crash', 'selloff', 'panic', 'black swan'],
    vixMin: 32,
    defaultDirection: 'short',
    defaultConfirmation: 'bos_down',
  },
];

const KNOWN_SYMBOL_PATTERNS: Array<{ re: RegExp; symbol: string }> = [
  { re: /(?:^|[\s(,])(btc|bitcoin)(?=$|[\s.,)/])/i, symbol: 'BTC/USDT' },
  { re: /(?:^|[\s(,])(eth|ethereum)(?=$|[\s.,)/])/i, symbol: 'ETH/USDT' },
  { re: /(?:^|[\s(,])(sol|solana)(?=$|[\s.,)/])/i, symbol: 'SOL/USDT' },
  { re: /(?:^|[\s(,])(xrp|ripple)(?=$|[\s.,)/])/i, symbol: 'XRP/USDT' },
  { re: /(?:^|[\s(,])(doge|dogecoin)(?=$|[\s.,)/])/i, symbol: 'DOGE/USDT' },
  { re: /(?:^|[\s(,])(nvda|nvidia)(?=$|[\s.,)/])/i, symbol: 'NVDA' },
  { re: /(?:^|[\s(,])(aapl|apple)(?=$|[\s.,)/])/i, symbol: 'AAPL' },
  { re: /(?:^|[\s(,])(tsla|tesla)(?=$|[\s.,)/])/i, symbol: 'TSLA' },
  { re: /(?:^|[\s(,])(spy|s&p\s*500|sp500)(?=$|[\s.,)/])/i, symbol: 'SPY' },
  { re: /(?:^|[\s(,])(qqq|nasdaq)(?=$|[\s.,)/])/i, symbol: 'QQQ' },
  { re: /(?:^|[\s(,])(gold|xau)(?=$|[\s.,)/])/i, symbol: 'XAU/USD' },
];

const VENUE_HINTS: Array<{ re: RegExp; name: string }> = [
  { re: /\bbinance\b/i, name: 'binance' },
  { re: /\bkraken\b/i, name: 'kraken' },
  { re: /\bbybit\b/i, name: 'bybit' },
  { re: /\bokx\b/i, name: 'okx' },
  { re: /\bcoinbase\b/i, name: 'coinbase' },
  { re: /\bbitget\b/i, name: 'bitget' },
  { re: /\bkucoin\b/i, name: 'kucoin' },
  { re: /\bhyperliquid\b/i, name: 'hyperliquid' },
  { re: /\bphantom\b/i, name: 'phantom-wallet' },
  { re: /\bmetamask\b/i, name: 'metamask-wallet' },
  { re: /\bledger\b/i, name: 'ledger-wallet' },
];

/**
 * Deterministischer Freitext-Parser für Wenn-Dann-Szenarien (Welle 24).
 * Beispiel: "Pandemie bricht aus, dann auf BOS nach unten warten, dann 5x alle Cryptos shorten und Bestand auf Binance verkaufen"
 */
export function parseScenarioFromText(raw: string): ParsedScenarioResult {
  const text = raw.trim();
  const theme = SCENARIO_THEMES.find((t) => t.match.test(text));

  // 1) Trigger-Keywords extrahieren
  const customKeywords: string[] = [];
  const quoted = text.match(/["„“'`]([^"„“'`]{2,40})["„“'`]/g) ?? [];
  for (const q of quoted) {
    const clean = q.replace(/^["„“'`]|["„“'`]$/g, '').trim();
    if (clean.length >= 2) customKeywords.push(clean);
  }
  const keywords = [...new Set([...(theme?.keywords ?? []), ...customKeywords])];
  if (keywords.length === 0) {
    // Fallback: erste sinnvolle Inhaltswörter aus dem Bedingungsteil vor "dann"
    const condPart = text.split(/\bdann\b|\bthen\b/i)[0] ?? text;
    const stop = new Set([
      'wenn', 'falls', 'sobald', 'bei', 'ein', 'eine', 'einer', 'der', 'die', 'das', 'aus', 'bricht',
      'auf', 'und', 'oder', 'mit', 'nach', 'warten', 'szenario', 'news', 'wette', 'wenn', 'dann',
    ]);
    const words = condPart
      .replace(/[^a-zA-ZäöüÄÖÜß0-9\s-]/g, ' ')
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 4 && !stop.has(w.toLowerCase()));
    keywords.push(...words.slice(0, 4));
  }

  // VIX-Schwelle optional erkennen (z. B. "VIX > 30" oder "VIX über 28")
  const vixMatch = text.match(/\bvix\s*(?:>=|>|über|ueber|ab)\s*(\d{2}(?:\.\d+)?)/i);
  const vixMin = vixMatch ? Number(vixMatch[1]) : theme?.vixMin;

  // 2) Technische Bestätigung erkennen (BOS / CHoCH / Kurs)
  let confKind: ScenarioConfirmationKind = 'none';
  if (/\bchoch\b/i.test(text)) {
    confKind = /(?:oben|up|bull|long|steig)/i.test(text) ? 'choch_up' : 'choch_down';
  } else if (/\bbos\b|strukturbruch|break\s+of\s+structure/i.test(text)) {
    confKind = /(?:oben|up|bull|hoch)/i.test(text) ? 'bos_up' : 'bos_down';
  } else if (/(?:kurs|preis|price)\s*(?:unter|below|<)\s*(\d+(?:[.,]\d+)?)/i.test(text)) {
    confKind = 'price_below';
  } else if (/(?:kurs|preis|price)\s*(?:über|ueber|above|>)\s*(\d+(?:[.,]\d+)?)/i.test(text)) {
    confKind = 'price_above';
  }

  const tfMatch = text.match(/\b(15m|1h|4h|1d)\b/i);
  const timeframe = (tfMatch ? tfMatch[1]!.toLowerCase() : '1h') as '15m' | '1h' | '4h' | '1d';

  const priceMatch = text.match(/(?:kurs|preis|price)\s*(?:unter|below|<|über|ueber|above|>)\s*(\d+(?:[.,]\d+)?)/i);
  const priceLevel = priceMatch ? Number(priceMatch[1]!.replace(',', '.')) : undefined;

  // 3) Ziel-Assets, Richtung & Hebel erkennen
  const explicitSymbols: string[] = [];
  for (const p of KNOWN_SYMBOL_PATTERNS) {
    if (p.re.test(text) && !explicitSymbols.includes(p.symbol)) explicitSymbols.push(p.symbol);
  }
  const pairMatches = text.match(/\b[A-Z]{2,8}\/(?:USDT|USDC|USD)\b/g) ?? [];
  for (const pair of pairMatches) {
    if (!explicitSymbols.includes(pair)) explicitSymbols.push(pair);
  }

  const wantsAllCrypto = /(?:alle\s+(?:cryptos?|kryptos?|coins?)|all\s+crypto)/i.test(text);
  const wantsTopCrypto = /(?:top\s*(?:3|5)?\s*(?:cryptos?|kryptos?)|major\s+crypto)/i.test(text);
  const wantsAllStocks = /(?:alle\s+(?:aktien|stocks?)|all\s+stocks?)/i.test(text);

  const wantsShort = /(?:shorten|short\b|leerverkauf|auf\s+fallend)/i.test(text);
  const wantsLong = /(?:long\b|kaufen|buy\b|einsteigen|auf\s+steigend)/i.test(text);
  const direction: 'short' | 'long' = wantsShort ? 'short' : wantsLong ? 'long' : (theme?.defaultDirection ?? 'short');

  const levMatch =
    text.match(/(?:hebel|leverage|lev)\s*(?:von\s*)?(\d{1,2})\s*x?/i) ??
    text.match(/\b(\d{1,2})\s*x\b/i);
  const rawLeverage = levMatch ? Number(levMatch[1]) : 3;
  const leverage = Math.min(25, Math.max(1, Number.isFinite(rawLeverage) ? rawLeverage : 3));

  const riskMatch = text.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:risiko|risk)/i);
  const riskPct = riskMatch ? Math.min(5, Math.max(0.25, Number(riskMatch[1]!.replace(',', '.')))) : 1;

  const actions: ScenarioAction[] = [];

  // Trade-Aktion anlegen, wenn Richtung/Scope/Hebel oder kein reiner Spot-Verkauf
  const wantsSpotSell =
    /(?:bestand|wallet|spot|portfolio|coins?|positionen?)\s*(?:(?:auf|von|aus|in)\s+(?:[a-zäöüß0-9_-]+\s+){1,4})?(?:verkaufen|absto[ßs]en|liquidieren|glattstellen|sell)/i.test(text) ||
    /(?:verkaufen|liquidieren|absto[ßs]en)\s*(?:auf|von|aus)\s*(?:[a-zäöüß0-9_-]+\s+){0,2}(?:wallet|binance|kraken|bybit|okx|coinbase|b[öo]rse)/i.test(text);

  const wantsHedge = /(?:hedg\w*|absicher\w*)/i.test(text);

  if (wantsShort || wantsLong || wantsAllCrypto || wantsTopCrypto || wantsAllStocks || explicitSymbols.length > 0 || !wantsSpotSell) {
    const targetScope: ScenarioTargetScope = wantsAllCrypto
      ? 'all_crypto'
      : wantsTopCrypto
        ? 'top_crypto'
        : wantsAllStocks
          ? 'all_stocks'
          : 'symbol';

    actions.push({
      type: 'trade',
      targetScope,
      symbols: targetScope === 'symbol' ? (explicitSymbols.length > 0 ? explicitSymbols : ['BTC/USDT']) : [],
      direction,
      leverage,
      riskPct,
      stopLossPct: 3,
      takeProfitPct: 9,
    });
  }

  if (wantsSpotSell) {
    const venueHit = VENUE_HINTS.find((v) => v.re.test(text));
    const customWalletMatch = text.match(/wallet\s+([a-zA-Z0-9_-]{2,24})/i);
    const venueHint = venueHit
      ? venueHit.name
      : customWalletMatch && !['verkaufen', 'abstoßen', 'liquidieren'].includes(customWalletMatch[1]!.toLowerCase())
        ? `wallet:${customWalletMatch[1]!}`
        : 'all';
    const pctMatch = text.match(/(\d{1,3})\s*%\s*(?:bestand|spot|wallet|verkaufen)/i);
    const sellPct = pctMatch ? Math.min(100, Math.max(1, Number(pctMatch[1]))) : 100;

    actions.push({
      type: 'sell_spot_holdings',
      venueHint,
      assets: ['ALL'],
      sellPct,
    });
  }

  if (wantsHedge) {
    const ratioMatch = text.match(/(\d{1,3})\s*%\s*(?:hedg|absicher)/i);
    actions.push({
      type: 'activate_hedge',
      hedgeRatioPct: ratioMatch ? Math.min(100, Math.max(10, Number(ratioMatch[1]))) : 75,
    });
  }

  const name = theme
    ? `${theme.label} → ${direction === 'short' ? 'Short' : 'Long'}${wantsSpotSell ? ' + Spot-Verkauf' : ''}`
    : `Szenario: ${(keywords[0] ?? 'Individuell').slice(0, 32)} → ${direction === 'short' ? 'Short' : 'Long'}`;

  // 4) Ehrliche Machbarkeits- & Sicherheitsprüfung
  const checks: ScenarioFeasibility['checks'] = [
    {
      ok: keywords.length > 0 || vixMin !== undefined,
      label: 'Auslöser-Überwachung (echte News & Makro)',
      detail:
        keywords.length > 0
          ? `Überwacht echte RSS-News alle 5 Min. auf: ${keywords.slice(0, 6).join(', ')}${vixMin ? ` (oder VIX ≥ ${vixMin})` : ''}. Zusätzlich jederzeit 1-Klick-Sofortauslöser.`
          : 'Reiner Hand-Auslöser (kann jederzeit mit 1 Klick gestartet werden).',
    },
    {
      ok: true,
      label: 'Technische Bestätigung (echte Marktstruktur)',
      detail:
        confKind === 'none'
          ? 'Sofortige Auslösung ohne zusätzlichen Chart-Filter.'
          : `Prüft echte geschlossene ${timeframe}-Kerzen look-ahead-frei auf ${confKind.toUpperCase()} (SMC-Struktur).`,
    },
    {
      ok: true,
      label: 'Trading-Aktion & Risk-Engine-Gate',
      detail: `Standardmäßig Paper/Signale (Mensch im Loop) oder Demo-Auto. Gewünschter Hebel (${leverage}x) wird immer durch dein Risk-Limit (maxLeverage) gedeckelt.`,
    },
  ];

  const notes: string[] = [];
  if (wantsSpotSell) {
    checks.push({
      ok: false,
      label: 'Spot-/Wallet-Bestand verkaufen (Transparenz-Hinweis)',
      detail:
        'Verbundene Börsen (API mit Trading-Recht) erzeugen einen bestätigungspflichtigen Verkaufsplan; reine Read-Only-Wallets (öffentliche Adresse ohne Private Key) lösen einen dringenden Alarm + Verkaufs-Checkliste aus (nie Fake-Signatur, nie Auszahlungen/Transfers).',
    });
    notes.push(
      'Aus Sicherheitsgründen (keine Auszahlungen, keine blinden Live-Verkäufe, keine Private Keys auf dem Server) werden Wallet-Verkäufe als sofortige Bestätigungs-/Alarm-Checkliste ausgegeben.',
    );
  }
  if (leverage > 10) {
    notes.push(`Hinweis: Hebel ${leverage}x liegt über dem Standard-Risk-Limit (10x) und wird automatisch auf dein eingestelltes maxLeverage gekappt.`);
  }

  const spec: ScenarioPlaybookSpec = {
    name,
    description: text.slice(0, 500),
    rawText: text.slice(0, 2000),
    executionMode: 'signal_only',
    trigger: {
      kind: keywords.length > 0 ? 'news_keywords' : vixMin ? 'macro_threshold' : 'manual_only',
      keywords,
      minKeywordHits: 1,
      lookbackHours: 24,
      ...(vixMin !== undefined ? { vixMin } : {}),
    },
    confirmation: {
      kind: confKind,
      symbol: explicitSymbols[0] ?? 'BTC/USDT',
      timeframe,
      lookbackBars: 6,
      ...(priceLevel !== undefined ? { priceLevel } : {}),
    },
    actions,
  };

  return {
    spec,
    detectedTheme: theme?.label ?? 'Individuelles Szenario',
    feasibility: {
      verdict: checks.every((c) => c.ok) ? 'feasible' : 'partial',
      checks,
      notes,
    },
  };
}

/** Kuratierte Schnell-Vorlagen (1 Klick füllt das Szenario-Formular). */
export const SCENARIO_TEMPLATES: Array<{ id: string; badge: string; sampleText: string; spec: ScenarioPlaybookSpec }> = [
  {
    id: 'pandemic-crash',
    badge: '🦠 Black Swan / Pandemie',
    sampleText:
      'Pandemie bricht aus, dann auf BOS nach unten auf 1h warten, dann mit 5x Hebel alle Cryptos shorten und 100% Bestand auf Binance verkaufen',
    spec: parseScenarioFromText(
      'Pandemie bricht aus, dann auf BOS nach unten auf 1h warten, dann mit 5x Hebel alle Cryptos shorten und 100% Bestand auf Binance verkaufen',
    ).spec,
  },
  {
    id: 'bank-crisis',
    badge: '🏦 Bankenkrise / Risk-Off',
    sampleText:
      'Bankenkrise oder VIX > 30, dann auf BOS nach unten auf 4h warten, dann mit 3x Hebel Top Cryptos shorten und Hedging auf 80% aktivieren',
    spec: parseScenarioFromText(
      'Bankenkrise oder VIX > 30, dann auf BOS nach unten auf 4h warten, dann mit 3x Hebel Top Cryptos shorten und Hedging auf 80% aktivieren',
    ).spec,
  },
  {
    id: 'etf-breakout',
    badge: '🚀 ETF-Zulassung / News-Long',
    sampleText:
      'Spot ETF genehmigt oder Zinssenkung, dann auf BOS nach oben auf 1h warten, dann mit 4x Hebel BTC/USDT und ETH/USDT long kaufen',
    spec: parseScenarioFromText(
      'Spot ETF genehmigt oder Zinssenkung, dann auf BOS nach oben auf 1h warten, dann mit 4x Hebel BTC/USDT und ETH/USDT long kaufen',
    ).spec,
  },
  {
    id: 'inflation-shock',
    badge: '🔥 CPI-/Zins-Schock',
    sampleText:
      'Inflation oder Zinserhöhung, dann auf CHoCH nach unten auf 15m warten, dann mit 3x Hebel BTC/USDT und QQQ shorten',
    spec: parseScenarioFromText(
      'Inflation oder Zinserhöhung, dann auf CHoCH nach unten auf 15m warten, dann mit 3x Hebel BTC/USDT und QQQ shorten',
    ).spec,
  },
];

export type TriggerNewsInput = {
  title: string;
  summary: string | null;
  source: string;
  url: string;
  publishedAt: Date;
};

export type TriggerEvalContext = {
  now: Date;
  news: readonly TriggerNewsInput[];
  vix: number | null;
  grs: number | null;
  upcomingEventTitles?: readonly string[];
};

export type TriggerEvalResult = {
  matched: boolean;
  reason: string;
  matchedHeadlines: Array<{ title: string; source: string; url: string; publishedAt: string; keyword: string }>;
  vix: number | null;
  grs: number | null;
};

/**
 * Pure: prüft den Szenario-Auslöser gegen echte News-Meldungen & Makro-Werte (VIX/GRS).
 */
export function evaluateScenarioTrigger(trigger: ScenarioTrigger, ctx: TriggerEvalContext): TriggerEvalResult {
  const cutoffMs = ctx.now.getTime() - trigger.lookbackHours * 3_600_000;
  const matchedHeadlines: TriggerEvalResult['matchedHeadlines'] = [];

  if (trigger.keywords.length > 0) {
    const lowerKws = trigger.keywords.map((k) => k.toLowerCase());
    for (const item of ctx.news) {
      if (item.publishedAt.getTime() < cutoffMs) continue;
      const hay = `${item.title} ${item.summary ?? ''}`.toLowerCase();
      const hitKw = lowerKws.find((kw) => hay.includes(kw));
      if (hitKw) {
        matchedHeadlines.push({
          title: item.title,
          source: item.source,
          url: item.url,
          publishedAt: item.publishedAt.toISOString(),
          keyword: hitKw,
        });
      }
    }
  }

  const newsMatched = trigger.keywords.length > 0 && matchedHeadlines.length >= trigger.minKeywordHits;
  const vixMatched = trigger.vixMin !== undefined && ctx.vix !== null && ctx.vix >= trigger.vixMin;
  const grsMaxMatched = trigger.grsMax !== undefined && ctx.grs !== null && ctx.grs <= trigger.grsMax;
  const grsMinMatched = trigger.grsMin !== undefined && ctx.grs !== null && ctx.grs >= trigger.grsMin;

  if (trigger.kind === 'manual_only') {
    return {
      matched: false,
      reason: 'Reiner Hand-Auslöser — wartet auf deinen Klick „Manuell auslösen“.',
      matchedHeadlines: [],
      vix: ctx.vix,
      grs: ctx.grs,
    };
  }

  const matched = newsMatched || vixMatched || grsMaxMatched || grsMinMatched;
  const parts: string[] = [];
  if (newsMatched) parts.push(`${matchedHeadlines.length} passende News-Meldung(en) im ${trigger.lookbackHours}h-Fenster`);
  if (vixMatched) parts.push(`VIX ${ctx.vix!.toFixed(1)} ≥ ${trigger.vixMin}`);
  if (grsMaxMatched) parts.push(`GRS ${ctx.grs!.toFixed(0)} ≤ ${trigger.grsMax}`);
  if (grsMinMatched) parts.push(`GRS ${ctx.grs!.toFixed(0)} ≥ ${trigger.grsMin}`);

  if (!matched) {
    const waitParts: string[] = [];
    if (trigger.keywords.length > 0) {
      waitParts.push(`News-Treffer: ${matchedHeadlines.length}/${trigger.minKeywordHits} (${trigger.keywords.slice(0, 4).join(', ')})`);
    }
    if (trigger.vixMin !== undefined) {
      waitParts.push(`VIX: ${ctx.vix === null ? 'n/v' : ctx.vix.toFixed(1)} (Ziel ≥ ${trigger.vixMin})`);
    }
    if (trigger.grsMax !== undefined) {
      waitParts.push(`GRS: ${ctx.grs === null ? 'n/v' : ctx.grs.toFixed(0)} (Ziel ≤ ${trigger.grsMax})`);
    }
    return {
      matched: false,
      reason: `Szenario noch nicht eingetreten (${waitParts.join(' · ') || 'keine Bedingung erfüllt'}).`,
      matchedHeadlines: matchedHeadlines.slice(0, 5),
      vix: ctx.vix,
      grs: ctx.grs,
    };
  }

  return {
    matched: true,
    reason: `Auslöser aktiv: ${parts.join(' + ')}.`,
    matchedHeadlines: matchedHeadlines.slice(0, 8),
    vix: ctx.vix,
    grs: ctx.grs,
  };
}

export type ConfirmationEvalResult = {
  matched: boolean;
  symbol: string;
  timeframe: string;
  reason: string;
  lastClose: number | null;
  brokenLevel: number | null;
  eventTs: string | null;
};

/**
 * Pure & look-ahead-frei: prüft die technische Bestätigung (BOS/CHoCH/Kurs)
 * auf den letzten abgeschlossenen Kerzen des Referenz-Assets.
 */
export function evaluateScenarioConfirmation(
  confirmation: ScenarioConfirmation,
  candles: readonly Candle[],
  fallbackSymbol = 'BTC/USDT',
): ConfirmationEvalResult {
  const symbol = confirmation.symbol ?? fallbackSymbol;
  const lastCandle = candles.length > 0 ? candles[candles.length - 1]! : null;
  const lastClose = lastCandle ? lastCandle.close : null;

  if (confirmation.kind === 'none') {
    return {
      matched: true,
      symbol,
      timeframe: confirmation.timeframe,
      reason: 'Kein technischer Bestätigungs-Filter konfiguriert (sofort bereit).',
      lastClose,
      brokenLevel: null,
      eventTs: lastCandle ? lastCandle.ts.toISOString() : null,
    };
  }

  if (candles.length < 25) {
    return {
      matched: false,
      symbol,
      timeframe: confirmation.timeframe,
      reason: `Zu wenige Kerzen für ${symbol} (${candles.length} < 25) — warte auf Daten.`,
      lastClose,
      brokenLevel: null,
      eventTs: null,
    };
  }

  if (confirmation.kind === 'price_below' || confirmation.kind === 'price_above') {
    if (!confirmation.priceLevel || lastClose === null) {
      return {
        matched: false,
        symbol,
        timeframe: confirmation.timeframe,
        reason: 'Zielpreis für Kurs-Bestätigung fehlt.',
        lastClose,
        brokenLevel: null,
        eventTs: null,
      };
    }
    const ok =
      confirmation.kind === 'price_below'
        ? lastClose < confirmation.priceLevel
        : lastClose > confirmation.priceLevel;
    return {
      matched: ok,
      symbol,
      timeframe: confirmation.timeframe,
      reason: ok
        ? `${symbol} Schlusskurs ${lastClose} ${confirmation.kind === 'price_below' ? '<' : '>'} ${confirmation.priceLevel} bestätigt.`
        : `Warte auf ${symbol} ${confirmation.kind === 'price_below' ? 'unter' : 'über'} ${confirmation.priceLevel} (aktuell ${lastClose}).`,
      lastClose,
      brokenLevel: confirmation.priceLevel,
      eventTs: lastCandle!.ts.toISOString(),
    };
  }

  // Echte SMC-Strukturerkennung (BOS / CHoCH)
  const events = detectStructure([...candles], { leftBars: 5, rightBars: 5 });
  const minIdx = Math.max(0, candles.length - confirmation.lookbackBars);
  const wantKind = confirmation.kind.startsWith('bos') ? 'BOS' : 'CHoCH';
  const wantDir = confirmation.kind.endsWith('down') ? 'bearish' : 'bullish';

  // Bei "BOS nach unten" akzeptieren wir auch ein frisches bearishes CHoCH (erster Strukturbruch nach unten!),
  // da ein Trendwechsel aus einem Aufwärtstrend heraus technisch als CHoCH startet.
  const hit = [...events]
    .reverse()
    .find(
      (e) =>
        e.index >= minIdx &&
        e.direction === wantDir &&
        (wantKind === 'BOS' ? e.kind === 'BOS' || e.kind === 'CHoCH' : e.kind === 'CHoCH'),
    );

  if (!hit) {
    return {
      matched: false,
      symbol,
      timeframe: confirmation.timeframe,
      reason: `Kein frisches ${wantDir === 'bearish' ? 'bearishes' : 'bullishes'} ${wantKind} auf ${symbol} (${confirmation.timeframe}) in den letzten ${confirmation.lookbackBars} Kerzen.`,
      lastClose,
      brokenLevel: null,
      eventTs: null,
    };
  }

  const bar = candles[hit.index]!;
  return {
    matched: true,
    symbol,
    timeframe: confirmation.timeframe,
    reason: `${hit.kind} (${hit.direction}) auf ${symbol} ${confirmation.timeframe} bestätigt — Level ${hit.brokenLevel.toFixed(2)} durchbrochen.`,
    lastClose,
    brokenLevel: hit.brokenLevel,
    eventTs: bar.ts.toISOString(),
  };
}
