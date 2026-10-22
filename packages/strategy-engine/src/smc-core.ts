import { atr, ema, rsi, sma } from './indicators.js';
import { detectStructure } from './structure.js';
import { detectFvgs } from './zones.js';
import { dealingRangeAt, detectLiquidity } from './liquidity.js';
import { computeScore, riskClassOf, type RiskClass, type TradingSession } from './scoring.js';
import { isActiveSession, sessionOf } from './session.js';
import type { Candle } from './types.js';

/**
 * Referenz-Strategie „SMC Core" — Port der Logik aus Patricks Pine-Script
 * SmartMoney_BOS_CHOCH_Strategy.pine (05_ §4):
 *
 *   longEntry = (bosLong OR chochLong) AND trendUp AND retestLong AND rsiOk AND volOk
 *
 * Der RETEST (Pullback an Bruchlevel + Nähe EMA-Pullback + bestätigende Kerze)
 * ist PFLICHT — das war der Qualitätshebel, der den alten Python-Generatoren
 * fehlte. Scores werden IMMER echt berechnet (scoring.ts), nie hartkodiert.
 */

export type SmcCoreParams = {
  swingLeftBars: number;
  swingRightBars: number;
  emaTrendPeriod: number;
  emaPullbackPeriod: number;
  rsiPeriod: number;
  rsiLongMin: number;
  rsiLongMax: number;
  rsiShortMin: number;
  rsiShortMax: number;
  volumeMaPeriod: number;
  atrPeriod: number;
  /** Wie viele Bars nach BOS/CHoCH ein Retest zählt. */
  retestWindowBars: number;
  /** Nähe zum Pullback-EMA in Prozent (Pine: low <= EMA50 * 1.02). */
  emaProximityPct: number;
  /**
   * RSI wird als Extremwert der letzten N Bars geprüft (Pullback-Tief),
   * nicht am Bestätigungs-Bar: Die bullishe Retest-Kerze hat den RSI meist
   * schon über 50 gezogen. Messung auf echten Kerzen (07/2026, 9 Kombis à
   * 780 Bars): am Bar geprüft 0 Treffer, Pullback-Tief (5 Bars) 2–12 Treffer.
   * Kalibrierbar; Feinabstimmung folgt im Backtesting (Phase 3).
   */
  rsiLookbackBars: number;
  /**
   * Experiment-Flags (Phase 1b, Labor): Sweep bzw. Discount/Premium als Zusatz-Confluence
   * (+0,5 je). Standard aus — ins Produktiv-Scoring erst nach belegtem Vorsprung im Backtest.
   */
  sweepConfluence?: boolean;
  discountConfluence?: boolean;
  /** Fenster (Bars vor dem Entry), in dem ein Sweep in Trendrichtung zählt. */
  sweepWindowBars?: number;
};

/** Defaults gemäß 05_ (EMA200/EMA50, RSI-Band 30–50 long / 50–70 short, Pivot 8/8). */
export const SMC_CORE_DEFAULTS: SmcCoreParams = {
  swingLeftBars: 8,
  swingRightBars: 8,
  emaTrendPeriod: 200,
  emaPullbackPeriod: 50,
  rsiPeriod: 14,
  rsiLongMin: 30,
  rsiLongMax: 50,
  rsiShortMin: 50,
  rsiShortMax: 70,
  volumeMaPeriod: 20,
  atrPeriod: 14,
  retestWindowBars: 12,
  emaProximityPct: 2,
  rsiLookbackBars: 5,
};

/** Multi-Setup-Staffel (05_ §5): ATR-basierte SLs, R-Multiple-TPs, RR-Minima. */
const SETUPS = [
  { type: 'scalp' as const, slAtrMult: 1.0, tpRs: [1, 2], rrMin: 1.2 },
  { type: 'swing' as const, slAtrMult: 1.5, tpRs: [1, 2, 3], rrMin: 2.0 },
  { type: 'position' as const, slAtrMult: 2.5, tpRs: [2, 3, 5], rrMin: 3.0 },
];

