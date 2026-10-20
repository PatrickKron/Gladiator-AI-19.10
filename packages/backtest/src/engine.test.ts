import { describe, expect, it } from 'vitest';
import { runBacktest, ZERO_COSTS, type BacktestConfig } from './engine.js';
import type { Candle, SetupCandidate } from '@gladiator/strategy-engine';

function c(ts: number, open: number, high: number, low: number, close: number): Candle {
  return { ts: new Date(ts * 3_600_000), open, high, low, close, volume: 100 };
}

/** Deterministischer Test-Evaluator (nur im Test — injiziert ein bekanntes Setup). */
/** Setup-Erweiterungen aus der DSL (TP-Gewichte, Break-Even-Schalter). */
type SetupExtras = { tpWeights?: number[]; breakEvenAfterTp1?: boolean };

function setupAt(bar: number, partial?: Partial<SetupCandidate> & SetupExtras) {
  return (candles: Candle[], i: number): (SetupCandidate & SetupExtras)[] => {
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
        emaRegime: 'above',
        marketPhase: 'bull',
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

  it('SL/TP-Preise des Setups landen im Trade-Output (fürs Chart-Overlay)', () => {
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
      c(3, 100, 112, 100, 111), c(4, 111, 122, 110, 121), c(5, 121, 132, 120, 131),
    ];
    const res = runBacktest(candles, { ...BASE, evaluate: setupAt(2) });
    const t = res.trades[0]!;
    // Setup @bar2: entry 100, SL 90, TPs 110/120/130 (unverändert vom Signal übernommen)
    expect(t.stopLoss).toBeCloseTo(90, 6);
    expect(t.takeProfits).toEqual([110, 120, 130]);
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
  // ── Gap-realistische Stops: öffnet ein Bar JENSEITS des Stops, gibt es keinen
  // Fill am Stop-Preis — die Order wird erst zum Open ausgeführt (schlechter). ──

  it('Gap-Down über den Long-Stop: Fill zum Open (schlechter als SL), exitReason sl', () => {
    // Entry 100, SL 90, qty 10. Bar 3 öffnet bei 85 (unter SL) → Fill 85 statt 90
    // PnL = 10 × (85 − 100) = −150 → −1,5 R (realistischer Gap-Verlust)
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
      c(3, 85, 86, 80, 82),
      c(4, 82, 83, 81, 82),
    ];
    const res = runBacktest(candles, { ...BASE, evaluate: setupAt(2) });
    const t = res.trades[0]!;
    expect(t.exitReason).toBe('sl');
    expect(t.netPnl).toBeCloseTo(-150, 6);
    expect(t.rMultiple).toBeCloseTo(-1.5, 6);
  });

  it('Gap-Up über den Short-Stop: Fill zum Open', () => {
    // Short Entry 100, SL 110, TPs 90/80/70 → qty 10. Bar 3 öffnet bei 116 → Fill 116
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
      c(3, 116, 120, 114, 118),
    ];
    const res = runBacktest(candles, {
      ...BASE,
      evaluate: setupAt(2, { direction: 'short', stopLoss: 110, takeProfits: [90, 80, 70] }),
    });
    const t = res.trades[0]!;
    expect(t.exitReason).toBe('sl');
    expect(t.netPnl).toBeCloseTo(-160, 6); // 10 × (100 − 116)
  });

  it('Open exakt auf dem Stop zählt als Gap-Fill (= Stop-Preis, kein Unterschied)', () => {
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
      c(3, 90, 95, 88, 92),
    ];
    const res = runBacktest(candles, { ...BASE, evaluate: setupAt(2) });
    expect(res.trades[0]!.netPnl).toBeCloseTo(-100, 6);
  });

  it('Gap-Fill bekommt zusätzlich Slippage (auf den Open-Preis)', () => {
    // Slippage 10 bps: Entry 100.1, qty = 100/10.1; Exit = 85 × 0.999
    const costModel = { takerFeeRate: 0, makerFeeRate: 0, slippageBps: 10, fundingRatePer8h: 0 };
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
      c(3, 85, 86, 80, 82),
    ];
    const res = runBacktest(candles, { ...BASE, costModel, evaluate: setupAt(2) });
    const t = res.trades[0]!;
    const qty = 100 / 10.1;
    expect(t.grossPnl).toBeCloseTo(qty * (85 * 0.999 - 100.1), 6);
    expect(t.slippage).toBeCloseTo(qty * (0.1 + 85 * 0.001), 6); // Entry 0,1 + Exit 0,085 je Einheit
  });

  it('Break-Even-Stop mit Gap: Rest wird zum (schlechteren) Open geschlossen, exitReason be', () => {
    // TP1 110 (50 % → +50), Bar 4 öffnet bei 95 unter dem BE-Stop 100 → Rest 5 × (95 − 100) = −25
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
      c(3, 100, 112, 101, 111),
      c(4, 95, 96, 90, 92),
    ];
    const res = runBacktest(candles, { ...BASE, evaluate: setupAt(2) });
    const t = res.trades[0]!;
    expect(t.exitReason).toBe('be');
    expect(t.netPnl).toBeCloseTo(25, 6);
  });

  it('Gap ÜBER den TP: Fill bleibt konservativ am TP-Preis (kein Gap-Bonus)', () => {
    // Bar 3 öffnet bei 125 (über TP1 110 und TP2 120) → Fills 110/120, nicht 125
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
      c(3, 125, 126, 124, 125),
      c(4, 125, 132, 124, 131),
    ];
    const res = runBacktest(candles, { ...BASE, evaluate: setupAt(2) });
    expect(res.trades[0]!.netPnl).toBeCloseTo(170, 6);
  });

  // ── Historisches Funding (fundingSeries): Summe über Funding-Zeitpunkte in
  // (entryTs, exitTs] von Notional × Rate × Vorzeichen (Long zahlt positive Rate). ──

  /** 13 flache Bars, TP1–3 erst in Bars 10–12 → Trade läuft von ts 2h bis 12h. */
  function fundingCandles(): Candle[] {
    const flat = Array.from({ length: 10 }, (_, k) => c(k, 100, 101, 99, 100));
    return [...flat, c(10, 100, 112, 100, 111), c(11, 111, 122, 110, 121), c(12, 121, 132, 120, 131)];
  }
  const NO_FLAT_FUNDING = { takerFeeRate: 0, makerFeeRate: 0, slippageBps: 0, fundingRatePer8h: 0.5 };
  const h = (n: number) => new Date(n * 3_600_000);

  it('fundingSeries: Long zahlt positive Raten im Fenster (entryTs, exitTs]', () => {
    // Notional = 100 × 10 = 1000. Zeitpunkte: 2h (= entryTs, exklusiv), 4h, 12h (= exitTs, inklusiv), 13h (danach)
    const res = runBacktest(fundingCandles(), {
      ...BASE,
      costModel: NO_FLAT_FUNDING, // darf bei vorhandener Serie NICHT greifen
      evaluate: setupAt(2),
      fundingSeries: [
        { ts: h(2), rate: 0.01 },
        { ts: h(4), rate: 0.001 },
        { ts: h(12), rate: 0.002 },
        { ts: h(13), rate: 0.05 },
      ],
    });
    const t = res.trades[0]!;
    expect(t.exitTs.getTime()).toBe(h(12).getTime());
    expect(t.funding).toBeCloseTo(1000 * (0.001 + 0.002), 9); // 3 $
    expect(t.netPnl).toBeCloseTo(170 - 3, 6);
  });

  it('fundingSeries: Short erhält positive Raten → Funding negativ (Ertrag)', () => {
    const candles = [
      ...Array.from({ length: 10 }, (_, k) => c(k, 100, 101, 99, 100)),
      c(10, 100, 100, 88, 89), c(11, 89, 90, 78, 79), c(12, 79, 80, 68, 69),
    ];
    const res = runBacktest(candles, {
      ...BASE,
      costModel: NO_FLAT_FUNDING,
      evaluate: setupAt(2, { direction: 'short', stopLoss: 110, takeProfits: [90, 80, 70] }),
      fundingSeries: [{ ts: h(4), rate: 0.001 }, { ts: h(12), rate: 0.002 }],
    });
    const t = res.trades[0]!;
    expect(t.funding).toBeCloseTo(-3, 9);
    expect(t.netPnl).toBeCloseTo(170 + 3, 6);
  });

  it('fundingSeries: negative Rate → Long erhält Funding', () => {
    const res = runBacktest(fundingCandles(), {
      ...BASE,
      costModel: NO_FLAT_FUNDING,
      evaluate: setupAt(2),
      fundingSeries: [{ ts: h(8), rate: -0.0005 }],
    });
    expect(res.trades[0]!.funding).toBeCloseTo(-0.5, 9);
  });

  it('leere fundingSeries → 0 Funding (Serie ist die Wahrheit, kein Fallback in der Engine)', () => {
    const res = runBacktest(fundingCandles(), { ...BASE, costModel: NO_FLAT_FUNDING, evaluate: setupAt(2), fundingSeries: [] });
    expect(res.trades[0]!.funding).toBe(0);
  });

  it('ohne fundingSeries bleibt das flache Modell (Rate × Haltezeit/8h) unverändert', () => {
    const costModel = { takerFeeRate: 0, makerFeeRate: 0, slippageBps: 0, fundingRatePer8h: 0.001 };
    const res = runBacktest(fundingCandles(), { ...BASE, costModel, evaluate: setupAt(2) });
    // 1000 Notional × 0.001 × (10h / 8h)
    expect(res.trades[0]!.funding).toBeCloseTo(1000 * 0.001 * (10 / 8), 9);
  });
});

