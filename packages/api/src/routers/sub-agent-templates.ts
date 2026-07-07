/**
 * Vorlagen für gängige Sub-Agent-Typen (Trading-Werkstatt). Jede Vorlage ist eine
 * VOLLSTÄNDIGE, valide Definition (subAgentSpecSchema) — die UI lädt sie ins
 * Formular, der Nutzer passt an und schaltet bewusst scharf. Reine Daten, kein Fake.
 */
export type SubAgentTemplate = {
  key: string;
  name: string;
  description: string;
  thesis: string;
  /** Optionaler KI-Analyse-Prompt (Platzhalter {symbol}/{side}/{vix}/{dxy_change}/{grs} werden live gefüllt). */
  analysisPrompt?: string;
  symbols: string[];
  spec: {
    side: 'long' | 'short';
    setupType: 'scalp' | 'swing' | 'position';
    timeframe: '15m' | '1h' | '4h' | '1d';
    dataSources: ('price' | 'macro' | 'funding' | 'calendar' | 'news')[];
    entryRules: Record<string, unknown>;
    exitRules: Record<string, unknown>;
    riskParams: Record<string, number>;
  };
};

export const SUB_AGENT_TEMPLATES: SubAgentTemplate[] = [
  {
    key: 'dip-buyer',
    name: 'Dip-Buyer',
    description: 'Kauft Rücksetzer vom jüngsten Hoch und nimmt Gewinne bei einem festen Ziel mit.',
    thesis: 'Nach einem Rücksetzer von ≥ 7 % vom Hoch kommt oft eine Erholung. Long kaufen, bei +10 % raus, −5 % Stop.',
    symbols: ['BTC/USDT'],
    spec: {
      side: 'long',
      setupType: 'swing',
      timeframe: '1h',
      dataSources: ['price'],
      entryRules: { price: { dipFromHighPct: 7, dipLookback: 48 } },
      exitRules: { takeProfitPct: 10, stopLossPct: 5 },
      riskParams: { riskPctPerTrade: 1, maxLeverage: 1, maxConcurrentPositions: 1, maxDailyLossPct: 5, cooldownMinutes: 240 },
    },
  },
  {
    key: 'makro-risk-on',
    name: 'Makro-Agent (Risk-On)',
    description: 'Handelt NUR nach Makro-Lage: niedriger VIX und Risk-On-Regime (GRS aus VIX/DXY/US10Y).',
    thesis: 'Bei ruhigem Makro-Umfeld (VIX < 20, Regime risk-on) sind Long-Trades statistisch günstiger.',
    analysisPrompt:
      'VIX ist bei {vix}, DXY-20T hat sich {dxy_change}% verändert, Regime {grs}. Bewerte das Makro-Umfeld für {symbol}: Ist jetzt ein guter {side}-Einstiegszeitpunkt oder deutet etwas auf erhöhtes Risiko hin? Entscheide: EXECUTE oder SKIP.',
    symbols: ['BTC/USDT', 'ETH/USDT'],
    spec: {
      side: 'long',
      setupType: 'position',
      timeframe: '4h',
      dataSources: ['macro'],
      entryRules: { macro: { vix: { lt: 20 }, grsLabel: 'risk-on' } },
      exitRules: { takeProfitPct: 12, stopLossPct: 6, maxHoldHours: 336 },
      riskParams: { riskPctPerTrade: 1, maxLeverage: 1, maxConcurrentPositions: 2, maxDailyLossPct: 4, cooldownMinutes: 720 },
    },
  },
  {
    key: 'event-trader',
    name: 'Event-Trader (News)',
    description: 'Reagiert auf offizielle Nachrichten (Keywords) und steigt bei einem Negativ-Ereignis sofort aus.',
    thesis: 'Positive Katalysatoren (ETF-Freigabe, Listing) treiben kurzfristig; bei Hack/Ban sofort raus.',
    analysisPrompt:
      'Analysiere die letzten News-Headlines. Gibt es klare Hinweise, dass ein positiver Katalysator (z. B. ETF-Freigabe, Listing) für {symbol} tatsächlich eingetreten ist — nicht nur Gerücht oder Ankündigung? Bewerte, ob die Nachrichtenlage einen {side}-Trade rechtfertigt. Entscheide: EXECUTE oder SKIP.',
    symbols: ['BTC/USDT'],
    spec: {
      side: 'long',
      setupType: 'scalp',
      timeframe: '15m',
      dataSources: ['news'],
      entryRules: { news: { anyKeyword: ['etf approval', 'listing', 'approval'], withinMin: 120 } },
      exitRules: { takeProfitPct: 15, stopLossPct: 7, maxHoldHours: 48, exitOnNewsKeyword: ['hack', 'ban', 'exploit', 'delist'] },
      riskParams: { riskPctPerTrade: 0.5, maxLeverage: 1, maxConcurrentPositions: 1, maxDailyLossPct: 3, cooldownMinutes: 120 },
    },
  },
  {
    key: 'momentum-breakout',
    name: 'Momentum-Breakout',
    description: 'Steigt bei starkem 24h-Momentum ein und meidet High-Impact-Kalender-Events.',
    thesis: 'Ein 24h-Anstieg von ≥ 5 % zeigt Momentum. Nur handeln, wenn kein High-Impact-Event bevorsteht.',
    symbols: ['ETH/USDT'],
    spec: {
      side: 'long',
      setupType: 'swing',
      timeframe: '1h',
      dataSources: ['price', 'calendar'],
      entryRules: { price: { changePct24h: { gt: 5 } }, calendar: { noHighImpactWithinMin: 120 } },
      exitRules: { takeProfitPct: 8, stopLossPct: 4 },
      riskParams: { riskPctPerTrade: 1, maxLeverage: 1, maxConcurrentPositions: 1, maxDailyLossPct: 5, cooldownMinutes: 180 },
    },
  },
  {
    key: 'political-speculator',
    name: 'Politischer Spekulant',
    description: 'Regel-Gate auf Nachrichten-Keywords (geopolitische De-Eskalation), dann KI-Bewertung der Lage.',
    thesis: 'Offizielle De-Eskalation (Waffenstillstand, aufgehobene Sanktionen) ist ein bullisher Katalysator — die KI prüft, ob die Meldung echt ist.',
    analysisPrompt:
      'Basierend auf den aktuellen Nachrichten und Makro-Daten (VIX {vix}, Regime {grs}): Ist die geopolitische Lage bullish oder bearish für {symbol}? Prüfe, ob die offiziellen Meldungen das erwartete Ereignis (De-Eskalation) wirklich bestätigen — nicht nur Spekulation. Begründe und entscheide: EXECUTE oder SKIP.',
    symbols: ['BTC/USDT'],
    spec: {
      side: 'long',
      setupType: 'position',
      timeframe: '4h',
      dataSources: ['news', 'macro'],
      entryRules: {
        news: { anyKeyword: ['ceasefire', 'peace deal', 'sanctions lifted', 'de-escalation', 'waffenstillstand'], withinMin: 720 },
        macro: { vix: { lt: 35 } },
      },
      exitRules: { takeProfitPct: 20, stopLossPct: 10, maxHoldHours: 720, exitOnNewsKeyword: ['escalation', 'renewed fighting', 'attack'] },
      riskParams: { riskPctPerTrade: 0.5, maxLeverage: 1, maxConcurrentPositions: 1, maxDailyLossPct: 3, cooldownMinutes: 720 },
    },
  },
];
