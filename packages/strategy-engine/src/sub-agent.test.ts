import { describe, expect, it } from 'vitest';
import {
  evaluateSubAgentEntry,
  evaluateSubAgentExit,
  parseSubAgentSpec,
  priceSnapshotFromCandles,
  type SubAgentSnapshot,
} from './sub-agent.js';
import type { Candle } from './types.js';

/** Vollständiger, gültiger Spec-Baustein für Tests (Dip-Buyer-Grundform). */
function dipSpec(overrides: Record<string, unknown> = {}) {
  return {
    side: 'long',
    setupType: 'swing',
    timeframe: '1h',
    dataSources: ['price'],
    entryRules: { price: { dipFromHighPct: 5, dipLookback: 20 } },
    exitRules: { takeProfitPct: 10, stopLossPct: 5 },
    riskParams: { riskPctPerTrade: 1, maxLeverage: 1, maxConcurrentPositions: 1, maxDailyLossPct: 5, cooldownMinutes: 60 },
    ...overrides,
  };
}

/** Snapshot mit sinnvollen Defaults; Felder gezielt überschreiben. */
function snap(overrides: Partial<SubAgentSnapshot> = {}): SubAgentSnapshot {
  return {
    symbol: 'BTC/USDT',
    price: 100,
    changePct24h: null,
    recentHigh: null,
    vix: null,
    grsLabel: null,
    dxyChangePct20d: null,
    fundingRate: null,
    minutesToNextHighImpact: null,
    recentNews: [],
    now: new Date('2026-07-07T12:00:00Z'),
    ...overrides,
  };
}

describe('parseSubAgentSpec', () => {
  it('akzeptiert eine vollständige Dip-Buyer-Definition', () => {
    const r = parseSubAgentSpec(dipSpec());
    expect(r.ok).toBe(true);
  });

  it('lehnt Einstiegsregeln OHNE jede Bedingung ab (würde sonst ununterbrochen feuern)', () => {
    const r = parseSubAgentSpec(dipSpec({ entryRules: { price: {} } }));
    expect(r.ok).toBe(false);
  });

  it('erzwingt Pflicht-Schutz: TP% und SL% müssen gesetzt sein', () => {
    const r = parseSubAgentSpec(dipSpec({ exitRules: { takeProfitPct: 10 } }));
    expect(r.ok).toBe(false);
  });

  it('verlangt, dass jede referenzierte Datenquelle in dataSources deklariert ist', () => {
    // Makro-Bedingung, aber 'macro' fehlt in dataSources → ungültig.
    const r = parseSubAgentSpec(
      dipSpec({ dataSources: ['price'], entryRules: { price: { dipFromHighPct: 5 }, macro: { vix: { gt: 30 } } } }),
    );
    expect(r.ok).toBe(false);
  });
});

describe('evaluateSubAgentEntry — price', () => {
  it('feuert long, wenn der Dip vom jüngsten Hoch die Schwelle erreicht', () => {
    const spec = parseSubAgentSpec(dipSpec());
    if (!spec.ok) throw new Error('spec invalid');
    // Preis 90, Hoch 100 → 10 % Dip ≥ 5 % Schwelle.
    const d = evaluateSubAgentEntry(spec.spec, snap({ price: 90, recentHigh: 100 }));
    expect(d).not.toBeNull();
    expect(d!.direction).toBe('long');
    expect(d!.entry).toBe(90);
    expect(d!.stopLoss).toBeCloseTo(90 * 0.95, 6); // SL 5 %
    expect(d!.takeProfits[0]).toBeCloseTo(90 * 1.1, 6); // TP 10 %
  });

  it('feuert NICHT, wenn der Dip zu klein ist', () => {
    const spec = parseSubAgentSpec(dipSpec());
    if (!spec.ok) throw new Error('spec invalid');
    const d = evaluateSubAgentEntry(spec.spec, snap({ price: 98, recentHigh: 100 })); // nur 2 %
    expect(d).toBeNull();
  });

  it('feuert NICHT, wenn die nötigen Daten fehlen (kein Fake, ehrlich null)', () => {
    const spec = parseSubAgentSpec(dipSpec());
    if (!spec.ok) throw new Error('spec invalid');
    const d = evaluateSubAgentEntry(spec.spec, snap({ price: 90, recentHigh: null }));
    expect(d).toBeNull();
  });
});

describe('evaluateSubAgentEntry — mehrere Quellen (UND-Verknüpfung)', () => {
  const macroDip = () =>
    parseSubAgentSpec(
      dipSpec({
        dataSources: ['price', 'macro'],
        entryRules: { price: { dipFromHighPct: 5 }, macro: { vix: { lt: 25 } } },
      }),
    );

  it('feuert nur, wenn ALLE Bedingungen erfüllt sind', () => {
    const spec = macroDip();
    if (!spec.ok) throw new Error('spec invalid');
    // Dip ok, aber VIX zu hoch → kein Einstieg.
    expect(evaluateSubAgentEntry(spec.spec, snap({ price: 90, recentHigh: 100, vix: 30 }))).toBeNull();
    // Dip ok UND VIX niedrig → Einstieg.
    expect(evaluateSubAgentEntry(spec.spec, snap({ price: 90, recentHigh: 100, vix: 18 }))).not.toBeNull();
  });
});

