import { describe, expect, it } from 'vitest';
import type { Candle } from '@gladiator/strategy-engine';
import {
  buildSignalStudyAnalytics,
  classifySignalEventContext,
  evaluateSignalStudyVariants,
  STUDY_VARIANT_IDS,
  usageGroupOf,
  type StudyRowLike,
} from './signal-studies.js';

const HOUR = 3_600_000;

function makeCandles(bars: Array<[number, number, number, number]>, startMs = 1_700_000_000_000): Candle[] {
  return bars.map(([o, h, l, c], i) => ({
    ts: new Date(startMs + i * HOUR),
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 100,
  }));
}

describe('Autonome Signal-Studien (Welle 23)', () => {
  it('trennt genutzte und verpasste Signale sauber', () => {
    expect(usageGroupOf('filled')).toBe('used');
    expect(usageGroupOf('closed')).toBe('used');
    expect(usageGroupOf('confirmed')).toBe('used');
    expect(usageGroupOf('expired')).toBe('missed');
    expect(usageGroupOf('rejected')).toBe('missed');
    expect(usageGroupOf('new')).toBeNull();
  });

  it('ordnet echte Makro-Events im ±120-Min.-Fenster korrekt zu', () => {
    const sigTime = new Date('2026-11-10T13:00:00Z');
    const cpi = classifySignalEventContext(sigTime, [
      { title: 'US CPI y/y', currency: 'USD', importance: 3, scheduledAt: new Date('2026-11-10T13:30:00Z') },
    ]);
    expect(cpi.eventCategory).toBe('inflation');
    expect(cpi.eventDeltaMin).toBe(30);

    const fomc = classifySignalEventContext(sigTime, [
      { title: 'FOMC Rate Decision', currency: 'USD', importance: 3, scheduledAt: new Date('2026-11-10T12:15:00Z') },
    ]);
    expect(fomc.eventCategory).toBe('central_bank');
    expect(fomc.eventDeltaMin).toBe(-45);

    const none = classifySignalEventContext(sigTime, [
      { title: 'US CPI y/y', currency: 'USD', importance: 3, scheduledAt: new Date('2026-11-10T18:00:00Z') },
    ]);
    expect(none.eventCategory).toBe('none');
    expect(none.eventTitle).toBeNull();
  });

  it('wertet alle 5 Studien-Varianten look-ahead-frei aus und zeigt Effekt eines weiteren SL', () => {
    // Entry 100, SL 98 (2 Risk), TP1 104, TP2 106, TP3 108.
    // Bar 1 dippt kurz auf 97.5 (stoppt Baseline bei 98 aus, ABER wide_sl bei 97 überlebt!) und rallyt dann auf 109!
    const startMs = 1_700_000_000_000;
    const candles = makeCandles(
      [
        [100, 100.5, 99.5, 100], // Signal-Kerze (geschlossen)
        [100, 100.2, 97.5, 99.5], // Dip auf 97.5 → Baseline SL (98) ausgelöst, wide_sl (97) hält!
        [99.5, 109.0, 99.2, 108.5], // Rally durch alle TPs!
        [108.5, 109.5, 108.0, 109.0],
      ],
      startMs,
    );
    const outcomes = evaluateSignalStudyVariants(
      {
        id: 'sig-1',
        symbol: 'BTC/USDT',
        timeframe: '1h',
        direction: 'long',
        setupType: 'swing',
        entry: 100,
        stopLoss: 98,
        takeProfits: [104, 106, 108],
        trailPct: null,
        createdAt: new Date(startMs + HOUR + 5_000),
      },
      candles,
      HOUR,
      'binance',
    );

    expect(outcomes.map((o) => o.variant)).toEqual([...STUDY_VARIANT_IDS]);
    const base = outcomes.find((o) => o.variant === 'baseline')!;
    const wide = outcomes.find((o) => o.variant === 'wide_sl')!;
    expect(base.studyStatus).toBe('closed');
    expect(base.exitReason).toBe('sl');
    expect(base.rMultiple!).toBeLessThan(0);

    expect(wide.studyStatus).toBe('closed');
    expect(wide.exitReason).toBe('tp');
    expect(wide.rMultiple!).toBeGreaterThan(1);
    expect(wide.mfeR!).toBeGreaterThan(2);
  });

  it('aggregiert Genutzt vs. Verpasst, Sessions, Events, Varianten & Kurven sauber', () => {
    const mk = (p: Partial<StudyRowLike>): StudyRowLike => ({
      signalId: 's1',
      strategySlug: 'smc-core',
      symbol: 'BTC/USDT',
      venue: 'binance',
      timeframe: '1h',
      direction: 'long',
      setupType: 'swing',
      signalStatus: 'expired',
      usageGroup: 'missed',
      variant: 'baseline',
      studyStatus: 'closed',
      rMultiple: 1.5,
      mfeR: 2.1,
      maeR: 0.4,
      exitReason: 'tp',
      barsHeld: 12,
      session: 'london',
      marketPhase: 'bull',
      emaRegime: 'above',
      score: 8.5,
      eventCategory: 'inflation',
      eventTitle: 'US CPI',
      eventDeltaMin: 15,
      signalCreatedAt: new Date('2026-11-10T10:00:00Z'),
      exitTs: new Date('2026-11-10T22:00:00Z'),
      ...p,
    });

    const rows: StudyRowLike[] = [
      mk({ signalId: 's1', usageGroup: 'used', signalStatus: 'filled', rMultiple: 2.0, session: 'london', eventCategory: 'none' }),
      mk({ signalId: 's2', usageGroup: 'missed', signalStatus: 'expired', rMultiple: -1.0, session: 'newyork', eventCategory: 'inflation', signalCreatedAt: new Date('2026-11-11T14:00:00Z') }),
      mk({ signalId: 's2', usageGroup: 'missed', variant: 'wide_sl', rMultiple: 1.2, session: 'newyork', eventCategory: 'inflation', signalCreatedAt: new Date('2026-11-11T14:00:00Z') }),
    ];

    const analytics = buildSignalStudyAnalytics(rows, 'baseline');
    expect(analytics.used.closed).toBe(1);
    expect(analytics.used.sumR).toBe(2);
    expect(analytics.missed.closed).toBe(1);
    expect(analytics.missed.sumR).toBe(-1);
    expect(analytics.bySession.map((b) => b.key)).toEqual(['london', 'newyork']);
    expect(analytics.byEvent.map((b) => b.key)).toEqual(['none', 'inflation']);
    expect(analytics.byVariant.find((v) => v.key === 'wide_sl')?.sumR).toBe(1.2);
    expect(analytics.usedCurve).toHaveLength(1);
    expect(analytics.missedCurve).toHaveLength(1);
    expect(analytics.scatter).toHaveLength(2);
    expect(analytics.summary.lowSample).toBe(true);
  });
});
