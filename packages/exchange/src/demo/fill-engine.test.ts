import { describe, expect, it } from 'vitest';
import {
  DEMO_MAKER_FEE,
  DEMO_START_BALANCE,
  DEMO_TAKER_FEE,
  addToPosition,
  availableBalance,
  checkTrigger,
  computeCloseNumbers,
  midPrice,
  restingLimitFill,
  roundToStep,
  simulateMarketFill,
  simulateLimitPlacement,
  type OrderBookSnapshot,
} from './fill-engine.js';

/**
 * Pure Demo-Fill-Engine: Ausführung wird gegen ein ECHTES Orderbuch simuliert
 * (Spread + Slippage entstehen aus der Buchtiefe selbst, deterministisch —
 * kein Zufall). Diese Tests definieren das Verhalten VOR der Implementierung.
 */

/** Deterministisches Testbuch: Spread 100 (Bid 50_000 / Ask 50_100). */
function book(): OrderBookSnapshot {
  return {
    symbol: 'BTC/USDT',
    ts: 1_751_968_800_000,
    bids: [
      { price: 50_000, qty: 0.5 },
      { price: 49_950, qty: 1 },
      { price: 49_900, qty: 2 },
    ],
    asks: [
      { price: 50_100, qty: 0.5 },
      { price: 50_150, qty: 1 },
      { price: 50_200, qty: 2 },
    ],
  };
}

describe('midPrice', () => {
  it('Mitte aus Best-Bid/Ask', () => {
    expect(midPrice(book())).toBe(50_050);
  });
  it('leeres Buch → null (ehrlich, kein erfundener Preis)', () => {
    expect(midPrice({ symbol: 'X', ts: 0, bids: [], asks: [] })).toBeNull();
  });
});

describe('simulateMarketFill', () => {
  it('Market-Buy läuft durch die Asks: Spread + Tiefe = Slippage', () => {
    const fill = simulateMarketFill(book(), 'buy', 1);
    expect(fill).not.toBeNull();
    // 0.5 @ 50_100 + 0.5 @ 50_150 → VWAP 50_125
    expect(fill!.filledQty).toBe(1);
    expect(fill!.avgPrice).toBeCloseTo(50_125, 8);
    expect(fill!.notional).toBeCloseTo(50_125, 8);
    expect(fill!.feeRole).toBe('taker');
    expect(fill!.fee).toBeCloseTo(50_125 * DEMO_TAKER_FEE, 8);
    // Slippage ggü. Mid (50_050): (50_125 − 50_050) × 1
    expect(fill!.slippageVsMid).toBeCloseTo(75, 8);
  });

  it('Market-Sell läuft durch die Bids', () => {
    const fill = simulateMarketFill(book(), 'sell', 1);
    // 0.5 @ 50_000 + 0.5 @ 49_950 → VWAP 49_975
    expect(fill!.avgPrice).toBeCloseTo(49_975, 8);
    // Sell-Kosten ggü. Mid: (50_050 − 49_975) × 1 — VORZEICHEN: Kosten positiv
    expect(fill!.slippageVsMid).toBeCloseTo(75, 8);
  });

  it('Slippage ist vorzeichenbehaftet: Preisverbesserung wäre negativ', () => {
    // Buy zum Preis UNTER Mid (nur theoretisch, z. B. Maker-Fill) → Verbesserung < 0
    const b = book();
    const fill = restingLimitFill(b, 'sell', 0.4, 49_990);
    // Sell @ 49_990 bei Mid 50_050 → Kosten (50_050 − 49_990) × 0.4 = +24 (adverse selection)
    expect(fill!.slippageVsMid).toBeCloseTo(24, 8);
  });

  it('mehr Menge als sichtbare Tiefe → Partial Fill (Rest bleibt ungefüllt)', () => {
    const fill = simulateMarketFill(book(), 'buy', 10);
    expect(fill!.filledQty).toBeCloseTo(3.5, 8); // 0.5 + 1 + 2
    expect(fill!.filledQty).toBeLessThan(10);
  });

  it('leeres Buch → null', () => {
    expect(simulateMarketFill({ symbol: 'X', ts: 0, bids: [], asks: [] }, 'buy', 1)).toBeNull();
  });
});

describe('simulateLimitPlacement', () => {
  it('Buy-Limit unter Best-Ask kreuzt nicht → ruht komplett, kein Fill', () => {
    const r = simulateLimitPlacement(book(), 'buy', 1, 50_050);
    expect(r.fill).toBeNull();
    expect(r.restingQty).toBe(1);
  });

  it('Buy-Limit über Best-Ask kreuzt → Taker-Fill bis zur Limit-Grenze, Rest ruht', () => {
    // Limit 50_150: füllt 0.5 @ 50_100 + 1 @ 50_150 = 1.5, Rest 0.5 ruht
    const r = simulateLimitPlacement(book(), 'buy', 2, 50_150);
    expect(r.fill).not.toBeNull();
    expect(r.fill!.filledQty).toBeCloseTo(1.5, 8);
    expect(r.fill!.feeRole).toBe('taker');
    // Preisverbesserung ist real: bezahlt werden die Ask-Level, nicht das Limit
    expect(r.fill!.avgPrice).toBeCloseTo((0.5 * 50_100 + 1 * 50_150) / 1.5, 8);
    expect(r.restingQty).toBeCloseTo(0.5, 8);
  });

  it('Sell-Limit unter Best-Bid kreuzt → Fill gegen Bids', () => {
    const r = simulateLimitPlacement(book(), 'sell', 0.4, 49_990);
    expect(r.fill!.filledQty).toBeCloseTo(0.4, 8);
    expect(r.fill!.avgPrice).toBeCloseTo(50_000, 8);
    expect(r.restingQty).toBe(0);
  });
});

