import { describe, expect, it } from 'vitest';
import { noTradeWindowFor, type CalendarEventLike } from './no-trade.js';
import { evaluateRisk, type AccountState, type MarketLimits, type OrderIntent, type RiskSettings } from './risk.js';

/**
 * No-Trade-Fenster (07_/09_ §3.7): rund um High-Impact-Events (CPI, Leitzins,
 * NFP) werden keine neuen Orders eröffnet. Reine Funktionen, TDD.
 */

const NOW = new Date('2026-07-03T12:00:00Z');

const event = (over: Partial<CalendarEventLike> = {}): CalendarEventLike => ({
  title: 'CPI y/y',
  currency: 'USD',
  importance: 3,
  scheduledAt: new Date('2026-07-03T12:15:00Z'),
  ...over,
});

describe('noTradeWindowFor (pur)', () => {
  it('High-Impact-USD-Event in 15 min → Fenster aktiv mit Begründung', () => {
    const w = noTradeWindowFor([event()], NOW, { beforeMin: 30, afterMin: 30 });
    expect(w).not.toBeNull();
    expect(w!.reason).toMatch(/CPI/);
    expect(w!.reason).toMatch(/USD/);
  });

  it('Event vor 20 min (innerhalb afterMin) → Fenster noch aktiv', () => {
    const w = noTradeWindowFor([event({ scheduledAt: new Date('2026-07-03T11:40:00Z') })], NOW, {
      beforeMin: 30,
      afterMin: 30,
    });
    expect(w).not.toBeNull();
  });

  it('Event in 2 h → kein Fenster', () => {
    const w = noTradeWindowFor([event({ scheduledAt: new Date('2026-07-03T14:00:00Z') })], NOW, {
      beforeMin: 30,
      afterMin: 30,
    });
    expect(w).toBeNull();
  });

  it('Low-Impact-Events lösen KEIN Fenster aus', () => {
    const w = noTradeWindowFor([event({ importance: 1 })], NOW, { beforeMin: 30, afterMin: 30 });
    expect(w).toBeNull();
  });

  it('mehrere Events: das nächstliegende bestimmt die Begründung', () => {
    const w = noTradeWindowFor(
      [event({ title: 'NFP', scheduledAt: new Date('2026-07-03T12:25:00Z') }), event({ title: 'Fed Rate', scheduledAt: new Date('2026-07-03T12:10:00Z') })],
      NOW,
      { beforeMin: 30, afterMin: 30 },
    );
    expect(w!.reason).toMatch(/Fed Rate/);
  });
});

// ── Integration ins Risk-Gate ─────────────────────────────────────────────

const order: OrderIntent = {
  symbol: 'BTC/USDT',
  direction: 'long',
  entry: 100,
  stopLoss: 95,
  leverage: 1,
  session: 'london',
  emaRegime: 'above',
  marketPhase: 'bull',
};
const settings: RiskSettings = {
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
const state: AccountState = {
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
const market: MarketLimits = { tickSize: 0.01, lotSize: 0.000001, minNotional: 10 };

describe('evaluateRisk mit No-Trade-Kontext', () => {
  it('aktives Fenster → Order geblockt mit Event-Begründung', () => {
    const v = evaluateRisk(order, settings, state, market, [], {
      noTrade: { active: true, reason: 'CPI y/y (USD) um 12:15 UTC' },
    });
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/No-Trade/);
    expect(v.reasons.join(' ')).toMatch(/CPI/);
  });

  it('kein Kontext (rückwärtskompatibel) → wie bisher erlaubt', () => {
    const v = evaluateRisk(order, settings, state, market, []);
    expect(v.allowed).toBe(true);
    expect(v.checks.some((c) => c.name === 'no-trade-window' && c.passed)).toBe(true);
  });
});