describe('Backtest-Engine: Trailing-Stop (dieselbe trailStep-Funktion wie live)', () => {
  // Entry 100, SL 90 → qty 10 (1 % von 10.000 / 10); TPs weit weg, damit nur der Trail greift.
  const far = { takeProfits: [200, 300] };

  it('zieht nach jeder abgeschlossenen Kerze nach — nie innerhalb derselben Kerze (look-ahead-frei)', () => {
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100), // Signal @2
      c(3, 100, 110, 104, 108), // Hoch 110 → Stop erst AB Bar 4 = 104,5 (Tief 104 löst hier NICHT aus)
      c(4, 108, 112, 105, 111), // Stop 104,5 hält; danach Hoch 112 → 106,4
      c(5, 111, 111, 106, 107), // Tief 106 < 106,4 → Ausstieg am nachgezogenen Stop
      c(6, 107, 108, 106, 107),
    ];
    const res = runBacktest(candles, { ...BASE, evaluate: setupAt(2, { ...far, trailPct: 5 }) });
    const t = res.trades[0]!;
    expect(t.exitReason).toBe('trail');
    expect(t.exitTs.getTime()).toBe(5 * 3_600_000);
    expect(t.grossPnl).toBeCloseTo(10 * 6.4, 6);
  });

  it('Short spiegelbildlich: Stop folgt dem Tief nach unten', () => {
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
      c(3, 100, 96, 90, 92), // Tief 90 → Stop ab Bar 4 = 94,5
      c(4, 92, 95, 91, 94), // Hoch 95 ≥ 94,5 → raus
    ];
    const res = runBacktest(candles, {
      ...BASE,
      evaluate: setupAt(2, { direction: 'short', stopLoss: 110, takeProfits: [50], trailPct: 5 }),
    });
    const t = res.trades[0]!;
    expect(t.exitReason).toBe('trail');
    expect(t.grossPnl).toBeCloseTo(10 * (100 - 94.5), 6);
  });

  it('Break-Even nach TP1 lockert einen schon nachgezogenen Stop nie', () => {
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
      c(3, 100, 112, 105, 111), // TP1 110 (50 %) → BE 100; Trail ab Bar 4: 112 × 0,95 = 106,4
      c(4, 111, 111, 101, 102), // Tief 101: über BE 100, aber unter 106,4 → raus am Trail
    ];
    const res = runBacktest(candles, { ...BASE, evaluate: setupAt(2, { takeProfits: [110, 300], trailPct: 5 }) });
    const t = res.trades[0]!;
    expect(t.exitReason).toBe('trail');
    // 5 × (110 − 100) + 5 × (106,4 − 100)
    expect(t.grossPnl).toBeCloseTo(50 + 32, 6);
  });

  it('Labor-Vorgabe (config.trailPct) gilt, wenn das Setup keinen eigenen Wert hat; Setup-Wert gewinnt', () => {
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
      c(3, 100, 110, 104, 108),
      c(4, 108, 109, 103, 104), // 10 % Trail: Stop 99 → hält; 5 % Trail: 104,5 → raus
      c(5, 104, 105, 103, 104),
    ];
    const viaConfig = runBacktest(candles, { ...BASE, trailPct: 5, evaluate: setupAt(2, far) });
    expect(viaConfig.trades[0]!.exitReason).toBe('trail');
    const setupWins = runBacktest(candles, { ...BASE, trailPct: 5, evaluate: setupAt(2, { ...far, trailPct: 10 }) });
    expect(setupWins.trades[0]!.exitReason).toBe('end-of-data');
  });

  it('ohne Trailing bleibt alles wie bisher (Stop fix)', () => {
    const candles = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
      c(3, 100, 110, 104, 108), c(4, 108, 109, 103, 104), c(5, 104, 105, 103, 104),
    ];
    expect(runBacktest(candles, { ...BASE, evaluate: setupAt(2, far) }).trades[0]!.exitReason).toBe('end-of-data');
  });
});

