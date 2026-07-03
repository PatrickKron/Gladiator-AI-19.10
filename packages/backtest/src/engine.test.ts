import { describe, expect, it } from 'vitest';
import { runBacktest, ZERO_COSTS, type BacktestConfig } from './engine.js';
import type { Candle, SetupCandidate } from '@gladiator/strategy-engine';

function c(ts: number, open: number, high: number, low: number, close: number): Candle {
  return { ts: new Date(ts * 3_600_000), open, high, low, close, volume: 100 };
}

/** Deterministischer Test-Evaluator (nur im Test — injiziert ein bekanntes Setup). */
function setupAt(bar: number, partial?: Partial<SetupCandidate>) {
  return (candles: Candle[], i: number): SetupCandidate[] => {
    if (i !== bar) return [];
    return [
      {
        direction: 'long',
        setupType: 'swing',
        entry: candles[i]!.close,
        stopLoss: candles[i]!.close - 10,
        takeProfits: [candles[i]!.close + 10, candles[i]!.close + 20, candles[i]!.close + 30],
        score: 8,
        riskClass: 'low',
        confluence: ['Test'],
        session: 'london',
        brokenLevel: 0,
        structureKind: 'BOS',
        ...partial,
      },
    ];
  };
}

const BASE: Omit<BacktestConfig, 'evaluate'> = {
  initialEquity: 10_000,
  riskPctPerTrade: 1,
  costModel: ZERO_COSTS,
  barsPerYear: 8760,
  tpWeights: [0.5, 0.3, 0.2],
};

