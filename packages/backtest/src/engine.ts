import type { Candle, SetupCandidate } from '@gladiator/strategy-engine';
import { computeMetrics, type Metrics } from './metrics.js';

/**
 * Look-ahead-freie Backtest-Engine (08_ §3/§3a):
 * - Entscheidung nur am Signal-Bar (der Evaluator sieht intern nur Daten bis i).
 * - Fills erst ab dem FOLGE-Bar; gleiche-Bar-Ambiguität konservativ: SL vor TP.
 * - ALLE Ergebnisse netto: Gebühren je Fill, Slippage auf Fill-Preise,
 *   Funding über die Haltezeit. Ohne Kostenmodell läuft kein Lauf (Pflicht).
 * - Teil-Exits nach TP-Gewichten; nach TP1 Stop auf Break-Even (decker S010).
 * - Je Trade werden zusätzlich die R-Ergebnisse der TP-Schemas A–D simuliert
 *   (13_ §3, Futter für den RAPS-Cluster-Kern).
 */

export type CostModel = {
  /** Taker-Gebühr je Fill (z. B. 0.0004 = 0,04 % Binance-USDT-Perps). */
  takerFeeRate: number;
  makerFeeRate: number;
  /** Slippage in Basispunkten auf Market-Fills. */
  slippageBps: number;
  /** Vereinfachtes Perp-Funding je 8h auf das Notional (Modell-Annahme, konfigurierbar). */
  fundingRatePer8h: number;
};

/** Binance-USDT-Perps-Defaults (Taker 0,04 %, 2 bps Slippage, 0,01 %/8h Funding). */
export const DEFAULT_COSTS: CostModel = {
  takerFeeRate: 0.0004,
  makerFeeRate: 0.0002,
  slippageBps: 2,
  fundingRatePer8h: 0.0001,
};

/** Nur für Tests/Diagnose — im Labor ist das Kostenmodell Pflicht. */
export const ZERO_COSTS: CostModel = {
  takerFeeRate: 0,
  makerFeeRate: 0,
  slippageBps: 0,
  fundingRatePer8h: 0,
};

/** Minimales Setup-Shape, das die Engine braucht (SetupCandidate und DslSetup erfüllen es). */
export type EvaluatorSetup = Omit<SetupCandidate, 'brokenLevel' | 'structureKind'>;
export type Evaluator = (candles: Candle[], i: number) => EvaluatorSetup[];

export type BacktestConfig = {
  evaluate: Evaluator;
  initialEquity: number;
  /** Risiko je Trade in % des Kontos (Positionsgröße via SL-Abstand). */
  riskPctPerTrade: number;
  costModel: CostModel;
  /** Bars pro Jahr (Annualisierung Sharpe/Sortino), z. B. 1h → 8760. */
  barsPerYear: number;
  /** Teil-Exit-Gewichte auf TP1..n (Ausführungs-Schema, Default A = 50/30/20). */
  tpWeights: number[];
  /** Welcher Setup-Typ gehandelt wird, wenn der Evaluator mehrere liefert. */
  setupType?: 'scalp' | 'swing' | 'position';
};

export type BacktestTrade = {
  entryTs: Date;
  exitTs: Date;
  direction: 'long' | 'short';
  setupType: string;
  entry: number;
  /** Ursprünglicher Stop-Loss-Preis des Setups (für Chart-Overlay; unabhängig vom BE-Shift). */
  stopLoss: number;
  /** Take-Profit-Preise des Setups in Reihenfolge (für Chart-Overlay). */
  takeProfits: number[];
  qty: number;
  riskAmount: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  funding: number;
  netPnl: number;
  rMultiple: number;
  mfeR: number;
  maeR: number;
  /** Max. adverse Bewegung als Anteil des Entry-Preises (für Liquidations-Check im Hebel-Gitter). */
  maePct: number;
  barsHeld: number;
  score: number;
  session: string;
  /** Rundum-Analyse: EMA200-Regime, Marktphase und Confluence-Tags am Entry. */
  emaRegime: 'above' | 'below';
  marketPhase: 'bull' | 'bear';
  confluence: string[];
  exitReason: 'tp' | 'sl' | 'be' | 'end-of-data';
  /** R-Ergebnis unter TP-Schema A (50/30/20), B (60/30/10), C (100 % TP1), D (Runner). */
  pnlRTpA: number;
  pnlRTpB: number;
  pnlRTpC: number;
  pnlRTpD: number;
};

export type BacktestResult = {
  trades: BacktestTrade[];
  equityCurve: { ts: Date; equity: number }[];
  metrics: Metrics;
};