describe('restingLimitFill (Monitor-Tick, Maker)', () => {
  it('Buy-Limit 50_150: sichtbare Ask-Menge ≤ Limit füllt ZUM LIMITPREIS als Maker', () => {
    // Asks ≤ 50_150: 0.5 + 1 = 1.5 verfügbar
    const fill = restingLimitFill(book(), 'buy', 2, 50_150);
    expect(fill).not.toBeNull();
    expect(fill!.filledQty).toBeCloseTo(1.5, 8);
    expect(fill!.avgPrice).toBe(50_150); // ruhende Order füllt zu ihrem Limit
    expect(fill!.feeRole).toBe('maker');
    expect(fill!.fee).toBeCloseTo(1.5 * 50_150 * DEMO_MAKER_FEE, 8);
  });

  it('Buy-Limit unter dem Markt (kreuzt nicht) → kein Fill', () => {
    expect(restingLimitFill(book(), 'buy', 1, 50_050)).toBeNull();
  });

  it('Sell-Limit 49_940: Bid-Menge ≥ Limit füllt (0.5 + 1)', () => {
    const fill = restingLimitFill(book(), 'sell', 5, 49_940);
    expect(fill!.filledQty).toBeCloseTo(1.5, 8);
    expect(fill!.avgPrice).toBe(49_940);
  });
});

describe('checkTrigger (SL/TP gegen Best-Bid/Ask)', () => {
  // Long schließt per Sell → relevanter Preis ist der Best-Bid (50_000)
  it('Long-SL triggert, wenn Best-Bid ≤ Stop', () => {
    expect(checkTrigger('long', 'stop', 50_000, book())).toBe(true);
    expect(checkTrigger('long', 'stop', 49_999, book())).toBe(false);
  });
  it('Long-TP triggert, wenn Best-Bid ≥ Ziel', () => {
    expect(checkTrigger('long', 'takeProfit', 50_000, book())).toBe(true);
    expect(checkTrigger('long', 'takeProfit', 50_001, book())).toBe(false);
  });
  // Short schließt per Buy → relevanter Preis ist der Best-Ask (50_100)
  it('Short-SL triggert, wenn Best-Ask ≥ Stop', () => {
    expect(checkTrigger('short', 'stop', 50_100, book())).toBe(true);
    expect(checkTrigger('short', 'stop', 50_101, book())).toBe(false);
  });
  it('Short-TP triggert, wenn Best-Ask ≤ Ziel', () => {
    expect(checkTrigger('short', 'takeProfit', 50_100, book())).toBe(true);
    expect(checkTrigger('short', 'takeProfit', 50_099, book())).toBe(false);
  });
  it('leeres Buch → nie ein Trigger (ehrlich: kein Preis, keine Aktion)', () => {
    const empty: OrderBookSnapshot = { symbol: 'X', ts: 0, bids: [], asks: [] };
    expect(checkTrigger('long', 'stop', 50_000, empty)).toBe(false);
  });
});

describe('computeCloseNumbers (Netto wie Bestand: gross − Fees − Funding)', () => {
  it('Long-Gewinn: PnL aus echten Fill-Preisen, Slippage NICHT doppelt abgezogen', () => {
    const r = computeCloseNumbers({
      direction: 'long',
      qty: 1,
      entryPrice: 50_000,
      exitPrice: 51_000,
      entryFee: 75,
      exitFee: 76.5,
      hoursHeld: 8,
    });
    expect(r.grossPnl).toBeCloseTo(1_000, 8);
    // Funding: 50_000 × 1 × 0.0001 × (8/8) = 5
    expect(r.funding).toBeCloseTo(5, 8);
    // Netto = 1000 − 75 − 76.5 − 5 (Slippage steckt bereits in den Preisen)
    expect(r.netPnl).toBeCloseTo(843.5, 8);
  });

  it('Short-Gewinn gespiegelt', () => {
    const r = computeCloseNumbers({
      direction: 'short',
      qty: 2,
      entryPrice: 100,
      exitPrice: 90,
      entryFee: 0.3,
      exitFee: 0.27,
      hoursHeld: 0,
    });
    expect(r.grossPnl).toBeCloseTo(20, 8);
    expect(r.funding).toBe(0);
    expect(r.netPnl).toBeCloseTo(19.43, 8);
  });
});

describe('Konto-Rechnung', () => {
  it('Startguthaben ist 100.000', () => {
    expect(DEMO_START_BALANCE).toBe(100_000);
  });

  it('verfügbar = Balance − offene Positions-Notional − ruhende Entry-Order-Notional', () => {
    expect(availableBalance(100_000, 30_000, 20_000)).toBe(50_000);
    expect(availableBalance(100_000, 120_000, 0)).toBe(0); // nie negativ
  });

  it('addToPosition mittelt den Einstieg volumengewichtet', () => {
    const p = addToPosition({ qty: 1, entryPrice: 100 }, { qty: 1, price: 110 });
    expect(p.qty).toBe(2);
    expect(p.entryPrice).toBeCloseTo(105, 8);
  });

  it('roundToStep rundet ab (nie mehr kaufen als bestellt/erlaubt)', () => {
    expect(roundToStep(1.23456, 0.001)).toBeCloseTo(1.234, 12);
    expect(roundToStep(1.23456, 0.5)).toBeCloseTo(1, 12);
    expect(roundToStep(0.0009, 0.001)).toBe(0);
  });
});
