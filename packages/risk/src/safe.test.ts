import { describe, expect, it } from 'vitest';
import { evaluateRisk, type AccountState, type MarketLimits, type OrderIntent, type RiskContext, type RiskSettings } from './risk.js';
import {
  countRegimeChanges,
  intradayMovePct,
  returnZScore,
  SAFE_003_BTC_INTRADAY_MAX_PCT,
  SAFE_003_ETH_INTRADAY_MAX_PCT,
  SAFE_004_MAX_LATENCY_MS,
  SAFE_005_STALE_TOLERANCE_MS,
  SAFE_005_MAX_ZSCORE,
  SAFE_006_MAX_SINGLE_SLIPPAGE_PCT,
  SAFE_006_MAX_AVG_SLIPPAGE_PCT,
  SAFE_007_MAX_REGIME_CHANGES_24H,
  SAFE_007_SIZE_FACTOR,
  SAFE_008_PRICE_COLLAR_PCT,
  SAFE_008_MAX_ORDERS_PER_MIN,
  SAFE_010_OPPOSITE_COOLDOWN_MS,
  SAFE_010_MAX_OPEN_ORDERS_PER_ASSET,
  timeframeToMs,
} from './safe.js';

/**
 * SAFE-003…010 (10_ §5a/§5b) — TDD. Grundsatz: fehlende Eingangsdaten werden
 * NIE erfunden; der Check erscheint dann als „übersprungen (Daten fehlen)".
 * Nur sicherheitskritische Live-Preis-Checks (Price-Collar) blocken, wenn der
 * Preis ausdrücklich NICHT abrufbar war (null).
 */

const ORDER: OrderIntent = {
  symbol: 'SOL/USDT',
  timeframe: '1h',
  direction: 'long',
  entry: 100,
  stopLoss: 90,
  leverage: 2,
  session: 'london',
  emaRegime: 'above',
  marketPhase: 'bull',
};

const SETTINGS: RiskSettings = {
  riskPctPerTrade: 1,
  maxLeverage: 10,
  maxOpenPositions: 5,
  maxExposurePctPerAsset: 20,
  dailyLossLimitPct: 3,
  weeklyLossLimitPct: 7,
  monthlyLossLimitPct: 15,
  maxConsecutiveLosses: 5,
  pauseAfterLossStreakHours: 4,
  killSwitchActive: false,
};

const NOW = new Date('2026-07-03T10:00:00Z');
const STATE: AccountState = {
  equity: 10_000,
  availableMargin: 10_000,
  openPositions: 0,
  exposureBySymbolPct: {},
  dailyPnlPct: 0,
  weeklyPnlPct: 0,
  monthlyPnlPct: 0,
  consecutiveLosses: 0,
  lastLossAt: null,
  now: NOW,
};

const MARKET: MarketLimits = { tickSize: 0.1, lotSize: 0.001, minNotional: 10 };

/** Vollständiger, unauffälliger Kontext — jeder Test verändert genau EIN Feld. */
const CALM: RiskContext = {
  noTrade: null,
  vix: 18,
  majorsIntradayMovePct: { btc: 2, eth: 3 },
  priceLatencyMs: 120,
  marketData: { lastCandleTs: new Date(NOW.getTime() - 30 * 60_000), expectedMaxAgeMs: 2 * 3_600_000 + 5 * 60_000 },
  priceZScore: 0.8,
  recentSlippagePct: [0.05, 0.1],
  regimeChanges24h: 1,
  markPrice: 100.5,
  entryOrdersLastMinute: 0,
  openEntryOrdersOnSymbol: 0,
  lastOppositeCloseAt: null,
};

const run = (ctx: RiskContext, order: OrderIntent = ORDER) => evaluateRisk(order, SETTINGS, STATE, MARKET, [], ctx);
const check = (v: ReturnType<typeof run>, name: string) => v.checks.find((c) => c.name === name);

