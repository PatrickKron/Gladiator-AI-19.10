import { describe, expect, it } from 'vitest';
import {
  aggregatePostTrade,
  classifyHitQuality,
  evaluateTrade,
  scoreValidity,
  type ClosedTrade,
  type TradeContext,
} from './post-trade.js';

describe('classifyHitQuality', () => {
  it('mappt R-Multiple auf Qualitätsstufen', () => {
    expect(classifyHitQuality(2.5, 250)).toBe('excellent');
    expect(classifyHitQuality(1.2, 120)).toBe('good');
    expect(classifyHitQuality(0.4, 40)).toBe('acceptable');
    expect(classifyHitQuality(-0.5, -50)).toBe('poor');
    expect(classifyHitQuality(-1.2, -120)).toBe('loss');
  });
  it('fällt ohne R auf PnL-Vorzeichen zurück', () => {
    expect(classifyHitQuality(null, 10)).toBe('acceptable');
    expect(classifyHitQuality(null, -10)).toBe('loss');
  });
});

describe('scoreValidity', () => {
  it('0.5 ohne Score', () => {
    expect(scoreValidity(null, 1, 100)).toBe(0.5);
  });
  it('hoch, wenn hoher Score gewinnt', () => {
    expect(scoreValidity(9, 2, 200)).toBeGreaterThan(0.7);
  });
  it('niedrig, wenn hoher Score verliert (Überkonfidenz)', () => {
    expect(scoreValidity(9, -1.5, -150)).toBeLessThan(0.4);
  });
  it('bleibt in [0,1]', () => {
    for (const s of [0, 3, 5, 7, 10]) {
      for (const r of [-2, -1, 0, 1, 2]) {
        const v = scoreValidity(s, r, r * 100);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

function trade(over: Partial<ClosedTrade> = {}): ClosedTrade {
  return { direction: 'long', netPnl: -100, rMultiple: -1, mode: 'paper', ...over };
}

describe('evaluateTrade — Fehlerquellen & Lehren', () => {
  it('erkennt Trade ins CPI-Fenster als Fehlerquelle bei Verlust', () => {
    const ctx: TradeContext = { originalScore: 6, cpiStatus: 'release_window' };
    const r = evaluateTrade(trade(), ctx);
    expect(r.errorSources).toContain('traded_into_cpi_window');
    expect(r.lessons).toContain('respect_cpi_window');
  });

  it('erkennt Überkonfidenz bei hohem Score + Verlust', () => {
    const r = evaluateTrade(trade(), { originalScore: 8 });
    expect(r.errorSources).toContain('score_overconfident');
    expect(r.lessons).toContain('recalibrate_high_scores');
  });

  it('erkennt Long in Überbewertung', () => {
    const r = evaluateTrade(trade({ direction: 'long' }), { originalScore: 5, buffettStatus: 'extreme' });
    expect(r.errorSources).toContain('long_into_overvaluation');
  });

  it('erkennt fehlenden Hedge im volatilen Regime', () => {
    const r = evaluateTrade(trade(), { originalScore: 5, regime: 'high_vol', hedgeMode: 'no_hedge' });
    expect(r.errorSources).toContain('no_hedge_in_volatile_regime');
  });

  it('Verlust ohne systematischen Fehler = akzeptierte Varianz', () => {
    const r = evaluateTrade(trade(), { originalScore: 5 });
    expect(r.errorSources).toContain('within_expected_variance');
    expect(r.lessons).toContain('accept_stop_as_designed');
  });

  it('Gewinn bestätigt das Setup-Muster, keine Fehlerquellen', () => {
    const r = evaluateTrade(trade({ netPnl: 200, rMultiple: 2 }), { originalScore: 8 });
    expect(r.hitQuality).toBe('excellent');
    expect(r.errorSources).toHaveLength(0);
    expect(r.lessons).toContain('setup_pattern_confirmed');
  });
});

describe('aggregatePostTrade', () => {
  it('leere Eingabe', () => {
    const agg = aggregatePostTrade([]);
    expect(agg.count).toBe(0);
    expect(agg.winRate).toBe(0);
    expect(agg.avgRMultiple).toBeNull();
  });

  it('aggregiert Kennzahlen + häufigste Fehlerquellen', () => {
    const reviews = [
      { review: evaluateTrade(trade({ netPnl: 200, rMultiple: 2 }), { originalScore: 8 }), rMultiple: 2 },
      { review: evaluateTrade(trade(), { originalScore: 8, cpiStatus: 'release_window' }), rMultiple: -1 },
      { review: evaluateTrade(trade(), { originalScore: 8, cpiStatus: 'pre_event' }), rMultiple: -1 },
    ];
    const agg = aggregatePostTrade(reviews);
    expect(agg.count).toBe(3);
    expect(agg.wins).toBe(1);
    expect(agg.losses).toBe(2);
    expect(agg.winRate).toBeCloseTo(1 / 3);
    expect(agg.avgRMultiple).toBeCloseTo(0);
    // Beide Verluste teilen 'score_overconfident' und 'traded_into_cpi_window' (je 2×) → an der Spitze.
    const byKey = Object.fromEntries(agg.topErrorSources.map((e) => [e.key, e.count]));
    expect(byKey.score_overconfident).toBe(2);
    expect(byKey.traded_into_cpi_window).toBe(2);
    expect(agg.topErrorSources[0]!.count).toBe(2);
  });
});