const TP_SCHEMAS: Record<'A' | 'B' | 'C' | 'D', number[] | 'runner'> = {
  A: [0.5, 0.3, 0.2],
  B: [0.6, 0.3, 0.1],
  C: [1],
  D: 'runner',
};

/** Gewichte auf die tatsächlich vorhandenen TPs verteilen (Restgewicht auf letzten TP). */
function weightsFor(weights: number[], tpCount: number): number[] {
  if (tpCount >= weights.length) {
    return [...weights, ...Array(tpCount - weights.length).fill(0)];
  }
  const out = weights.slice(0, tpCount);
  const rest = weights.slice(tpCount).reduce((a, b) => a + b, 0);
  out[out.length - 1]! += rest;
  return out;
}

/** R-Ergebnis eines Schemas aus dem beobachteten Trade-Pfad (in R-Einheiten, brutto). */
function schemaR(tpRsHit: number[], totalTps: number, stoppedAfter: number, schema: number[] | 'runner', beAfterTp1: boolean): number {
  // tpRsHit: R-Werte der erreichten TPs in Reihenfolge; stoppedAfter: −1 = SL vor TP1 (voll −1R)
  if (schema === 'runner') {
    // Runner: alles läuft bis zum letzten erreichten TP; ohne TP → −1R; mit BE-Regel 0 nach TP1
    if (tpRsHit.length === 0) return -1;
    if (tpRsHit.length === totalTps) return tpRsHit[tpRsHit.length - 1]!;
    return beAfterTp1 ? 0 : -1; // lief zurück: Runner endet am BE (nach TP1) — konservativ
  }
  const w = weightsFor(schema, totalTps);
  if (tpRsHit.length === 0) return -1; // SL vor TP1: volle Position −1R
  let r = 0;
  let usedWeight = 0;
  for (let k = 0; k < tpRsHit.length; k++) {
    r += w[k]! * tpRsHit[k]!;
    usedWeight += w[k]!;
  }
  const remaining = 1 - usedWeight;
  if (remaining > 1e-9) {
    // Rest wurde ausgestoppt: nach TP1 am Break-Even (0R), sonst −1R
    r += remaining * (beAfterTp1 && tpRsHit.length >= 1 ? 0 : -1);
  }
  return r;
}