describe('SAFE-Schwellen entsprechen 10_ §5a/§5b', () => {
  it('Blueprint-Zahlen', () => {
    expect(SAFE_003_BTC_INTRADAY_MAX_PCT).toBe(10);
    expect(SAFE_003_ETH_INTRADAY_MAX_PCT).toBe(15);
    expect(SAFE_004_MAX_LATENCY_MS).toBe(5_000);
    expect(SAFE_005_STALE_TOLERANCE_MS).toBe(5 * 60_000);
    expect(SAFE_005_MAX_ZSCORE).toBe(5);
    expect(SAFE_006_MAX_SINGLE_SLIPPAGE_PCT).toBe(1);
    expect(SAFE_006_MAX_AVG_SLIPPAGE_PCT).toBe(0.3);
    expect(SAFE_007_MAX_REGIME_CHANGES_24H).toBe(3);
    expect(SAFE_007_SIZE_FACTOR).toBe(0.25);
    expect(SAFE_008_PRICE_COLLAR_PCT).toBe(2);
    expect(SAFE_008_MAX_ORDERS_PER_MIN).toBe(10);
    expect(SAFE_010_OPPOSITE_COOLDOWN_MS).toBe(5 * 60_000);
    expect(SAFE_010_MAX_OPEN_ORDERS_PER_ASSET).toBe(3);
  });

  it('ruhiger, vollständiger Kontext → alles grün, kein Check übersprungen', () => {
    const v = run(CALM);
    expect(v.allowed, v.reasons.join(' | ')).toBe(true);
    expect(v.checks.filter((c) => c.skipped)).toEqual([]);
    const names = v.checks.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'safe-003-btc', 'safe-003-eth', 'safe-004-latency', 'safe-005-stale', 'safe-005-zscore',
        'safe-006-slippage', 'safe-007-regime', 'safe-008-collar', 'safe-008-rate', 'safe-010-cooldown', 'safe-010-open-orders',
      ]),
    );
  });

  it('leerer Kontext (z. B. Vorschau ohne Order-Daten) → SAFE-003…010 „übersprungen (Daten fehlen)", kein Block', () => {
    const v = run({});
    expect(v.allowed).toBe(true);
    for (const n of ['safe-003-btc', 'safe-004-latency', 'safe-005-stale', 'safe-006-slippage', 'safe-007-regime', 'safe-008-collar', 'safe-008-rate', 'safe-010-cooldown', 'safe-010-open-orders']) {
      const c = check(v, n)!;
      expect(c, n).toBeDefined();
      expect(c.skipped, n).toBe(true);
      expect(c.detail, n).toMatch(/übersprungen \(Daten fehlen\)/);
    }
  });
});

describe('SAFE-003 Volatilität: BTC-Intraday > 10 % · ETH > 15 % → keine neuen Positionen', () => {
  it('BTC 10,5 % → Block', () => {
    const v = run({ ...CALM, majorsIntradayMovePct: { btc: 10.5, eth: 3 } });
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/SAFE-003.*BTC/);
  });
  it('ETH 15,2 % → Block; ETH 14 % bleibt frei', () => {
    expect(run({ ...CALM, majorsIntradayMovePct: { btc: 2, eth: 15.2 } }).allowed).toBe(false);
    expect(run({ ...CALM, majorsIntradayMovePct: { btc: 2, eth: 14 } }).allowed).toBe(true);
  });
  it('BTC-Daten fehlen (null) → übersprungen, ETH wird trotzdem geprüft', () => {
    const v = run({ ...CALM, majorsIntradayMovePct: { btc: null, eth: 3 } });
    expect(v.allowed).toBe(true);
    expect(check(v, 'safe-003-btc')!.skipped).toBe(true);
    expect(check(v, 'safe-003-eth')!.skipped).toBeFalsy();
  });
  it('intradayMovePct: größte Auslenkung vom Tages-Open (beide Richtungen)', () => {
    // Open 100, Tief 88 → −12 %; Hoch 105 → +5 % ⇒ 12
    expect(intradayMovePct([
      { open: 100, high: 103, low: 95, close: 96 },
      { open: 96, high: 105, low: 88, close: 90 },
    ])).toBeCloseTo(12, 9);
    expect(intradayMovePct([])).toBeNull();
  });
});