describe('evaluateSubAgentEntry — short-Seite', () => {
  it('setzt Stop über und TP unter dem Entry', () => {
    const spec = parseSubAgentSpec(
      dipSpec({ side: 'short', entryRules: { price: { changePct24h: { gt: 5 } } }, dataSources: ['price'] }),
    );
    if (!spec.ok) throw new Error('spec invalid');
    const d = evaluateSubAgentEntry(spec.spec, snap({ price: 100, changePct24h: 8 }));
    expect(d).not.toBeNull();
    expect(d!.direction).toBe('short');
    expect(d!.stopLoss).toBeCloseTo(105, 6);
    expect(d!.takeProfits[0]).toBeCloseTo(90, 6);
  });
});

describe('evaluateSubAgentEntry — news & calendar', () => {
  it('Event-Trader feuert nur bei passendem News-Keyword', () => {
    const spec = parseSubAgentSpec(
      dipSpec({ dataSources: ['news'], entryRules: { news: { anyKeyword: ['etf approval'], withinMin: 120 } } }),
    );
    if (!spec.ok) throw new Error('spec invalid');
    expect(evaluateSubAgentEntry(spec.spec, snap())).toBeNull();
    const withNews = snap({ recentNews: [{ title: 'SEC signals Bitcoin ETF approval imminent', ageMin: 10 }] });
    expect(evaluateSubAgentEntry(spec.spec, withNews)).not.toBeNull();
  });

  it('Makro-Agent respektiert No-Trade-Fenster vor High-Impact-Events', () => {
    const spec = parseSubAgentSpec(
      dipSpec({
        dataSources: ['price', 'calendar'],
        entryRules: { price: { dipFromHighPct: 5 }, calendar: { noHighImpactWithinMin: 60 } },
      }),
    );
    if (!spec.ok) throw new Error('spec invalid');
    // Event in 30 min → blockiert.
    expect(evaluateSubAgentEntry(spec.spec, snap({ price: 90, recentHigh: 100, minutesToNextHighImpact: 30 }))).toBeNull();
    // Kein Event in Reichweite (null) → erlaubt.
    expect(evaluateSubAgentEntry(spec.spec, snap({ price: 90, recentHigh: 100, minutesToNextHighImpact: null }))).not.toBeNull();
  });
});

describe('evaluateSubAgentExit', () => {
  const spec = () => {
    const r = parseSubAgentSpec(
      dipSpec({
        dataSources: ['price', 'news'],
        exitRules: { takeProfitPct: 10, stopLossPct: 5, maxHoldHours: 24, exitOnNewsKeyword: ['hack'] },
      }),
    );
    if (!r.ok) throw new Error('spec invalid');
    return r.spec;
  };

  it('schließt zeitbasiert nach maxHoldHours', () => {
    const pos = { openedAt: new Date('2026-07-06T00:00:00Z'), direction: 'long' as const, entryPrice: 100 };
    const d = evaluateSubAgentExit(spec(), pos, snap({ now: new Date('2026-07-07T06:00:00Z') })); // 30 h
    expect(d).not.toBeNull();
    expect(d!.reason).toContain('Zeit');
  });

  it('schließt bei einem Ausstiegs-News-Keyword (Event-Exit)', () => {
    const pos = { openedAt: new Date('2026-07-07T11:00:00Z'), direction: 'long' as const, entryPrice: 100 };
    const d = evaluateSubAgentExit(spec(), pos, snap({ recentNews: [{ title: 'Major exchange hack drains funds', ageMin: 5 }] }));
    expect(d).not.toBeNull();
    expect(d!.reason.toLowerCase()).toContain('news');
  });

  it('hält, wenn keine agenten-verwaltete Ausstiegsbedingung greift', () => {
    const pos = { openedAt: new Date('2026-07-07T11:00:00Z'), direction: 'long' as const, entryPrice: 100 };
    expect(evaluateSubAgentExit(spec(), pos, snap())).toBeNull();
  });
});

describe('priceSnapshotFromCandles', () => {
  function series(closes: number[]): Candle[] {
    return closes.map((c, i) => ({
      ts: new Date(2026, 0, 1, i),
      open: c,
      high: c,
      low: c,
      close: c,
      volume: 1,
    }));
  }

  it('bildet recentHigh aus dem Lookback-Fenster und den aktuellen Preis', () => {
    const candles = series([100, 110, 120, 90]); // Hoch 120, aktueller Preis 90
    const s = priceSnapshotFromCandles(candles, candles.length - 1, { dipLookback: 4, changeLookback: 2 });
    expect(s.price).toBe(90);
    expect(s.recentHigh).toBe(120);
  });

  it('rechnet changePct24h relativ zum Lookback-Bar', () => {
    const candles = series([100, 100, 110]); // +10 % über 2 Bars
    const s = priceSnapshotFromCandles(candles, candles.length - 1, { dipLookback: 3, changeLookback: 2 });
    expect(s.changePct24h).toBeCloseTo(10, 6);
  });
});
