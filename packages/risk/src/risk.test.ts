import { describe, expect, it } from 'vitest';
import { evaluateRisk, type AccountState, type MarketLimits, type OrderIntent, type RiskSettings } from './risk.js';

const ORDER: OrderIntent = {
  symbol: 'BTC/USDT',
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
  now: new Date('2026-07-03T10:00:00Z'),
};

const MARKET: MarketLimits = { tickSize: 0.1, lotSize: 0.001, minNotional: 10 };

describe('Risk-Engine: Sizing (exakt, Tick/Lot/Min-Notional)', () => {
  it('Positionsgröße = Equity × Risiko% ÷ SL-Abstand, auf Lot abgerundet', () => {
    // 10.000 × 1 % = 100 Risiko; Abstand 10 → qty 10; lot 0.001 → 10.000
    const v = evaluateRisk(ORDER, SETTINGS, STATE, MARKET, []);
    expect(v.allowed).toBe(true);
    expect(v.sizing!.qty).toBeCloseTo(10, 9);
    expect(v.sizing!.riskAmount).toBeCloseTo(100);
    expect(v.sizing!.notional).toBeCloseTo(1000);
    expect(v.sizing!.marginRequired).toBeCloseTo(500); // notional / leverage 2
  });

  it('rundet qty auf Lot-Größe AB (nie auf — konservativ)', () => {
    const v = evaluateRisk({ ...ORDER, stopLoss: 97 }, SETTINGS, STATE, { ...MARKET, lotSize: 0.5 }, []);
    // Abstand 3 → qty roh 33.333… → lot 0.5 → 33.0
    expect(v.sizing!.qty).toBeCloseTo(33.0, 9);
  });

  it('blockt bei Notional unter Börsen-Minimum', () => {
    const v = evaluateRisk(ORDER, SETTINGS, { ...STATE, equity: 10 }, MARKET, []);
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/Mindest-Notional/);
  });

  it('blockt bei ungültigem SL (auf falscher Seite)', () => {
    const v = evaluateRisk({ ...ORDER, stopLoss: 110 }, SETTINGS, STATE, MARKET, []);
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/Stop-Loss/);
  });

  it('blockt, wenn die Margin nicht reicht', () => {
    const v = evaluateRisk(ORDER, SETTINGS, { ...STATE, availableMargin: 100 }, MARKET, []);
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/Margin/);
  });
});

describe('Risk-Engine: statische Limits & SAFE-Kill-Switches', () => {
  it('Kill-Switch blockt alles', () => {
    const v = evaluateRisk(ORDER, { ...SETTINGS, killSwitchActive: true }, STATE, MARKET, []);
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/Kill-Switch/);
  });

  it('SAFE-001: Tagesverlust über Limit → HALT', () => {
    const v = evaluateRisk(ORDER, SETTINGS, { ...STATE, dailyPnlPct: -3.2 }, MARKET, []);
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/SAFE-001/);
  });

  it('SAFE-001: Wochen-/Monatslimit greifen ebenfalls', () => {
    expect(evaluateRisk(ORDER, SETTINGS, { ...STATE, weeklyPnlPct: -7.5 }, MARKET, []).allowed).toBe(false);
    expect(evaluateRisk(ORDER, SETTINGS, { ...STATE, monthlyPnlPct: -15.1 }, MARKET, []).allowed).toBe(false);
  });

  it('SAFE-002: 5 Verluste in Folge → 4 h Pause, danach wieder frei', () => {
    const lastLossAt = new Date('2026-07-03T08:00:00Z');
    const inPause = evaluateRisk(
      ORDER,
      SETTINGS,
      { ...STATE, consecutiveLosses: 5, lastLossAt, now: new Date('2026-07-03T10:00:00Z') },
      MARKET,
      [],
    );
    expect(inPause.allowed).toBe(false);
    expect(inPause.reasons.join(' ')).toMatch(/SAFE-002/);

    const afterPause = evaluateRisk(
      ORDER,
      SETTINGS,
      { ...STATE, consecutiveLosses: 5, lastLossAt, now: new Date('2026-07-03T12:01:00Z') },
      MARKET,
      [],
    );
    expect(afterPause.allowed).toBe(true);
  });

  it('Hebel-Cap überstimmt den Wunsch-Hebel', () => {
    const v = evaluateRisk({ ...ORDER, leverage: 25 }, SETTINGS, STATE, MARKET, []);
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/Hebel/);
  });

  it('max. offene Positionen', () => {
    const v = evaluateRisk(ORDER, SETTINGS, { ...STATE, openPositions: 5 }, MARKET, []);
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/Positionen/);
  });

  it('Exposure-Limit je Asset (bestehende + neue Position)', () => {
    // Bestehende Exposure 15 %, neue Order 10 % → 25 % > 20 % Limit
    const v = evaluateRisk(
      { ...ORDER, stopLoss: 99 }, // Abstand 1 → qty 100 → notional 10.000 = 100 %… zu groß; nimm equity groß
      SETTINGS,
      { ...STATE, equity: 100_000, availableMargin: 100_000, exposureBySymbolPct: { 'BTC/USDT': 15 } },
      MARKET,
      [],
    );
    // riskAmount 1000, Abstand 1 → qty 1000 → notional 100.000 = 100 % von 100k → weit über Limit
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/Exposure/);
  });
});

describe('Risk-Engine: adaptive Gates (Selbst-Kalibrierung)', () => {
  const gate = {
    kind: 'block' as const,
    direction: 'long' as const,
    emaRegime: 'below' as const,
    reason: 'Longs unter EMA200: Expectancy −0.42 R über 38 Trades',
    evidence: { trades: 38, expectancyR: -0.42, winRate: 0.31 },
  };

  it('blockt Order, die ALLE gesetzten Kriterien eines Gates erfüllt — mit Evidenz im Grund', () => {
    const v = evaluateRisk({ ...ORDER, emaRegime: 'below' }, SETTINGS, STATE, MARKET, [gate]);
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/unter EMA200/);
    expect(v.reasons.join(' ')).toMatch(/38 Trades/);
  });

  it('greift NICHT, wenn ein Kriterium abweicht (Short unter EMA bleibt erlaubt)', () => {
    const v = evaluateRisk(
      { ...ORDER, direction: 'short', stopLoss: 110, emaRegime: 'below' },
      SETTINGS,
      STATE,
      MARKET,
      [gate],
    );
    expect(v.allowed).toBe(true);
  });

  it('Session-Gate blockt nur die betroffene Session', () => {
    const sessionGate = {
      kind: 'block' as const,
      session: 'asia',
      reason: 'Asia-Session: Expectancy −0.2 R über 45 Trades',
      evidence: { trades: 45, expectancyR: -0.2, winRate: 0.4 },
    };
    expect(evaluateRisk({ ...ORDER, session: 'asia' }, SETTINGS, STATE, MARKET, [sessionGate]).allowed).toBe(false);
    expect(evaluateRisk({ ...ORDER, session: 'london' }, SETTINGS, STATE, MARKET, [sessionGate]).allowed).toBe(true);
  });

  it('alle Checks werden protokolliert (Audit-Transparenz)', () => {
    const v = evaluateRisk(ORDER, SETTINGS, STATE, MARKET, []);
    const names = v.checks.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['kill-switch', 'safe-001-daily', 'safe-002-streak', 'leverage', 'positions', 'adaptive-gates', 'sizing', 'margin', 'exposure']),
    );
    expect(v.checks.every((c) => c.passed)).toBe(true);
  });
});