describe('Backtest-Engine: TP-Gewichte je Setup + Break-Even-Schalter (DSL)', () => {
  const allTps = [
    c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100), // Signal @2
    c(3, 100, 112, 100, 111), // TP1 110
    c(4, 111, 122, 110, 121), // TP2 120
    c(5, 121, 132, 120, 131), // TP3 130
    c(6, 131, 132, 130, 131),
  ];

  it('Setup-Gewichte haben Vorrang vor config.tpWeights (Teil-Exits exakt handgerechnet)', () => {
    // qty 10; 20 % @110, 30 % @120, 50 % @130 → 10×(0.2×10 + 0.3×20 + 0.5×30) = 230
    const res = runBacktest(allTps, { ...BASE, evaluate: setupAt(2, { tpWeights: [0.2, 0.3, 0.5] }) });
    expect(res.trades[0]!.netPnl).toBeCloseTo(230, 6);
    // Ohne Setup-Gewichte: Config-Schema 50/30/20 → 170 (unverändert)
    expect(runBacktest(allTps, { ...BASE, evaluate: setupAt(2) }).trades[0]!.netPnl).toBeCloseTo(170, 6);
  });

  it('Setup-Gewichte bei 2 TPs: 70/30', () => {
    const res = runBacktest(allTps, { ...BASE, evaluate: setupAt(2, { takeProfits: [110, 120], tpWeights: [0.7, 0.3] }) });
    // 10×(0.7×10 + 0.3×20) = 130
    expect(res.trades[0]!.netPnl).toBeCloseTo(130, 6);
    expect(res.trades[0]!.exitReason).toBe('tp');
  });

  const tp1ThenCrash = [
    c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
    c(3, 100, 112, 98, 111), // TP1 110 (50 %)
    c(4, 111, 111, 95, 96), // fällt durch Entry 100, aber nicht bis SL 90
    c(5, 96, 97, 85, 86), // SL 90 gerissen
  ];

  it('breakEvenAfterTp1=false: Stop bleibt nach TP1 am Original-SL (kein BE-Exit)', () => {
    const res = runBacktest(tp1ThenCrash, { ...BASE, evaluate: setupAt(2, { breakEvenAfterTp1: false }) });
    const t = res.trades[0]!;
    // 5 × (+10) + 5 × (90 − 100) = 50 − 50 = 0; Exit am Original-Stop
    expect(t.netPnl).toBeCloseTo(0, 6);
    expect(t.exitReason).toBe('sl');
    expect(t.exitPrice).toBe(90);
    // Gegenprobe Default: BE nach TP1 → Rest bei 100 raus (+50), exitReason be
    const def = runBacktest(tp1ThenCrash, { ...BASE, evaluate: setupAt(2) }).trades[0]!;
    expect(def.netPnl).toBeCloseTo(50, 6);
    expect(def.exitReason).toBe('be');
  });

  it('breakEvenAfterTp1=false: TP-Schema-Simulationen rechnen den Rest mit −1R statt 0R', () => {
    const t = runBacktest(tp1ThenCrash, { ...BASE, evaluate: setupAt(2, { breakEvenAfterTp1: false }) }).trades[0]!;
    // Schema A: 0.5×1R + 0.5×(−1R) = 0
    expect(t.pnlRTpA).toBeCloseTo(0, 6);
    const def = runBacktest(tp1ThenCrash, { ...BASE, evaluate: setupAt(2) }).trades[0]!;
    expect(def.pnlRTpA).toBeCloseTo(0.5, 6);
  });

  it('breakEvenAfterTp1=true verhält sich wie ohne Angabe', () => {
    const a = runBacktest(tp1ThenCrash, { ...BASE, evaluate: setupAt(2, { breakEvenAfterTp1: true }) }).trades[0]!;
    const b = runBacktest(tp1ThenCrash, { ...BASE, evaluate: setupAt(2) }).trades[0]!;
    expect(a.netPnl).toBeCloseTo(b.netPnl, 9);
    expect(a.exitReason).toBe(b.exitReason);
  });
});