describe('SAFE-004 Latenz: Pipeline > 5 s → Execution pausiert', () => {
  it('Preis-Abfrage 6 s → Block (Circuit Breaker)', () => {
    const v = run({ ...CALM, priceLatencyMs: 6_000 });
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/SAFE-004/);
  });
  it('4,9 s → frei', () => {
    expect(run({ ...CALM, priceLatencyMs: 4_900 }).allowed).toBe(true);
  });
});

describe('SAFE-005 Datenintegrität: stale > 5 min · Z-Score > 5', () => {
  it('letzte Kerze älter als erwartetes Höchstalter + 5 min → Block', () => {
    const expected = 2 * 3_600_000 + 5 * 60_000;
    const v = run({ ...CALM, marketData: { lastCandleTs: new Date(NOW.getTime() - expected - 5 * 60_000 - 1), expectedMaxAgeMs: expected } });
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/SAFE-005.*veraltet/);
  });
  it('genau an der Toleranzgrenze → noch frei', () => {
    const expected = 2 * 3_600_000 + 5 * 60_000;
    const v = run({ ...CALM, marketData: { lastCandleTs: new Date(NOW.getTime() - expected - 5 * 60_000), expectedMaxAgeMs: expected } });
    expect(v.allowed).toBe(true);
  });
  it('keine Kerzen (null) → übersprungen, nicht geraten', () => {
    const v = run({ ...CALM, marketData: null });
    expect(v.allowed).toBe(true);
    expect(check(v, 'safe-005-stale')!.skipped).toBe(true);
  });
  it('Preis-Z-Score 5,5 → Block (Ausreißer/Datenfehler)', () => {
    const v = run({ ...CALM, priceZScore: -5.5 });
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/SAFE-005.*Z-Score/);
  });
  it('returnZScore: Sprung relativ zur typischen Kerzen-Rendite', () => {
    // Closes pendeln ±1 % → σ der Log-Renditen ≈ 0,01; Mark +10 % ⇒ |z| ≫ 5
    const closes = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 100 : 101));
    expect(Math.abs(returnZScore(111, closes)!)).toBeGreaterThan(5);
    expect(Math.abs(returnZScore(100.5, closes)!)).toBeLessThan(5);
    // zu wenig Historie → null (ehrlich)
    expect(returnZScore(100, [100, 101, 100])).toBeNull();
    // konstante Closes (σ = 0) → null statt Division durch 0
    expect(returnZScore(100, Array.from({ length: 30 }, () => 100))).toBeNull();
  });
});

describe('SAFE-006 Slippage: > 1 % einzeln · > 0,3 % Ø → nur Limit-Orders', () => {
  it('einzelner Fill mit 1,2 % → Market-Order geblockt', () => {
    const v = run({ ...CALM, recentSlippagePct: [0.1, 1.2] });
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/SAFE-006.*Limit/);
  });
  it('Ø 0,4 % → Market geblockt, Limit-Order erlaubt', () => {
    expect(run({ ...CALM, recentSlippagePct: [0.4, 0.4, 0.4] }).allowed).toBe(false);
    expect(run({ ...CALM, recentSlippagePct: [0.4, 0.4, 0.4] }, { ...ORDER, orderType: 'limit' }).allowed).toBe(true);
  });
  it('keine Historie ([]) → übersprungen', () => {
    const v = run({ ...CALM, recentSlippagePct: [] });
    expect(v.allowed).toBe(true);
    expect(check(v, 'safe-006-slippage')!.skipped).toBe(true);
  });
});