export type SetupCandidate = {
  direction: 'long' | 'short';
  setupType: 'scalp' | 'swing' | 'position';
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  score: number;
  riskClass: RiskClass;
  confluence: string[];
  session: TradingSession;
  brokenLevel: number;
  structureKind: 'BOS' | 'CHoCH';
  /** EMA200-Regime am Entry: Preis über oder unter dem Trend-EMA (Rundum-Analyse). */
  emaRegime: 'above' | 'below';
  /** Marktphase aus der Struktur (letztes Break-Ereignis): bull- oder bear-Phase. */
  marketPhase: 'bull' | 'bear';
  /** Optionaler Trailing-Stop-Abstand in % (Strategie-Exit; Backtest und Live nutzen trailStep). */
  trailPct?: number;
};

export type SmcContext = {
  /** Trend der nächsthöheren Timeframe (aus Multi-TF-Scan); fehlt → neutral. */
  higherTfTrend?: 'bull' | 'bear' | 'neutral';
};

function round(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

/** Bewertet GENAU den Bar `i` (nur Daten bis i — look-ahead-frei). */
export function evaluateSmcCoreAt(
  allCandles: Candle[],
  i: number,
  params: SmcCoreParams = SMC_CORE_DEFAULTS,
  ctx: SmcContext = {},
): SetupCandidate[] {
  if (i < 1 || i >= allCandles.length) return [];
  // Nur Vergangenheit + aktueller Bar — Zukunft ist physisch abgeschnitten.
  const candles = allCandles.slice(0, i + 1);
  const bar = candles[i]!;

  const closes = candles.map((c) => c.close);
  const rsiSeries = rsi(closes, params.rsiPeriod);
  const emaTrendMaybe = ema(closes, params.emaTrendPeriod)[i];
  const emaPullMaybe = ema(closes, params.emaPullbackPeriod)[i];
  const rsiMaybe = rsiSeries[i];
  const volMaMaybe = sma(candles.map((c) => c.volume), params.volumeMaPeriod)[i];
  const atrMaybe = atr(candles, params.atrPeriod)[i];
  if (emaTrendMaybe == null || emaPullMaybe == null || rsiMaybe == null || volMaMaybe == null || atrMaybe == null) {
    return [];
  }
  const emaTrend = emaTrendMaybe;
  const emaPull = emaPullMaybe;
  const volMa = volMaMaybe;
  const atrNow = atrMaybe;
  if (atrNow <= 0) return [];

  const trendUp = bar.close > emaTrend;
  const trendDown = bar.close < emaTrend;
  const volOk = bar.volume > volMa;
  if (!volOk) return [];

  const events = detectStructure(candles, {
    leftBars: params.swingLeftBars,
    rightBars: params.swingRightBars,
  });

  const direction: 'long' | 'short' | null = trendUp ? 'long' : trendDown ? 'short' : null;
  if (!direction) return [];

  // Letztes Struktur-Ereignis in Trendrichtung innerhalb des Retest-Fensters
  const wanted = direction === 'long' ? 'bullish' : 'bearish';
  const event = [...events]
    .reverse()
    .find((e) => e.direction === wanted && e.index <= i && e.index >= i - params.retestWindowBars);
  if (!event) return [];

  // Retest-Bedingungen (Pine): Rückkehr zum Bruchlevel + Nähe Pullback-EMA + bestätigende Kerze
  const proximity = params.emaProximityPct / 100;
  const bullishBar = bar.close > bar.open;
  const bearishBar = bar.close < bar.open;
  const retestLong =
    direction === 'long' &&
    bar.low <= event.brokenLevel &&
    bar.low <= emaPull * (1 + proximity) &&
    bullishBar &&
    bar.close >= event.brokenLevel;
  const retestShort =
    direction === 'short' &&
    bar.high >= event.brokenLevel &&
    bar.high >= emaPull * (1 - proximity) &&
    bearishBar &&
    bar.close <= event.brokenLevel;
  if (!(retestLong || retestShort)) return [];

  // RSI: Extremwert des Pullbacks (letzte rsiLookbackBars) muss im Band liegen
  const lookback = Math.max(1, params.rsiLookbackBars);
  const rsiWindow = rsiSeries
    .slice(Math.max(0, i - lookback + 1), i + 1)
    .filter((v): v is number => v != null);
  if (rsiWindow.length === 0) return [];
  const rsiExtreme = direction === 'long' ? Math.min(...rsiWindow) : Math.max(...rsiWindow);
  const rsiOk =
    direction === 'long'
      ? rsiExtreme >= params.rsiLongMin && rsiExtreme <= params.rsiLongMax
      : rsiExtreme >= params.rsiShortMin && rsiExtreme <= params.rsiShortMax;
  if (!rsiOk) return [];

  // Optionale Confluences
  const fvgs = detectFvgs(candles).filter((z) => z.createdAt <= i && z.filledAt === undefined);
  const fvgTarget =
    direction === 'long'
      ? fvgs.some((z) => z.bottom > bar.close)
      : fvgs.some((z) => z.top < bar.close);

  const session = sessionOf(bar.ts);
  const higherTf: 'aligned' | 'neutral' | 'opposed' =
    !ctx.higherTfTrend || ctx.higherTfTrend === 'neutral'
      ? 'neutral'
      : (ctx.higherTfTrend === 'bull') === (direction === 'long')
        ? 'aligned'
        : 'opposed';

  // Experiment-Flags (Labor, Standard aus): Sweep/Discount als Zusatz-Confluence — nur auf Kerzen ≤ i.
  let liquiditySweep = false;
  let dealingRangeFavorable = false;
  if (params.sweepConfluence || params.discountConfluence) {
    const liq = detectLiquidity(candles, { leftBars: params.swingLeftBars, rightBars: params.swingRightBars });
    if (params.sweepConfluence) {
      const window = params.sweepWindowBars ?? 20;
      const side = direction === 'long' ? 'sell-side' : 'buy-side';
      liquiditySweep = liq.sweeps.some((s) => s.side === side && s.index <= i && s.index >= i - window);
    }
    if (params.discountConfluence) {
      const range = dealingRangeAt(candles, liq.swings, i);
      dealingRangeFavorable = range !== null && (direction === 'long' ? range.zone === 'discount' : range.zone === 'premium');
    }
  }

  const entry = bar.close;
  const candidates: SetupCandidate[] = [];

  for (const setup of SETUPS) {
    const slDistance = setup.slAtrMult * atrNow;
    const stopLoss = direction === 'long' ? entry - slDistance : entry + slDistance;
    const takeProfits = setup.tpRs.map((r) =>
      round(direction === 'long' ? entry + r * slDistance : entry - r * slDistance),
    );
    const lastTp = takeProfits[takeProfits.length - 1]!;
    const rr = Math.abs(lastTp - entry) / slDistance;
    if (rr < setup.rrMin) continue; // RR-Minimum je Setup (05_ §5)

    const { score, confluence } = computeScore({
      trendAligned: true,
      structureBreak: true,
      validRetest: true,
      rsiInBand: true,
      volumeConfirmed: true,
      fvgTarget,
      sessionActive: isActiveSession(session),
      rrAtLeast2: rr >= 2,
      higherTf,
      counterConfluence: false,
      liquiditySweep,
      dealingRangeFavorable,
    });

    // Ausspiel-Schwelle (05_ §6): unter 6 wird verworfen
    if (score < 6) continue;

    candidates.push({
      direction,
      setupType: setup.type,
      entry: round(entry),
      stopLoss: round(stopLoss),
      takeProfits,
      score,
      riskClass: riskClassOf(score),
      confluence,
      session,
      brokenLevel: event.brokenLevel,
      structureKind: event.kind,
      emaRegime: bar.close > emaTrend ? 'above' : 'below',
      marketPhase: event.direction === 'bullish' ? 'bull' : 'bear',
    });
  }

  return candidates;
}
