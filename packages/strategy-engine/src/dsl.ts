import { z } from 'zod';
import { atr, ema, rsi } from './indicators.js';
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
    })
    .strict()
    .refine((c) => c.lt !== undefined || c.gt !== undefined, {
      message: 'RSI-Bedingung braucht lt und/oder gt.',
    }),
  z.object({ trend: z.enum(['EMA200_up', 'EMA200_down']) }).strict(),
]);

export type DslCondition = z.infer<typeof conditionSchema>;

export const instructionDslSchema = z
  .object({
    id: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'id: nur Kleinbuchstaben, Ziffern, Bindestriche'),
    symbol: z.string().min(3),
    timeframe: z.enum(['15m', '1h', '4h', '1d']).default('1h'),
    venueType: z.enum(['cex', 'dex']).default('cex'),
    direction: z.enum(['long', 'short']),
    setupType: z.enum(['scalp', 'swing', 'position']).default('swing'),
    when: z
      .object({
        session: z.enum(['asia', 'london', 'overlap', 'newyork', 'off']).optional(),
        all: z.array(conditionSchema).min(1).max(8),
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
};

/** Wie viele Bars zurück ein BOS/CHoCH-Ereignis für die signal-Bedingung zählt. */
const STRUCTURE_WINDOW_BARS = 12;
/** Nähe zum Retest-EMA in Prozent (wie Pine: low <= EMA * 1.02). */
const RETEST_PROXIMITY_PCT = 2;

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
      const value = rsi(closes)[i];
      if (value == null) return null;
      if (cond.lt !== undefined && !(value < cond.lt)) return null;
      if (cond.gt !== undefined && !(value > cond.gt)) return null;
      matched.push(`dsl:RSI${cond.lt !== undefined ? `<${cond.lt}` : ''}${cond.gt !== undefined ? `>${cond.gt}` : ''}`);
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
  };
}