describe('SAFE-007 Regime-Unsicherheit: > 3 Wechsel / 24 h → Size −75 %', () => {
  it('4 Wechsel → qty auf 25 % (kein Block)', () => {
    const base = run(CALM);
    const v = run({ ...CALM, regimeChanges24h: 4 });
    expect(v.allowed).toBe(true);
    expect(v.sizing!.qty).toBeCloseTo(base.sizing!.qty * 0.25, 6);
    expect(v.sizing!.riskAmount).toBeCloseTo(base.sizing!.riskAmount * 0.25, 6);
    expect(check(v, 'safe-007-regime')!.detail).toMatch(/−75 %/);
  });
  it('auch der Wunschbetrag wird reduziert', () => {
    const v = run({ ...CALM, regimeChanges24h: 5 }, { ...ORDER, requestedNotional: 1000 });
    expect(v.sizing!.notional).toBeCloseTo(250, 6);
  });
  it('3 Wechsel → volle Größe', () => {
    expect(run({ ...CALM, regimeChanges24h: 3 }).sizing!.qty).toBeCloseTo(run(CALM).sizing!.qty, 9);
  });
  it('countRegimeChanges zählt Übergänge', () => {
    expect(countRegimeChanges(['bull', 'bull', 'bear', 'sideways', 'sideways', 'bull'])).toBe(3);
    expect(countRegimeChanges([])).toBe(0);
  });
});

describe('SAFE-008 Pre-Trade-Controls: Price-Collar 2 % · max 10 Orders/min', () => {
  it('Entry 100 vs Live-Mark 103 (> 2 %) → Block', () => {
    const v = run({ ...CALM, markPrice: 103 });
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/SAFE-008.*Collar/);
  });
  it('Entry 100 vs Mark 98,1 (< 2 %) → frei', () => {
    expect(run({ ...CALM, markPrice: 98.1 }).allowed).toBe(true);
  });
  it('Live-Preis NICHT abrufbar (null) → Block (sicherheitskritisch)', () => {
    const v = run({ ...CALM, markPrice: null });
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/SAFE-008.*Live-Preis/);
  });
  it('10 Entry-Orders in der letzten Minute → Block; 9 → frei', () => {
    const v = run({ ...CALM, entryOrdersLastMinute: 10 });
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/SAFE-008.*Orders\/min/);
    expect(run({ ...CALM, entryOrdersLastMinute: 9 }).allowed).toBe(true);
  });
});

describe('SAFE-010 Market Abuse: Opposite-Cooldown 5 min · max 3 offene Orders je Asset', () => {
  it('Gegenrichtung vor 2 min geschlossen → Block; vor 6 min → frei', () => {
    const v = run({ ...CALM, lastOppositeCloseAt: new Date(NOW.getTime() - 2 * 60_000) });
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/SAFE-010.*Cooldown/);
    expect(run({ ...CALM, lastOppositeCloseAt: new Date(NOW.getTime() - 6 * 60_000) }).allowed).toBe(true);
  });
  it('3 offene Entry-Orders auf dem Asset → Block; 2 → frei', () => {
    const v = run({ ...CALM, openEntryOrdersOnSymbol: 3 });
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/SAFE-010.*offene Orders/);
    expect(run({ ...CALM, openEntryOrdersOnSymbol: 2 }).allowed).toBe(true);
  });
});

describe('timeframeToMs', () => {
  it('parst gängige Timeframes; unbekannt → null', () => {
    expect(timeframeToMs('15m')).toBe(900_000);
    expect(timeframeToMs('4h')).toBe(14_400_000);
    expect(timeframeToMs('1d')).toBe(86_400_000);
    expect(timeframeToMs('1w')).toBe(604_800_000);
    expect(timeframeToMs('1M')).toBe(30 * 86_400_000);
    expect(timeframeToMs('xyz')).toBeNull();
  });
});