export function runBacktest(candles: Candle[], config: BacktestConfig): BacktestResult {
  const { costModel, tpWeights } = config;
  const slip = costModel.slippageBps / 10_000;
  const trades: BacktestTrade[] = [];
  const equityCurve: { ts: Date; equity: number }[] = [];
  let equity = config.initialEquity;

  let i = 0;
  while (i < candles.length) {
    equityCurve.push({ ts: candles[i]!.ts, equity });

    const setups = config.evaluate(candles, i);
    const setup = config.setupType ? setups.find((s) => s.setupType === config.setupType) : setups[0];
    if (!setup) {
      i++;
      continue;
    }

    // ── Entry am Signal-Bar-Close (Market, Slippage gegen uns) ──
    const dirSign = setup.direction === 'long' ? 1 : -1;
    const idealEntry = setup.entry;
    const entryFill = idealEntry * (1 + dirSign * slip);
    const riskDistance = Math.abs(entryFill - setup.stopLoss);
    if (riskDistance <= 0) {
      i++;
      continue;
    }
    const riskAmount = equity * (config.riskPctPerTrade / 100);
    const qty = riskAmount / riskDistance;

    let fees = entryFill * qty * costModel.takerFeeRate;
    let slippageCost = Math.abs(entryFill - idealEntry) * qty;
    let grossPnl = 0;
    let remaining = 1; // Anteil der Position
    let stop = setup.stopLoss;
    const weights = weightsFor(tpWeights, setup.takeProfits.length);
    const tpRs = setup.takeProfits.map((tp) => (tp - entryFill) / riskDistance * dirSign);
    let tpIdx = 0;
    const tpRsHit: number[] = [];
    let mfeR = 0;
    let maeR = 0;
    let exitReason: BacktestTrade['exitReason'] = 'end-of-data';
    let beActive = false;
    let j = i + 1;
    let exitTs = candles[candles.length - 1]!.ts;

    for (; j < candles.length && remaining > 1e-9; j++) {
      const bar = candles[j]!;
      const highR = ((bar.high - entryFill) / riskDistance) * dirSign;
      const lowR = ((bar.low - entryFill) / riskDistance) * dirSign;
      mfeR = Math.max(mfeR, dirSign === 1 ? highR : lowR);
      maeR = Math.min(maeR, dirSign === 1 ? lowR : highR);

      // Konservativ: Stop zuerst prüfen (worst case bei gleichzeitiger Berührung)
      const stopHit = dirSign === 1 ? bar.low <= stop : bar.high >= stop;
      if (stopHit) {
        const exitFill = stop * (1 - dirSign * slip);
        grossPnl += remaining * qty * (exitFill - entryFill) * dirSign;
        fees += Math.abs(exitFill) * remaining * qty * costModel.takerFeeRate;
        slippageCost += Math.abs(exitFill - stop) * remaining * qty;
        exitReason = beActive ? 'be' : 'sl';
        remaining = 0;
        exitTs = bar.ts;
        break;
      }

      // TPs der Reihe nach
      while (tpIdx < setup.takeProfits.length && remaining > 1e-9) {
        const tp = setup.takeProfits[tpIdx]!;
        const tpHit = dirSign === 1 ? bar.high >= tp : bar.low <= tp;
        if (!tpHit) break;
        const part = Math.min(weights[tpIdx]!, remaining);
        const exitFill = tp * (1 - dirSign * slip);
        grossPnl += part * qty * (exitFill - entryFill) * dirSign;
        fees += Math.abs(exitFill) * part * qty * costModel.takerFeeRate;
        slippageCost += Math.abs(exitFill - tp) * part * qty;
        remaining -= part;
        tpRsHit.push(tpRs[tpIdx]!);
        tpIdx++;
        // decker S010: nach TP1 Stop auf Break-Even
        if (tpIdx === 1) {
          stop = entryFill;
          beActive = true;
        }
        exitTs = bar.ts;
        if (remaining <= 1e-9) exitReason = 'tp';
      }
    }

    // Datenende: Rest zum letzten Close glattstellen (ehrlich markiert)
    if (remaining > 1e-9) {
      const last = candles[candles.length - 1]!;
      const exitFill = last.close * (1 - dirSign * slip);
      grossPnl += remaining * qty * (exitFill - entryFill) * dirSign;
      fees += Math.abs(exitFill) * remaining * qty * costModel.takerFeeRate;
      slippageCost += Math.abs(exitFill - last.close) * remaining * qty;
      exitTs = last.ts;
      exitReason = 'end-of-data';
      remaining = 0;
      j = candles.length;
    }

    const entryTs = candles[i]!.ts;
    const barsHeld = Math.max(1, Math.min(j, candles.length) - i);
    const hoursHeld = Math.max(0, (exitTs.getTime() - entryTs.getTime()) / 3_600_000);
    const funding = entryFill * qty * costModel.fundingRatePer8h * (hoursHeld / 8);

    const netPnl = grossPnl - fees - funding;
    const totalTps = setup.takeProfits.length;
    const beAfter = tpRsHit.length >= 1;

    trades.push({
      entryTs,
      exitTs,
      direction: setup.direction,
      setupType: setup.setupType,
      entry: entryFill,
      stopLoss: setup.stopLoss,
      takeProfits: [...setup.takeProfits],
      qty,
      riskAmount,
      grossPnl,
      fees,
      slippage: slippageCost,
      funding,
      netPnl,
      rMultiple: netPnl / riskAmount,
      mfeR,
      maeR,
      maePct: (Math.abs(maeR) * riskDistance) / entryFill,
      barsHeld,
      score: setup.score,
      session: setup.session,
      emaRegime: setup.emaRegime,
      marketPhase: setup.marketPhase,
      confluence: setup.confluence,
      exitReason,
      pnlRTpA: schemaR(tpRsHit, totalTps, 0, TP_SCHEMAS.A, beAfter),
      pnlRTpB: schemaR(tpRsHit, totalTps, 0, TP_SCHEMAS.B, beAfter),
      pnlRTpC: schemaR(tpRsHit, totalTps, 0, TP_SCHEMAS.C, beAfter),
      pnlRTpD: schemaR(tpRsHit, totalTps, 0, TP_SCHEMAS.D, beAfter),
    });

    equity += netPnl;
    // Weiter NACH dem Exit-Bar (keine überlappenden Trades — eine Position zur Zeit)
    i = Math.max(i + 1, Math.min(j, candles.length));
  }

  const fullCurve = [...equityCurve, { ts: candles[candles.length - 1]?.ts ?? new Date(0), equity }];
  const metrics = computeMetrics(trades, fullCurve.map((p) => p.equity), {
    barsPerYear: config.barsPerYear,
  });

  return { trades, equityCurve: fullCurve, metrics };
}
