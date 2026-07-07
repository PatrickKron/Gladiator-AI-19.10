import { describe, expect, it } from 'vitest';
import {
  buildSubAgentSnapshot,
  dailyLossBreached,
  dxyChangePct20d,
  minutesToNextHighImpact,
  newsToItems,
  reassembleSubAgentSpec,
  symbolOnCooldown,
} from './sub-agent-runner.js';
import { parseSubAgentSpec } from '@gladiator/strategy-engine';

describe('reassembleSubAgentSpec', () => {
  it('setzt config + Regeln + Quellen zu einem parsebaren Spec zusammen', () => {
    const row = {
      config: { side: 'long', setupType: 'swing', timeframe: '1h' },
      dataSources: ['price'],
      entryRules: { price: { dipFromHighPct: 5, dipLookback: 20 } },
      exitRules: { takeProfitPct: 10, stopLossPct: 5 },
      riskParams: { riskPctPerTrade: 1, maxLeverage: 1, maxConcurrentPositions: 1, maxDailyLossPct: 5, cooldownMinutes: 60 },
    };
    const parsed = parseSubAgentSpec(reassembleSubAgentSpec(row));
    expect(parsed.ok).toBe(true);
  });
});

describe('dailyLossBreached', () => {
  const start = 10_000;
  it('erkennt, wenn der Tagesverlust die Schwelle überschreitet', () => {
    // −600 auf 10.000 = −6 % > 5 % Schwelle.
    expect(dailyLossBreached(-600, 5, start)).toBe(true);
  });
  it('lässt Agenten laufen, wenn der Verlust unter der Schwelle liegt', () => {
    expect(dailyLossBreached(-400, 5, start)).toBe(false);
  });
  it('greift nie bei Gewinn', () => {
    expect(dailyLossBreached(1200, 5, start)).toBe(false);
  });
});

describe('symbolOnCooldown', () => {
  const now = new Date('2026-07-07T12:00:00Z');
  it('blockt innerhalb des Cooldown-Fensters', () => {
    expect(symbolOnCooldown(new Date('2026-07-07T11:30:00Z'), now, 60)).toBe(true); // 30 min < 60
  });
  it('erlaubt nach Ablauf des Fensters', () => {
    expect(symbolOnCooldown(new Date('2026-07-07T10:30:00Z'), now, 60)).toBe(false); // 90 min > 60
  });
  it('erlaubt, wenn es noch keinen Einstieg gab', () => {
    expect(symbolOnCooldown(null, now, 60)).toBe(false);
  });
  it('cooldown 0 erlaubt immer', () => {
    expect(symbolOnCooldown(new Date('2026-07-07T11:59:59Z'), now, 0)).toBe(false);
  });
});

describe('minutesToNextHighImpact', () => {
  const now = new Date('2026-07-07T12:00:00Z');
  it('liefert Minuten bis zum nächsten High-Impact-Event (importance 3)', () => {
    const events = [
      { importance: 1, scheduledAt: new Date('2026-07-07T12:10:00Z') },
      { importance: 3, scheduledAt: new Date('2026-07-07T12:45:00Z') },
    ];
    expect(minutesToNextHighImpact(events, now)).toBe(45);
  });
  it('ignoriert vergangene Events und null bei keinem', () => {
    const events = [{ importance: 3, scheduledAt: new Date('2026-07-07T11:00:00Z') }];
    expect(minutesToNextHighImpact(events, now)).toBeNull();
  });
});

describe('newsToItems', () => {
  it('rechnet News-Alter in Minuten', () => {
    const now = new Date('2026-07-07T12:00:00Z');
    const rows = [{ title: 'A', publishedAt: new Date('2026-07-07T11:30:00Z') }];
    const items = newsToItems(rows, now);
    expect(items[0]!.ageMin).toBe(30);
  });
});

describe('dxyChangePct20d', () => {
  it('rechnet die 20-Tage-Änderung aus der Serie', () => {
    const series = Array.from({ length: 21 }, (_, i) => ({ ts: new Date(2026, 0, i + 1), value: 100 + i })); // 100..120
    // aktuell 120, vor 20 Punkten 100 → +20 %.
    expect(dxyChangePct20d(series)).toBeCloseTo(20, 6);
  });
  it('null bei zu wenig Punkten', () => {
    expect(dxyChangePct20d([{ ts: new Date(), value: 100 }])).toBeNull();
  });
});

describe('buildSubAgentSnapshot', () => {
  function candles(closes: number[]) {
    return closes.map((c, i) => ({ ts: new Date(2026, 0, 1, i), open: c, high: c + 1, low: c - 1, close: c, volume: 1 }));
  }

  it('verbindet Preis-, Makro-, Funding-, Kalender- und News-Daten', () => {
    const now = new Date('2026-07-07T12:00:00Z');
    const snap = buildSubAgentSnapshot({
      symbol: 'BTC/USDT',
      candles: candles([100, 110, 121, 90]),
      dipLookback: 4,
      changeLookback: 2,
      macro: { vix: 18, grsLabel: 'risk-on', dxyChangePct20d: -1.2 },
      fundingRate: 0.0003,
      events: [{ importance: 3, scheduledAt: new Date('2026-07-07T12:30:00Z') }],
      news: [{ title: 'Bitcoin ETF approval', publishedAt: new Date('2026-07-07T11:50:00Z') }],
      now,
    });
    expect(snap.symbol).toBe('BTC/USDT');
    expect(snap.price).toBe(90);
    expect(snap.recentHigh).toBe(122); // Hoch inkl. high = close+1
    expect(snap.vix).toBe(18);
    expect(snap.grsLabel).toBe('risk-on');
    expect(snap.fundingRate).toBe(0.0003);
    expect(snap.minutesToNextHighImpact).toBe(30);
    expect(snap.recentNews[0]!.ageMin).toBe(10);
  });

  it('setzt fehlende Quellen ehrlich auf null (kein Fake)', () => {
    const snap = buildSubAgentSnapshot({
      symbol: 'ETH/USDT',
      candles: candles([100, 101]),
      dipLookback: 20,
      changeLookback: 24,
      macro: { vix: null, grsLabel: null, dxyChangePct20d: null },
      fundingRate: null,
      events: [],
      news: [],
      now: new Date(),
    });
    expect(snap.vix).toBeNull();
    expect(snap.fundingRate).toBeNull();
    expect(snap.minutesToNextHighImpact).toBeNull();
    expect(snap.recentNews).toEqual([]);
  });
});
