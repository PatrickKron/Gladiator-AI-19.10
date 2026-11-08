import {
  parseInstructionDsl,
  type DslCondition,
  type DslTimeframe,
  type InstructionDsl,
} from './dsl.js';

export type DslRuleSummary = {
  direction: 'long' | 'short';
  setupType: 'scalp' | 'swing' | 'position';
  session: string | null;
  conditions: string[];
  anyGroups: string[][];
  entry: string;
  stopLoss: string;
  takeProfits: string;
  trailingStop: string | null;
  risk: string;
};

/** Formatiert eine einzelne DSL-Bedingung als kompaktes, lesbares Regel-Label. */
export function summarizeDslCondition(cond: DslCondition): string {
  if ('signal' in cond) {
    return `SMC ${cond.signal}`;
  }
  if ('indicator' in cond) {
    const period = cond.period ?? 14;
    if (cond.gt !== undefined && cond.lt !== undefined) {
      return `RSI(${period}) ${cond.gt}–${cond.lt}`;
    }
    if (cond.lt !== undefined) {
      return `RSI(${period}) < ${cond.lt}`;
    }
    if (cond.gt !== undefined) {
      return `RSI(${period}) > ${cond.gt}`;
    }
    return `RSI(${period})`;
  }
  if ('trend' in cond) {
    return cond.trend === 'EMA200_up' ? 'Kurs > EMA 200' : 'Kurs < EMA 200';
  }
  if ('maCross' in cond) {
    const { kind, fast, slow, cross } = cond.maCross;
    const dir = cross === 'bullish' ? '↑' : '↓';
    return `${kind} ${fast} × ${slow} ${dir}`;
  }
  if ('priceVs' in cond) {
    const { kind, period, is } = cond.priceVs;
    return `Kurs ${is === 'above' ? '>' : '<'} ${kind} ${period}`;
  }
  if ('macd' in cond) {
    const { fast, slow, signal, event } = cond.macd;
    const evLabel =
      event === 'bullish_cross'
        ? 'Bull Cross'
        : event === 'bearish_cross'
          ? 'Bear Cross'
          : event === 'histogram_positive'
            ? 'Hist > 0'
            : 'Hist < 0';
    return `MACD(${fast},${slow},${signal}) ${evLabel}`;
  }
  if ('bollinger' in cond) {
    const { period, mult, event } = cond.bollinger;
    const evLabel =
      event === 'close_below_lower'
        ? 'Close < Lower'
        : event === 'close_above_upper'
          ? 'Close > Upper'
          : event === 'close_above_middle'
            ? 'Close > Mid'
            : 'Close < Mid';
    return `BB(${period}, ${mult}σ) ${evLabel}`;
  }
  if ('stochastic' in cond) {
    const { kPeriod, dPeriod, kLt, kGt, cross } = cond.stochastic;
    const parts: string[] = [`Stoch(${kPeriod},${dPeriod})`];
    if (kLt !== undefined) parts.push(`K < ${kLt}`);
    if (kGt !== undefined) parts.push(`K > ${kGt}`);
    if (cross) parts.push(cross === 'bullish' ? 'K×D ↑' : 'K×D ↓');
    return parts.join(' ');
  }
  if ('adx' in cond) {
    const { period, gt, lt } = cond.adx;
    if (gt !== undefined && lt !== undefined) return `ADX(${period}) ${gt}–${lt}`;
    if (gt !== undefined) return `ADX(${period}) > ${gt}`;
    if (lt !== undefined) return `ADX(${period}) < ${lt}`;
    return `ADX(${period})`;
  }
  if ('supertrend' in cond) {
    const { period, mult, direction } = cond.supertrend;
    return `Supertrend(${period}, ${mult}×) ${direction === 'up' ? '↑' : '↓'}`;
  }
  return 'Bedingung';
}

/** Erzeugt eine vollständige, menschenlesbare Zusammenfassung einer InstructionDsl. */
export function summarizeDslRules(dsl: InstructionDsl): DslRuleSummary {
  const conditions = dsl.when.all.map(summarizeDslCondition);
  const anyGroups = (dsl.when.any ?? []).map((group) => group.map(summarizeDslCondition));

  const entry =
    dsl.entry === 'market'
      ? 'Market-Close'
      : `Retest @ ${dsl.entry.replace('retest@', '')}`;

  const stopLoss =
    dsl.stopLoss.type === 'ATR'
      ? `${dsl.stopLoss.mult}× ATR`
      : `${dsl.stopLoss.pct} % fix`;

  const takeProfits = dsl.takeProfits
    .map((tp) =>
      tp.weight !== undefined
        ? `${tp.rr}R (${Math.round(tp.weight * 100)}%)`
        : `${tp.rr}R`,
    )
    .join(' · ');

  const trailingStop = dsl.trailingStop ? `Trail ${dsl.trailingStop.pct} %` : null;
  const risk = `${dsl.risk.riskPctPerTrade} % Risiko · max. ${dsl.risk.maxLeveragePerTrade}×`;

  return {
    direction: dsl.direction,
    setupType: dsl.setupType,
    session: dsl.when.session ?? null,
    conditions,
    anyGroups,
    entry,
    stopLoss,
    takeProfits,
    trailingStop,
    risk,
  };
}

/**
 * Passt eine Katalog-Vorlage (InstructionDsl) auf ein gewähltes Ziel-Asset und/oder
 * einen Ziel-Timeframe an. Wenn ein anderes Symbol als im Preset gewählt wird,
 * wird die `id` automatisch um ein sauberes Symbol-Suffix ergänzt, damit mehrere
 * Assets parallel mit derselben Vorlage registriert werden können.
 */
export function adaptPresetDslToTarget(
  dsl: InstructionDsl,
  target: { symbol?: string; timeframe?: DslTimeframe },
): InstructionDsl {
  const nextSymbol = target.symbol?.trim() ? target.symbol.trim().toUpperCase() : dsl.symbol;
  const nextTimeframe = target.timeframe ?? dsl.timeframe;

  let nextId = dsl.id;
  if (nextSymbol !== dsl.symbol.toUpperCase()) {
    const cleanSym = nextSymbol
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (cleanSym) {
      const candidate = `${dsl.id}-${cleanSym}`.slice(0, 64).replace(/-+$/g, '');
      if (/^[a-z0-9][a-z0-9-]*$/.test(candidate) && candidate.length >= 3) {
        nextId = candidate;
      }
    }
  }

  const adapted: InstructionDsl = {
    ...dsl,
    id: nextId,
    symbol: nextSymbol,
    timeframe: nextTimeframe,
  };

  const parsed = parseInstructionDsl(adapted);
  return parsed.ok ? parsed.dsl : adapted;
}

