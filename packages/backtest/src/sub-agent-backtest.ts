import {
  ema,
  evaluateSubAgentEntry,
  priceSnapshotFromCandles,
  riskClassOf,
  sessionOf,
  type Candle,
  type SubAgentSnapshot,
  type SubAgentSpec,
} from '@gladiator/strategy-engine';
import { DEFAULT_COSTS, runBacktest, type BacktestResult, type CostModel } from './engine.js';

/**
 * Backtest eines Sub-Agenten (Trading-Werkstatt) über echte historische Kerzen.
 *
 * Der Backtest deckt die PREIS-Dimension der Einstiegsregeln ab (Momentum/Dip)
 * und nutzt DIESELBE look-ahead-freie, netto-kostende Engine wie alle anderen
 * Strategien (eine Wahrheit). Ehrlichkeit statt Fake: Bedingungen aus Quellen,
 * die sich nicht bar-für-bar rekonstruieren lassen (Makro/Funding/Kalender/News),
 * werden NICHT stillschweigend ignoriert, sondern in `skippedConditions`
 * ausgewiesen — das Ergebnis ist dann eine Obergrenze der Handelsfrequenz.
 */

const BARS_PER_24H: Record<'15m' | '1h' | '4h' | '1d', number> = { '15m': 96, '1h': 24, '4h': 6, '1d': 1 };
const BARS_PER_YEAR: Record<'15m' | '1h' | '4h' | '1d', number> = { '15m': 35_040, '1h': 8_760, '4h': 2_190, '1d': 365 };
const EMA_TREND = 200;

export type SubAgentBacktestResult = BacktestResult & {
  /** true = nur Preisbedingungen wurden ausgewertet (keine Live-only-Quellen). */
  priceOnly: boolean;
  /** Menschlich lesbare Liste der im Backtest NICHT angewandten Bedingungen. */
  skippedConditions: string[];
  /** true, wenn der Agent überhaupt keine im Backtest auswertbare Preisbedingung hat. */
  notBacktestable: boolean;
};

/** Nennt die Einstiegsbedingungen, die im historischen Backtest nicht rekonstruierbar sind. */
export function subAgentSkippedConditions(spec: SubAgentSpec): string[] {
  const skipped: string[] = [];
  const e = spec.entryRules;
  if (e.macro) skipped.push('Makro (VIX/GRS/DXY) — nur live ausgewertet');
  if (e.funding?.rate) skipped.push('Funding-Rate — nur live ausgewertet');
  if (e.calendar) skipped.push('Wirtschaftskalender — nur live ausgewertet');
  if (e.news?.anyKeyword) skipped.push('News-Keywords — nur live ausgewertet');
  return skipped;
}

function hasPriceCondition(spec: SubAgentSpec): boolean {
  const p = spec.entryRules.price;
  return Boolean(p && (p.changePct24h || p.dipFromHighPct !== undefined));
}

/**
 * Baut einen reinen Preis-Spec (nur die Preisbedingungen bleiben aktiv), damit
 * `evaluateSubAgentEntry` im Backtest ausschließlich Preislogik prüft.
 */
function priceOnlySpec(spec: SubAgentSpec): SubAgentSpec {
  return {
    ...spec,
    dataSources: ['price'],
    entryRules: { price: spec.entryRules.price },
  };
}

export function backtestSubAgent(
  candles: Candle[],
  spec: SubAgentSpec,
  opts: { initialEquity?: number; costModel?: CostModel } = {},
): SubAgentBacktestResult {
  const skippedConditions = subAgentSkippedConditions(spec);
  const priceOnly = skippedConditions.length === 0;
  const initialEquity = opts.initialEquity ?? 10_000;
  const costModel = opts.costModel ?? DEFAULT_COSTS;
  const barsPerYear = BARS_PER_YEAR[spec.timeframe];
  const changeLookback = BARS_PER_24H[spec.timeframe];
  const dipLookback = spec.entryRules.price?.dipLookback ?? 20;

  if (!hasPriceCondition(spec)) {
    // Ehrlich: ohne Preisbedingung gibt es nichts historisch Rekonstruierbares.
    return {
      trades: [],
      equityCurve: candles.length > 0 ? [{ ts: candles[0]!.ts, equity: initialEquity }] : [],
      metrics: {
        tradeCount: 0,
        netPnl: 0,
        winRate: null,
        profitFactor: null,
        expectancy: null,
        avgWinR: null,
        avgLossR: null,
        maxDrawdownPct: 0,
        netReturnPct: 0,
        sharpe: null,
        sortino: null,
      },
      priceOnly,
      skippedConditions,
      notBacktestable: true,
    };
  }

  const pSpec = priceOnlySpec(spec);
  const closes = candles.map((c) => c.close);
  const emaSeries = ema(closes, Math.min(EMA_TREND, Math.max(2, closes.length)));

  const result = runBacktest(candles, {
    evaluate: (cs, i) => {
      const price = priceSnapshotFromCandles(cs, i, { dipLookback, changeLookback });
      if (price.price <= 0) return [];
      const trendEma = emaSeries[i];
      const emaRegime: 'above' | 'below' = trendEma !== null && trendEma !== undefined ? (price.price >= trendEma ? 'above' : 'below') : 'above';
      const snapshot: SubAgentSnapshot = {
        symbol: 'BACKTEST',
        price: price.price,
        changePct24h: price.changePct24h,
        recentHigh: price.recentHigh,
        vix: null,
        grsLabel: null,
        dxyChangePct20d: null,
        fundingRate: null,
        minutesToNextHighImpact: null,
        recentNews: [],
        now: cs[i]!.ts,
      };
      const decision = evaluateSubAgentEntry(pSpec, snapshot);
      if (!decision) return [];
      const rr = spec.exitRules.takeProfitPct / spec.exitRules.stopLossPct;
      const score = Math.min(10, rr * 3);
      return [
        {
          direction: decision.direction,
          setupType: decision.setupType,
          entry: decision.entry,
          stopLoss: decision.stopLoss,
          takeProfits: decision.takeProfits,
          score,
          riskClass: riskClassOf(score),
          confluence: decision.reasons,
          session: sessionOf(cs[i]!.ts),
          emaRegime,
          marketPhase: emaRegime === 'above' ? 'bull' : 'bear',
        },
      ];
    },
    initialEquity,
    riskPctPerTrade: spec.riskParams.riskPctPerTrade,
    costModel,
    barsPerYear,
    tpWeights: [1],
    setupType: spec.setupType,
  });

  return { ...result, priceOnly, skippedConditions, notBacktestable: false };
}
