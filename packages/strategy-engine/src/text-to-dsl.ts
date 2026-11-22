import {
  DSL_TIMEFRAMES,
  parseInstructionDsl,
  type DslCondition,
  type DslTimeframe,
  type InstructionDsl,
} from './dsl.js';

/**
 * Deterministischer Natural-Language → Instruction-DSL Synthesizer (Welle 16 & 17).
 *
 * Wandelt frei formulierte Strategie-Beschreibungen (Deutsch/Englisch) in eine
 * Zod-validierte `InstructionDsl` um — funktioniert OHNE API-Key sofort und
 * deterministisch, und dient zugleich als Muster-Erkennung für den proaktiven Chat.
 * Kein Fake: Jede Bedingung entspricht einer echten, look-ahead-freien Engine-Regel.
 */

export type PatternMatch = {
  id: string;
  label: string;
  hint: string;
};

export type TextSynthesisOptions = {
  name?: string;
  symbol?: string;
  timeframe?: DslTimeframe;
};

export type TextSynthesisResult = {
  dsl: InstructionDsl;
  detectedFeatures: string[];
  matchedPatterns: PatternMatch[];
  summary: string;
};

const KNOWN_SYMBOLS: Array<{ pattern: RegExp; symbol: string }> = [
  { pattern: /\b(btc\/usdt|btc\b|bitcoin\b)/i, symbol: 'BTC/USDT' },
  { pattern: /\b(eth\/usdt|eth\b|ethereum\b)/i, symbol: 'ETH/USDT' },
  { pattern: /\b(sol\/usdt|sol\b|solana\b)/i, symbol: 'SOL/USDT' },
  { pattern: /\b(bnb\/usdt|bnb\b)/i, symbol: 'BNB/USDT' },
  { pattern: /\b(xrp\/usdt|xrp\b|ripple\b)/i, symbol: 'XRP/USDT' },
  { pattern: /\b(ada\/usdt|ada\b|cardano\b)/i, symbol: 'ADA/USDT' },
  { pattern: /\b(avax\/usdt|avax\b)/i, symbol: 'AVAX/USDT' },
  { pattern: /\b(link\/usdt|link\b|chainlink\b)/i, symbol: 'LINK/USDT' },
  { pattern: /\b(doge\/usdt|doge\b)/i, symbol: 'DOGE/USDT' },
  { pattern: /\b(qnt\/usdt|qnt\b|quant\b)/i, symbol: 'QNT/USDT' },
  { pattern: /\b(xau\/usd|gold\b|xau\b)/i, symbol: 'XAU/USD' },
  { pattern: /\b(xag\/usd|silber\b|silver\b)/i, symbol: 'XAG/USD' },
  { pattern: /\b(eur\/usd|eurusd\b)/i, symbol: 'EUR/USD' },
  { pattern: /\b(gbp\/usd|gbpusd\b)/i, symbol: 'GBP/USD' },
  { pattern: /\b(usd\/jpy|usdjpy\b)/i, symbol: 'USD/JPY' },
  { pattern: /\b(spy\b|s&p\s*500\b)/i, symbol: 'SPY' },
  { pattern: /\b(qqq\b|nasdaq\b)/i, symbol: 'QQQ' },
  { pattern: /\b(nvda\b|nvidia\b)/i, symbol: 'NVDA' },
  { pattern: /\b(aapl\b|apple\b)/i, symbol: 'AAPL' },
  { pattern: /\b(tsla\b|tesla\b)/i, symbol: 'TSLA' },
  { pattern: /\b(msft\b|microsoft\b)/i, symbol: 'MSFT' },
];