describe('Backtest-Engine (look-ahead-frei, netto)', () => {
  it('Long: alle 3 TPs treffen → Gewinn exakt handgerechnet (ohne Kosten)', () => {
    // Entry 100 @bar2, SL 90 (Risk 10), Risiko 1% von 10.000 = 100 → qty 10
    // TP1 110 (50%), TP2 120 (30%), TP3 130 (20%)
    // PnL = 10×0.5×10 + 10×0.3×20 + 10×0.2×30 = 50+60+60 = 170 → R = 1.7
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100), // Signal @2
      c(3, 100, 112, 100, 111),  // TP1 110 getroffen
      c(4, 111, 122, 110, 121),  // TP2 120
      c(5, 121, 132, 120, 131),  // TP3 130
      c(6, 131, 132, 130, 131),
    ];
    const res = runBacktest(candles, { ...BASE, evaluate: setupAt(2) });
    expect(res.trades).toHaveLength(1);
    const t = res.trades[0]!;
    expect(t.netPnl).toBeCloseTo(170, 6);
    expect(t.rMultiple).toBeCloseTo(1.7, 6);
    expect(res.equityCurve[res.equityCurve.length - 1]!.equity).toBeCloseTo(10_170, 6);
  });

  it('Long: SL trifft → Verlust = exakt 1 R (Risikobetrag)', () => {
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
      c(3, 100, 101, 85, 88), // SL 90 gerissen
      c(4, 88, 89, 87, 88),
    ];
    const res = runBacktest(candles, { ...BASE, evaluate: setupAt(2) });
    expect(res.trades[0]!.netPnl).toBeCloseTo(-100, 6);
    expect(res.trades[0]!.rMultiple).toBeCloseTo(-1, 6);
  });

  it('Konservativ: SL und TP im selben Bar → SL zählt (worst case)', () => {
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
      c(3, 100, 115, 85, 100), // beides berührt → SL
    ];
    const res = runBacktest(candles, { ...BASE, evaluate: setupAt(2) });
    expect(res.trades[0]!.rMultiple).toBeCloseTo(-1, 6);
  });

  it('Break-Even nach TP1: Rest wird bei Entry glattgestellt statt im Verlust', () => {
    // TP1 110 trifft (50% raus, +50), dann Rückfall auf Entry 100 → Rest 50% zu 100 (±0)
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
      c(3, 100, 112, 98, 111), // TP1
      c(4, 111, 111, 95, 96),  // fällt durch Entry → BE-Exit für Rest
    ];
    const res = runBacktest(candles, { ...BASE, evaluate: setupAt(2) });
    expect(res.trades[0]!.netPnl).toBeCloseTo(50, 6); // nur der TP1-Teil
  });

  it('Gebühren + Slippage machen aus Brutto exakt berechnetes Netto', () => {
    // Wie Test 1, aber: taker 0.1% je Fill, Slippage 10 bps auf Entry
    // Entry-Fill = 100 × 1.001 = 100.1; Risk-Distanz bleibt SL-basiert: 100.1−90 = 10.1 → qty = 100/10.1
    const costModel = { takerFeeRate: 0.001, makerFeeRate: 0.0005, slippageBps: 10, fundingRatePer8h: 0 };
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
      c(3, 100, 112, 100, 111),
      c(4, 111, 122, 110, 121),
      c(5, 121, 132, 120, 131),
    ];
    const res = runBacktest(candles, { ...BASE, costModel, evaluate: setupAt(2) });
    const t = res.trades[0]!;
    const qty = 100 / 10.1;
    // Slippage wirkt auf BEIDE Seiten: Entry 100×1.001 = 100.1; Exits tp×0.999
    const ex = (tp: number) => tp * 0.999;
    const gross = qty * (0.5 * (ex(110) - 100.1) + 0.3 * (ex(120) - 100.1) + 0.2 * (ex(130) - 100.1));
    const fees =
      100.1 * qty * 0.001 + // Entry-Fee
      (ex(110) * qty * 0.5 + ex(120) * qty * 0.3 + ex(130) * qty * 0.2) * 0.001; // Exit-Fees
    expect(t.grossPnl).toBeCloseTo(gross, 4);
    expect(t.fees).toBeCloseTo(fees, 4);
    expect(t.netPnl).toBeCloseTo(gross - fees, 4);
    expect(t.netPnl).toBeLessThan(170); // netto < brutto-Idealfall
  });

  it('Funding wird über die Haltezeit abgezogen', () => {
    const costModel = { takerFeeRate: 0, makerFeeRate: 0, slippageBps: 0, fundingRatePer8h: 0.001 };
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
      c(3, 100, 101, 99, 100), c(4, 100, 101, 99, 100), c(5, 100, 101, 99, 100),
      c(6, 100, 101, 99, 100), c(7, 100, 101, 99, 100), c(8, 100, 101, 99, 100),
      c(9, 100, 101, 99, 100), c(10, 100, 112, 100, 111), // TP1 nach 8h Haltezeit
      c(11, 111, 122, 110, 121), c(12, 121, 132, 120, 131),
    ];
    const res = runBacktest(candles, { ...BASE, costModel, evaluate: setupAt(2) });
    expect(res.trades[0]!.funding).toBeGreaterThan(0);
    expect(res.trades[0]!.netPnl).toBeLessThan(res.trades[0]!.grossPnl);
  });

  it('MFE/MAE werden in R erfasst', () => {
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
      c(3, 100, 105, 92, 95),  // MAE: −0.8R, MFE +0.5R
      c(4, 95, 112, 94, 111),  // TP1
      c(5, 111, 122, 110, 121), c(6, 121, 132, 120, 131),
    ];
    const res = runBacktest(candles, { ...BASE, evaluate: setupAt(2) });
    expect(res.trades[0]!.maeR).toBeCloseTo(-0.8, 6);
    expect(res.trades[0]!.mfeR).toBeGreaterThanOrEqual(2.9); // lief bis TP3+
  });

  it('offene Position am Datenende wird zum letzten Close geschlossen und markiert', () => {
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
      c(3, 100, 104, 99, 103),
    ];
    const res = runBacktest(candles, { ...BASE, evaluate: setupAt(2) });
    expect(res.trades[0]!.exitReason).toBe('end-of-data');
    expect(res.trades[0]!.netPnl).toBeCloseTo(30, 6); // qty 10 × (103−100)
  });

  it('TP-Schema-Simulation je Trade: A/B/C/D liefern unterschiedliche R (13_ §3)', () => {
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
      c(3, 100, 112, 100, 111), c(4, 111, 122, 110, 121), c(5, 121, 132, 120, 131),
    ];
    const res = runBacktest(candles, { ...BASE, evaluate: setupAt(2) });
    const t = res.trades[0]!;
    // Alle TPs erreicht: A=0.5×1+0.3×2+0.2×3=1.7 | B=0.6+0.6+0.3=1.5 | C=1.0 | D(Runner)=3.0
    expect(t.pnlRTpA).toBeCloseTo(1.7, 6);
    expect(t.pnlRTpB).toBeCloseTo(1.5, 6);
    expect(t.pnlRTpC).toBeCloseTo(1.0, 6);
    expect(t.pnlRTpD).toBeCloseTo(3.0, 6);
  });
});
