import { z } from 'zod';
import { atr, bollinger, ema, macd, rsi, sma } from './indicators.js';
import { adx, stochastic, supertrend } from './indicators-extra.js';
import { detectStructure } from './structure.js';
import { riskClassOf, type RiskClass, type TradingSession } from './scoring.js';
import { sessionOf } from './session.js';
import type { Candle } from './types.js';

/**
 * Anweisungs-DSL (07_ §3): kleine, typisierte Strategie-Beschreibung, in die
 * ein LLM natürliche Anweisungen übersetzt — überprüfbar, keine Blackbox.
 * Die DSL wird gegen dieses Zod-Schema validiert und von DERSELBEN Engine
 * ausgewertet wie die eingebauten Strategien (eine Wahrheit, Regel 6).
 * Das LLM schaltet NIE scharf: Registrierung nur nach Patricks Bestätigung.
 */

const conditionSchema = z.union([
  z.object({ signal: z.enum(['BOS', 'CHoCH']) }).strict(),
  z
    .object({
      indicator: z.literal('RSI'),
      lt: z.number().min(0).max(100).optional(),
      gt: z.number().min(0).max(100).optional(),
      /** RSI-Periode (optional, Auswertung nutzt sonst 14). */
      period: z.number().int().min(2).max(100).optional(),
    })
    .strict()
    .refine((c) => c.lt !== undefined || c.gt !== undefined, {
      message: 'RSI-Bedingung braucht lt und/oder gt.',
    }),
  z.object({ trend: z.enum(['EMA200_up', 'EMA200_down']) }).strict(),
  // ── Workshop-Erweiterung: Indikator-Bedingungen (alle look-ahead-frei am Bar i) ──
  z
    .object({
      maCross: z
        .object({
          kind: z.enum(['EMA', 'SMA']).default('EMA'),
          fast: z.number().int().min(2).max(400),
          slow: z.number().int().min(3).max(500),
          cross: z.enum(['bullish', 'bearish']),
          /** Cross gilt, wenn es innerhalb der letzten N Bars passiert ist (Default 1 = genau jetzt). */
          withinBars: z.number().int().min(1).max(20).default(1),
        })
        .strict()
        .refine((c) => c.fast < c.slow, { message: 'maCross: fast muss kleiner als slow sein.' }),
    })
    .strict(),
  z
    .object({
      priceVs: z
        .object({
          kind: z.enum(['EMA', 'SMA']),
          period: z.number().int().min(2).max(500),
          is: z.enum(['above', 'below']),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      macd: z
        .object({
          fast: z.number().int().min(2).max(100).default(12),
          slow: z.number().int().min(3).max(200).default(26),
          signal: z.number().int().min(2).max(100).default(9),
          event: z.enum(['bullish_cross', 'bearish_cross', 'histogram_positive', 'histogram_negative']),
          withinBars: z.number().int().min(1).max(20).default(1),
        })
        .strict()
        .refine((c) => c.fast < c.slow, { message: 'macd: fast muss kleiner als slow sein.' }),
    })
    .strict(),
  z
    .object({
      bollinger: z
        .object({
          period: z.number().int().min(5).max(200).default(20),
          mult: z.number().min(0.5).max(5).default(2),
          event: z.enum(['close_below_lower', 'close_above_upper', 'close_above_middle', 'close_below_middle']),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      stochastic: z
        .object({
          kPeriod: z.number().int().min(2).max(100).default(14),
          dPeriod: z.number().int().min(1).max(50).default(3),
          smoothK: z.number().int().min(1).max(10).default(1),
          kLt: z.number().min(0).max(100).optional(),
          kGt: z.number().min(0).max(100).optional(),
          /** K kreuzt D (bullish = von unten nach oben). */
          cross: z.enum(['bullish', 'bearish']).optional(),
          withinBars: z.number().int().min(1).max(20).default(1),
        })
        .strict()
        .refine((c) => c.kLt !== undefined || c.kGt !== undefined || c.cross !== undefined, {
          message: 'stochastic: kLt, kGt oder cross nötig.',
        }),
    })
    .strict(),
  z
    .object({
      adx: z
        .object({
          period: z.number().int().min(2).max(100).default(14),
          gt: z.number().min(0).max(100).optional(),
          lt: z.number().min(0).max(100).optional(),
        })
        .strict()
        .refine((c) => c.gt !== undefined || c.lt !== undefined, { message: 'adx: gt und/oder lt nötig.' }),
    })
    .strict(),
  z
    .object({
      supertrend: z
        .object({
          period: z.number().int().min(2).max(100).default(10),
          mult: z.number().min(0.5).max(10).default(3),
          direction: z.enum(['up', 'down']),
        })
        .strict(),
    })
    .strict(),
]);

export type DslCondition = z.infer<typeof conditionSchema>;

/** Alle im System unterstützten Timeframes (deckungsgleich mit market-data SUPPORTED_TIMEFRAMES). */
export const DSL_TIMEFRAMES = ['5m', '15m', '30m', '1h', '2h', '4h', '12h', '1d', '1w', '1M'] as const;
export type DslTimeframe = (typeof DSL_TIMEFRAMES)[number];

export const instructionDslSchema = z
  .object({
    id: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'id: nur Kleinbuchstaben, Ziffern, Bindestriche'),
    symbol: z.string().min(3),
    timeframe: z.enum(DSL_TIMEFRAMES).default('1h'),
    venueType: z.enum(['cex', 'dex']).default('cex'),
    direction: z.enum(['long', 'short']),
    setupType: z.enum(['scalp', 'swing', 'position']).default('swing'),
    when: z
      .object({
        session: z.enum(['asia', 'london', 'overlap', 'newyork', 'off']).optional(),
        all: z.array(conditionSchema).min(1).max(10),
      })
      .strict(),
    entry: z
      .union([z.literal('market'), z.string().regex(/^retest@EMA\d{1,3}$/, 'entry: "market" oder "retest@EMA<n>"')])
      .default('market'),
    stopLoss: z.union([
      z.object({ type: z.literal('ATR'), mult: z.number().positive().max(10) }).strict(),
      z.object({ type: z.literal('pct'), pct: z.number().positive().max(50) }).strict(),
    ]),
    takeProfits: z.array(z.object({ rr: z.number().positive().max(20) }).strict()).min(1).max(5),
    /** Optionaler Trailing-Stop: folgt dem besten Kurs im %-Abstand, nur verschärfen (Backtest UND Live). */
    trailingStop: z.object({ pct: z.number().min(0.1).max(50) }).strict().optional(),
    risk: z
      .object({
        maxLeveragePerTrade: z.number().min(1).max(25),
        riskPctPerTrade: z.number().positive().max(5),
      })
      .strict()
      .default({ maxLeveragePerTrade: 1, riskPctPerTrade: 1 }),
  })
  .strict();

export type InstructionDsl = z.infer<typeof instructionDslSchema>;

export type DslParseResult = { ok: true; dsl: InstructionDsl } | { ok: false; errors: string[] };

/** Validiert unbekannte Eingaben (LLM-Entwurf oder manuelles JSON) gegen das Schema. */
export function parseInstructionDsl(input: unknown): DslParseResult {
  const r = instructionDslSchema.safeParse(input);
  if (r.success) return { ok: true, dsl: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}

/** Setup-Kandidat aus einer DSL-Strategie (Felder wie das kanonische Signal braucht). */
export type DslSetup = {
  direction: 'long' | 'short';
  setupType: 'scalp' | 'swing' | 'position';
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  score: number;
  riskClass: RiskClass;
  confluence: string[];
  session: TradingSession;
  emaRegime: 'above' | 'below';
  marketPhase: 'bull' | 'bear';
  leverageSuggested: number;
  /** Trailing-Stop-Abstand in % (aus dsl.trailingStop); fehlt = statischer Stop. */
  trailPct?: number;
};

/** Wie viele Bars zurück ein BOS/CHoCH-Ereignis für die signal-Bedingung zählt. */
const STRUCTURE_WINDOW_BARS = 12;
/** Nähe zum Retest-EMA in Prozent (wie Pine: low <= EMA * 1.02). */
const RETEST_PROXIMITY_PCT = 2;

/**
 * Cross-Erkennung zweier Serien am/vor Bar `i`: bullish = a kreuzt b von unten
 * nach oben. Zählt, wenn der Cross innerhalb der letzten `withinBars` Bars lag.
 * Undefinierte Werte (Warmup) zählen ehrlich als „kein Cross".
 */
function crossedWithin(
  a: (number | null)[],
  b: (number | null)[],
  i: number,
  withinBars: number,
  direction: 'bullish' | 'bearish',
): boolean {
  for (let j = Math.max(1, i - withinBars + 1); j <= i; j++) {
    const aNow = a[j];
    const bNow = b[j];
    const aPrev = a[j - 1];
    const bPrev = b[j - 1];
    if (aNow == null || bNow == null || aPrev == null || bPrev == null) continue;
    if (direction === 'bullish' && aPrev <= bPrev && aNow > bNow) return true;
    if (direction === 'bearish' && aPrev >= bPrev && aNow < bNow) return true;
  }
  return false;
}

/**
 * Wertet die DSL GENAU am Bar `i` aus — nur Daten bis i (look-ahead-frei).
 * Nicht erfüllte Bedingungen oder undefinierte Indikatoren ⇒ ehrlich null.
 */
export function evaluateDslAt(allCandles: Candle[], i: number, dsl: InstructionDsl): DslSetup | null {
  const candles = allCandles.slice(0, i + 1);
  const bar = candles[i];
  if (!bar) return null;

  // Session-Gate
  const session = sessionOf(bar.ts);
  if (dsl.when.session && session !== dsl.when.session) return null;

  const closes = candles.map((c) => c.close);
  const ema200Series = ema(closes, 200);
  const ema200 = ema200Series[i];
  if (ema200 == null) return null; // zu wenig Historie — kein Fantasie-Regime

  const matched: string[] = [];
  const events = detectStructure(candles);

  for (const cond of dsl.when.all) {
    if ('signal' in cond) {
      const wantDirection = dsl.direction === 'long' ? 'bullish' : 'bearish';
      const hit = events.some(
        (e) => e.kind === cond.signal && e.direction === wantDirection && i - e.index <= STRUCTURE_WINDOW_BARS && e.index <= i,
      );
      if (!hit) return null;
      matched.push(`dsl:${cond.signal}`);
    } else if ('indicator' in cond) {
      const value = rsi(closes, cond.period)[i];
      if (value == null) return null;
      if (cond.lt !== undefined && !(value < cond.lt)) return null;
      if (cond.gt !== undefined && !(value > cond.gt)) return null;
      matched.push(`dsl:RSI${cond.lt !== undefined ? `<${cond.lt}` : ''}${cond.gt !== undefined ? `>${cond.gt}` : ''}`);
    } else if ('maCross' in cond) {
      const c = cond.maCross;
      const maFn = c.kind === 'EMA' ? ema : sma;
      const fast = maFn(closes, c.fast);
      const slow = maFn(closes, c.slow);
      if (!crossedWithin(fast, slow, i, c.withinBars, c.cross)) return null;
      matched.push(`dsl:maCross:${c.kind}${c.fast}/${c.slow}:${c.cross}`);
    } else if ('priceVs' in cond) {
      const c = cond.priceVs;
      const value = (c.kind === 'EMA' ? ema : sma)(closes, c.period)[i];
      if (value == null) return null;
      if (c.is === 'above' && !(bar.close > value)) return null;
      if (c.is === 'below' && !(bar.close < value)) return null;
      matched.push(`dsl:priceVs:${c.kind}${c.period}:${c.is}`);
    } else if ('macd' in cond) {
      const c = cond.macd;
      const m = macd(closes, c.fast, c.slow, c.signal);
      if (c.event === 'histogram_positive' || c.event === 'histogram_negative') {
        const h = m.histogram[i];
        if (h == null) return null;
        if (c.event === 'histogram_positive' && !(h > 0)) return null;
        if (c.event === 'histogram_negative' && !(h < 0)) return null;
      } else {
        const dir = c.event === 'bullish_cross' ? 'bullish' : 'bearish';
        if (!crossedWithin(m.macd, m.signal, i, c.withinBars, dir)) return null;
      }
      matched.push(`dsl:macd:${c.event}`);
    } else if ('bollinger' in cond) {
      const c = cond.bollinger;
      const b = bollinger(closes, c.period, c.mult);
      const upper = b.upper[i];
      const middle = b.middle[i];
      const lower = b.lower[i];
      if (upper == null || middle == null || lower == null) return null;
      if (c.event === 'close_below_lower' && !(bar.close < lower)) return null;
      if (c.event === 'close_above_upper' && !(bar.close > upper)) return null;
      if (c.event === 'close_above_middle' && !(bar.close > middle)) return null;
      if (c.event === 'close_below_middle' && !(bar.close < middle)) return null;
      matched.push(`dsl:bollinger:${c.event}`);
    } else if ('stochastic' in cond) {
      const c = cond.stochastic;
      const s = stochastic(candles, c.kPeriod, c.dPeriod, c.smoothK);
      const k = s.k[i];
      if (k == null) return null;
      if (c.kLt !== undefined && !(k < c.kLt)) return null;
      if (c.kGt !== undefined && !(k > c.kGt)) return null;
      if (c.cross !== undefined && !crossedWithin(s.k, s.d, i, c.withinBars, c.cross)) return null;
      matched.push(`dsl:stochastic${c.cross ? `:${c.cross}` : ''}`);
    } else if ('adx' in cond) {
      const c = cond.adx;
      const value = adx(candles, c.period).adx[i];
      if (value == null) return null;
      if (c.gt !== undefined && !(value > c.gt)) return null;
      if (c.lt !== undefined && !(value < c.lt)) return null;
      matched.push(`dsl:adx${c.gt !== undefined ? `>${c.gt}` : ''}${c.lt !== undefined ? `<${c.lt}` : ''}`);
    } else if ('supertrend' in cond) {
      const c = cond.supertrend;
      const point = supertrend(candles, c.period, c.mult)[i];
      if (point == null) return null;
      if (point.direction !== c.direction) return null;
      matched.push(`dsl:supertrend:${c.direction}`);
    } else {
      const up = bar.close >= ema200;
      if (cond.trend === 'EMA200_up' && !up) return null;
      if (cond.trend === 'EMA200_down' && up) return null;
      matched.push(`dsl:${cond.trend}`);
    }
  }

  // Entry: market oder Retest an EMA<n>
  const entry = bar.close;
  if (dsl.entry !== 'market') {
    const period = Number(dsl.entry.slice('retest@EMA'.length));
    const emaSeries = ema(closes, period);
    const emaValue = emaSeries[i];
    if (emaValue == null) return null;
    const near =
      dsl.direction === 'long'
        ? bar.low <= emaValue * (1 + RETEST_PROXIMITY_PCT / 100)
        : bar.high >= emaValue * (1 - RETEST_PROXIMITY_PCT / 100);
    if (!near) return null;
    matched.push(`dsl:retest@EMA${period}`);
  }

  // Stop-Loss aus der DSL
  let stopLoss: number;
  if (dsl.stopLoss.type === 'ATR') {
    const atrValue = atr(candles)[i];
    if (atrValue == null) return null;
    stopLoss = dsl.direction === 'long' ? entry - atrValue * dsl.stopLoss.mult : entry + atrValue * dsl.stopLoss.mult;
  } else {
    stopLoss = dsl.direction === 'long' ? entry * (1 - dsl.stopLoss.pct / 100) : entry * (1 + dsl.stopLoss.pct / 100);
  }
  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return null;

  const takeProfits = dsl.takeProfits.map((tp) =>
    dsl.direction === 'long' ? entry + tp.rr * risk : entry - tp.rr * risk,
  );

  /**
   * Score: RR-basiert (min(10, RR1 × 3)) — dokumentierte, echte Berechnung.
   * DSL-Strategien haben keine SMC-Confluence-Analyse; das steht transparent
   * in der confluence-Liste ('score:rr-basiert').
   */
  const rr1 = dsl.takeProfits[0]!.rr;
  const score = Math.min(10, Math.round(rr1 * 30) / 10);

  const lastEvent = events[events.length - 1];
  return {
    direction: dsl.direction,
    setupType: dsl.setupType,
    entry,
    stopLoss,
    takeProfits,
    score,
    riskClass: riskClassOf(score),
    confluence: [...matched, 'score:rr-basiert'],
    session,
    emaRegime: bar.close >= ema200 ? 'above' : 'below',
    marketPhase: lastEvent ? (lastEvent.direction === 'bullish' ? 'bull' : 'bear') : bar.close >= ema200 ? 'bull' : 'bear',
    leverageSuggested: dsl.risk.maxLeveragePerTrade,
    ...(dsl.trailingStop ? { trailPct: dsl.trailingStop.pct } : {}),
  };
}