const PATTERN_RULES: Array<{ id: string; label: string; hint: string; re: RegExp }> = [
  {
    id: 'divergence',
    label: 'RSI/MACD-Divergenz',
    hint: 'Bullische/Bärische Divergenz zwischen Preis und Oszillator',
    re: /\b(divergen[cz]|hidden\s+div|versteckte\s+divergen)/i,
  },
  {
    id: 'ema_cross',
    label: 'EMA/SMA-Crossover',
    hint: 'Gleitender Durchschnitt kreuzt schnelleren/langsameren Durchschnitt',
    re: /\b(golden\s*cross|death\s*cross|crossover|crossunder|kreuzt|(?:ema|sma)\s*\d+\s*[/und&,-]+\s*(?:ema|sma)?\s*\d+|ma\s*cross)/i,
  },
  {
    id: 'ema_pullback',
    label: 'Trend-Pullback (EMA)',
    hint: 'Rücksetzer an den Trend-EMA mit Trendfilter',
    re: /(?:^|[\s(])(pullback|rücksetzer|retest|ema\s*200|ema\s*50|trendfilter|trendfolge|über\s+(?:dem?\s+)?ema|unter\s+(?:dem?\s+)?ema)/i,
  },
  {
    id: 'rsi_reversion',
    label: 'RSI Überverkauft / Überkauft',
    hint: 'Mean-Reversion über RSI-Extremzonen',
    re: /(?:^|[\s(])(rsi|überverkauft|oversold|überkauft|overbought|mean[\s-]*reversion)/i,
  },
  {
    id: 'bollinger',
    label: 'Bollinger-Bänder / Squeeze',
    hint: 'Ausbruch oder Rebound an den Bollinger-Bändern',
    re: /\b(bollinger|bb\s*(?:band|squeeze|rebound)|unteres\s+band|oberes\s+band|squeeze)/i,
  },
  {
    id: 'macd',
    label: 'MACD-Momentum',
    hint: 'MACD-Kreuzung oder Histogramm-Wechsel',
    re: /\b(macd|histogramm?)/i,
  },
  {
    id: 'supertrend',
    label: 'Supertrend',
    hint: 'ATR-basierter Supertrend-Richtungsfilter',
    re: /\b(supertrend|super\s+trend)/i,
  },
  {
    id: 'smc_breakout',
    label: 'Strukturbruch / Breakout (BOS / CHoCH)',
    hint: 'Break of Structure, Change of Character, Ausbruch oder Liquidity-Sweep',
    re: /\b(bos\b|choch\b|strukturbruch|trendwechsel|breakout|ausbruch|order\s*block|fair\s+value\s+gap|\bfvg\b|liquidity\s*sweep|sweep|double\s+(?:bottom|top)|doppelboden|doppeltop|head\s+and\s+shoulders|schulter[\s-]*kopf|dreieck|triangle|flagge|bull\s*flag|bear\s*flag)/i,
  },
  {
    id: 'adx',
    label: 'ADX-Trendstärke',
    hint: 'Filtert Seitwärtsphasen über ADX-Schwellwert',
    re: /\b(adx\b|trendstärke|starker\s+trend)/i,
  },
  {
    id: 'stochastic',
    label: 'Stochastic-Oszillator',
    hint: 'Stochastic %K/%D Überverkauft-/Kreuzungs-Signal',
    re: /\b(stochast(?:ic|ik)|stoch\b)/i,
  },
];

/**
 * Erkennt Chartmuster, Indikatoren und Strategie-Konzepte in frei formuliertem Text.
 * Wird vom proaktiven Chat (Welle 17) UND vom Text-zu-Strategie-Builder (Welle 16) genutzt.
 */
export function detectStrategyPatterns(text: string): PatternMatch[] {
  const s = text.trim();
  if (s.length < 4) return [];
  const out: PatternMatch[] = [];
  for (const rule of PATTERN_RULES) {
    if (rule.re.test(s)) {
      out.push({ id: rule.id, label: rule.label, hint: rule.hint });
    }
  }
  return out;
}

function slugify(input: string): string {
  const clean = input
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  return clean.length >= 3 && /^[a-z0-9][a-z0-9-]*$/.test(clean) ? clean : `text-strategie-${Date.now().toString(36)}`;
}

function extractSymbol(text: string, fallback?: string): string {
  // Explizites Paar wie XYZ/USDT oder XYZ/USD im Text
  const explicitPair = text.match(/\b([A-Z]{2,8}\/(?:USDT|USDC|USD|EUR))\b/i);
  if (explicitPair?.[1]) return explicitPair[1].toUpperCase();
  for (const k of KNOWN_SYMBOLS) {
    if (k.pattern.test(text)) return k.symbol;
  }
  return fallback?.trim() ? fallback.trim().toUpperCase() : 'BTC/USDT';
}

function extractTimeframe(text: string, fallback?: DslTimeframe): DslTimeframe {
  // Exakte Kurzformen (case-sensitiv für 1M vs 1m!)
  if (/\b1M\b/.test(text) || /\b(monatschart|monthly)\b/i.test(text)) return '1M';
  const tfMatch = text.match(/\b(1m|2m|3m|5m|10m|15m|30m|1h|2h|4h|12h|1d|1w)\b/i);
  if (tfMatch?.[1]) {
    const lower = tfMatch[1].toLowerCase() as DslTimeframe;
    if ((DSL_TIMEFRAMES as readonly string[]).includes(lower)) return lower;
  }
  if (/\b(wochenchart|weekly)\b/i.test(text)) return '1w';
  if (/\b(tageschart|daily|tag)\b/i.test(text)) return '1d';
  if (/\b(4[\s-]*stunden|4std)\b/i.test(text)) return '4h';
  if (/\b(stundenchart|1[\s-]*stunde|hourly)\b/i.test(text)) return '1h';
  if (/\b(15[\s-]*min)\b/i.test(text)) return '15m';
  if (/\b(5[\s-]*min)\b/i.test(text)) return '5m';
  if (/\b(1[\s-]*min)\b/i.test(text)) return '1m';
  return fallback ?? '1h';
}

function extractDirection(text: string): 'long' | 'short' {
  const shortHits = (text.match(/\b(short|verkauf|verkaufen|bearish|bärisch|fallend|death\s*cross|doppeltop|double\s+top|bear\s*flag)\b/gi) ?? []).length;
  const longHits = (text.match(/\b(long|kauf|kaufen|bullish|bullisch|steigend|golden\s*cross|doppelboden|double\s+bottom|bull\s*flag)\b/gi) ?? []).length;
  return shortHits > longHits ? 'short' : 'long';
}

function parseNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function setupTypeForTf(tf: DslTimeframe): 'scalp' | 'swing' | 'position' {
  if (['1m', '2m', '3m', '5m', '10m', '15m'].includes(tf)) return 'scalp';
  if (['1d', '1w', '1M'].includes(tf)) return 'position';
  return 'swing';
}

/**
 * Übersetzt eine natürlichsprachliche Strategie-Beschreibung deterministisch in
 * eine vollständig validierte `InstructionDsl`.
 */
export function synthesizeDslFromText(text: string, opts: TextSynthesisOptions = {}): TextSynthesisResult {
  const raw = text.trim();
  const matchedPatterns = detectStrategyPatterns(raw);
  const symbol = extractSymbol(raw, opts.symbol);
  const timeframe = extractTimeframe(raw, opts.timeframe);
  const direction = extractDirection(raw);
  const setupType = setupTypeForTf(timeframe);

  const conditions: DslCondition[] = [];
  const features: string[] = [];

  // 1. Divergenzen (RSI / MACD, Regular / Hidden, Bullish / Bearish)
  if (/\b(divergen[cz]|hidden\s+div|versteckte\s+divergen)/i.test(raw)) {
    const ind: 'rsi' | 'macd' = /\bmacd\b/i.test(raw) && !/\brsi\b/i.test(raw) ? 'macd' : 'rsi';
    const isHidden = /\b(hidden|versteckt)/i.test(raw);
    const kind =
      direction === 'long'
        ? isHidden
          ? ('hidden_bullish' as const)
          : ('bullish' as const)
        : isHidden
          ? ('hidden_bearish' as const)
          : ('bearish' as const);
    conditions.push({ divergence: { indicator: ind, kind, withinBars: 10 } });
    features.push(`${ind.toUpperCase()}-Divergenz (${kind})`);
  }

  // 2. MA Crossover (z. B. "EMA 20 kreuzt EMA 50", "Golden Cross", "SMA 50/200")
  const crossMatch =
    raw.match(/\b(ema|sma)\s*(\d{1,3})\s*(?:kreuzt|cross(?:es|over|under)?|\/|und|&|-)\s*(?:ema|sma)?\s*(\d{1,3})\b/i);
  if (crossMatch) {
    const kind = crossMatch[1]!.toUpperCase() === 'SMA' ? ('SMA' as const) : ('EMA' as const);
    const a = Number(crossMatch[2]);
    const b = Number(crossMatch[3]);
    const fast = Math.max(2, Math.min(a, b, 300));
    const slow = Math.max(fast + 1, Math.min(Math.max(a, b), 500));
    const cross = direction === 'long' ? ('bullish' as const) : ('bearish' as const);
    conditions.push({ maCross: { kind, fast, slow, cross, withinBars: 3 } });
    features.push(`${kind} ${fast}/${slow} ${cross} Cross`);
  } else if (/\b(golden\s*cross|death\s*cross)\b/i.test(raw)) {
    const isDeath = /\bdeath\s*cross\b/i.test(raw);
    conditions.push({
      maCross: { kind: 'SMA', fast: 50, slow: 200, cross: isDeath ? 'bearish' : 'bullish', withinBars: 5 },
    });
    features.push(isDeath ? 'Death Cross (SMA 50/200)' : 'Golden Cross (SMA 50/200)');
  }

  // 3. Trend-Filter (EMA 200 / EMA N / SMA N)
  const priceVsMatch = raw.match(/(?:^|[\s,(])(über|above|unter|below)\s+(?:dem?\s+)?(ema|sma)\s*(\d{1,3})\b/i);
  if (priceVsMatch) {
    const isAbove = /über|above/i.test(priceVsMatch[1]!);
    const kind = priceVsMatch[2]!.toUpperCase() === 'SMA' ? ('SMA' as const) : ('EMA' as const);
    const period = Math.max(2, Math.min(500, Number(priceVsMatch[3])));
    conditions.push({ priceVs: { kind, period, is: isAbove ? 'above' : 'below' } });
    features.push(`Preis ${isAbove ? 'über' : 'unter'} ${kind}${period}`);
  } else if (/\bema\s*200\b|\btrendfilter\b|\btrendfolge\b/i.test(raw)) {
    conditions.push({ trend: direction === 'long' ? 'EMA200_up' : 'EMA200_down' });
    features.push(direction === 'long' ? 'EMA200 Aufwärtstrend' : 'EMA200 Abwärtstrend');
  }

  // 4. RSI Schwellwerte
  const rsiLt = raw.match(/\brsi(?:\s*\(\d+\))?\s*(?:<|<=|unter|kleiner|below)\s*(\d{1,2})\b/i);
  const rsiGt = raw.match(/\brsi(?:\s*\(\d+\))?\s*(?:>|>=|über|größer|above)\s*(\d{1,2})\b/i);
  if (rsiLt || rsiGt) {
    const lt = rsiLt ? Math.max(5, Math.min(95, Number(rsiLt[1]))) : undefined;
    const gt = rsiGt ? Math.max(5, Math.min(95, Number(rsiGt[1]))) : undefined;
    conditions.push({ indicator: 'RSI', ...(lt !== undefined ? { lt } : {}), ...(gt !== undefined ? { gt } : {}) });
    features.push(`RSI${lt !== undefined ? ` < ${lt}` : ''}${gt !== undefined ? ` > ${gt}` : ''}`);
  } else if (/(?:^|[\s,(])(überverkauft|oversold)\b/i.test(raw)) {
    conditions.push({ indicator: 'RSI', lt: 35 });
    features.push('RSI überverkauft (< 35)');
  } else if (/(?:^|[\s,(])(überkauft|overbought)\b/i.test(raw)) {
    conditions.push({ indicator: 'RSI', gt: 65 });
    features.push('RSI überkauft (> 65)');
  } else if (/\brsi\b/i.test(raw) && !conditions.some((c) => 'divergence' in c)) {
    conditions.push(direction === 'long' ? { indicator: 'RSI', lt: 42 } : { indicator: 'RSI', gt: 58 });
    features.push(direction === 'long' ? 'RSI < 42' : 'RSI > 58');
  }

  // 5. MACD
  if (/\bmacd\b|\bhistogramm?\b/i.test(raw) && !conditions.some((c) => 'divergence' in c && c.divergence.indicator === 'macd')) {
    const hist = /\bhistogramm?\b/i.test(raw);
    const event = hist
      ? direction === 'long'
        ? ('histogram_positive' as const)
        : ('histogram_negative' as const)
      : direction === 'long'
        ? ('bullish_cross' as const)
        : ('bearish_cross' as const);
    conditions.push({ macd: { fast: 12, slow: 26, signal: 9, event, withinBars: 3 } });
    features.push(`MACD (${event})`);
  }

  // 6. Bollinger Bänder
  if (/\b(bollinger|unteres\s+band|oberes\s+band|squeeze)\b/i.test(raw)) {
    const event =
      /oberes\s+band|above\s+upper|ausbruch|breakout/i.test(raw) && direction === 'long'
        ? ('close_above_upper' as const)
        : direction === 'long'
          ? ('close_below_lower' as const)
          : ('close_above_upper' as const);
    conditions.push({ bollinger: { period: 20, mult: 2, event } });
    features.push(`Bollinger (${event})`);
  }

  // 7. Supertrend
  if (/\b(supertrend|super\s+trend)\b/i.test(raw)) {
    conditions.push({ supertrend: { period: 10, mult: 3, direction: direction === 'long' ? 'up' : 'down' } });
    features.push(`Supertrend (${direction === 'long' ? 'up' : 'down'})`);
  }

  // 8. ADX Trendstärke
  if (/\b(adx|trendstärke|starker\s+trend)\b/i.test(raw)) {
    const adxNum = raw.match(/\badx\s*(?:>|>=|über)?\s*(\d{1,2})\b/i);
    const gt = adxNum ? Math.max(10, Math.min(60, Number(adxNum[1]))) : 20;
    conditions.push({ adx: { period: 14, gt } });
    features.push(`ADX > ${gt}`);
  }

  // 9. Stochastic
  if (/\b(stochast(?:ic|ik)|stoch\b)/i.test(raw)) {
    conditions.push(
      direction === 'long'
        ? { stochastic: { kPeriod: 14, dPeriod: 3, smoothK: 3, kLt: 25, cross: 'bullish', withinBars: 3 } }
        : { stochastic: { kPeriod: 14, dPeriod: 3, smoothK: 3, kGt: 75, cross: 'bearish', withinBars: 3 } },
    );
    features.push(`Stochastic (${direction === 'long' ? 'bullish < 25' : 'bearish > 75'})`);
  }

  // 10. SMC / Strukturbruch / Breakout / Reversal
  if (/\b(choch|trendwechsel|reversal|doppelboden|double\s+bottom|doppeltop|double\s+top)\b/i.test(raw)) {
    conditions.push({ signal: 'CHoCH' });
    features.push('Strukturwechsel (CHoCH)');
  } else if (/\b(bos\b|strukturbruch|breakout|ausbruch|order\s*block|fvg|sweep|flagge|dreieck)\b/i.test(raw)) {
    conditions.push({ signal: 'BOS' });
    features.push('Strukturbruch / Breakout (BOS)');
  }

  // Falls kein spezifischer Indikator genannt wurde → solider Trend-Pullback-Standard
  if (conditions.length === 0) {
    conditions.push({ priceVs: { kind: 'EMA', period: 200, is: direction === 'long' ? 'above' : 'below' } });
    conditions.push(direction === 'long' ? { indicator: 'RSI', lt: 40 } : { indicator: 'RSI', gt: 60 });
    features.push(direction === 'long' ? 'Standard: Preis > EMA200 + RSI < 40' : 'Standard: Preis < EMA200 + RSI > 60');
  }

  // Stop-Loss aus Text extrahieren (ATR oder %)
  const slPctMatch = raw.match(/\b(?:sl|stop[\s-]*loss|stop)\s*(?:von|bei|:)?\s*(\d+(?:[.,]\d+)?)\s*%/i);
  const slAtrMatch = raw.match(/\b(?:sl|stop[\s-]*loss|stop)?\s*(\d+(?:[.,]\d+)?)\s*(?:x|×)?\s*atr\b/i);
  let stopLoss: InstructionDsl['stopLoss'] = { type: 'ATR', mult: 2 };
  if (slPctMatch) {
    const pct = parseNumber(slPctMatch[1]);
    if (pct !== null && pct >= 0.2 && pct <= 25) {
      stopLoss = { type: 'pct', pct };
      features.push(`Stop-Loss ${pct} %`);
    }
  } else if (slAtrMatch) {
    const mult = parseNumber(slAtrMatch[1]);
    if (mult !== null && mult >= 0.5 && mult <= 6) {
      stopLoss = { type: 'ATR', mult };
      features.push(`Stop-Loss ${mult}× ATR`);
    }
  }

  // Take-Profit R:R aus Text extrahieren
  const tpMatch = raw.match(/\b(?:tp|take[\s-]*profit|crv|r:r|rr|ziel)\s*(?:von|bei|:)?\s*(\d+(?:[.,]\d+)?)\s*r?\b/i);
  let takeProfits: InstructionDsl['takeProfits'] = [{ rr: 1.5 }, { rr: 3 }];
  if (tpMatch) {
    const rr = parseNumber(tpMatch[1]);
    if (rr !== null && rr >= 0.8 && rr <= 15) {
      takeProfits = rr > 1.8 ? [{ rr: Math.round((rr / 2) * 10) / 10 }, { rr }] : [{ rr }];
      features.push(`Take-Profit ${takeProfits.map((t) => `${t.rr}R`).join(' / ')}`);
    }
  }

  // Trailing Stop aus Text
  const trailMatch = raw.match(/\btrailing(?:\s*stop)?\s*(?:von|bei|:)?\s*(\d+(?:[.,]\d+)?)\s*%/i);
  let trailingStop: { pct: number } | undefined;
  if (trailMatch) {
    const pct = parseNumber(trailMatch[1]);
    if (pct !== null && pct >= 0.2 && pct <= 30) {
      trailingStop = { pct };
      features.push(`Trailing-Stop ${pct} %`);
    }
  } else if (/\btrailing\b/i.test(raw)) {
    trailingStop = { pct: 2 };
    features.push('Trailing-Stop 2 %');
  }

  // Risiko pro Trade
  const riskMatch = raw.match(/\b(?:risiko|risk)\s*(?:pro\s*trade)?\s*(?:von|bei|:)?\s*(\d+(?:[.,]\d+)?)\s*%/i);
  const parsedRisk = riskMatch ? parseNumber(riskMatch[1]) : null;
  const riskPctPerTrade = parsedRisk !== null && parsedRisk >= 0.1 && parsedRisk <= 3 ? parsedRisk : 1;

  const baseName = opts.name?.trim() || `${symbol.replace('/', '-')}-${matchedPatterns[0]?.id ?? 'setup'}-${timeframe}`;
  const candidate = {
    id: slugify(baseName),
    symbol,
    timeframe,
    venueType: 'cex' as const,
    direction,
    setupType,
    when: { all: conditions.slice(0, 6) },
    entry: 'market',
    stopLoss,
    takeProfits,
    ...(trailingStop ? { trailingStop } : {}),
    breakEvenAfterTp1: true,
    risk: {
      maxLeveragePerTrade: setupType === 'scalp' ? 3 : 2,
      riskPctPerTrade,
    },
  };

  const parsed = parseInstructionDsl(candidate);
  if (!parsed.ok) {
    throw new Error(`Synthetisierte DSL ungültig: ${parsed.errors.join('; ')}`);
  }

  const summary = `${direction.toUpperCase()} auf ${symbol} (${timeframe}) · ${features.join(' · ')}`;
  return {
    dsl: parsed.dsl,
    detectedFeatures: features,
    matchedPatterns,
    summary,
  };
}
