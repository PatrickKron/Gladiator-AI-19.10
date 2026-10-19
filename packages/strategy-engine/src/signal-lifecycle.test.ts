import { describe, expect, it } from 'vitest';
import {
  AUTO_KILL_SCORE_THRESHOLD,
  MAX_REENTRIES,
  SETUP_LIFECYCLE_RULES,
  assessOpenSignal,
  deriveLeverageUpgradePlan,
  deriveReentryPlan,
  evaluateLeverageUpgrade,
  evaluateReentry,
  rescoreSignal,
} from './signal-lifecycle.js';
import type { Candle } from './types.js';

/**
 * 05_ §5/§9: Reentry-Pullback, Leverage-Upgrade (Trigger/Faktor/Max), Auto-Kill (< 6,5).
 * Reine Funktionen — Kerzen hier sind Test-Fixtures (Mock nur in Tests).
 */

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);

/** Gleichmäßiger Trend: Kerzen mit kleiner Spanne um eine lineare Close-Linie. */
function trendCandles(n: number, start: number, step: number, t0 = T0): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const close = start + step * i;
    out.push({ ts: new Date(t0 + i * H), open: close - step / 2, high: close + 0.2, low: close - 0.2, close, volume: 100 });
  }
  return out;
}

const SMC_TAGS = ['Trend (EMA)', 'Struktur-Bruch', 'Retest@EMA/Level', 'RSI-Band', 'Volumen', 'Session aktiv', 'RR ≥ 2', 'Higher-TF bestätigt'];

describe('Plan-Ableitung beim Setup (05_ §5 Tabelle)', () => {
  it('Regeln je Setup exakt laut Blueprint: Pullback-Fenster, Trigger, Faktor, Max', () => {
    expect(SETUP_LIFECYCLE_RULES.scalp).toEqual({
      reentry: { minPullbackPct: 1.5, maxPullbackPct: 2.0 },
      leverageUpgrade: { triggerPct: 2, multiplier: 2, maxLeverage: 20 },
    });
    expect(SETUP_LIFECYCLE_RULES.swing).toEqual({
      reentry: { minPullbackPct: 1.5, maxPullbackPct: 2.5 },
      leverageUpgrade: { triggerPct: 5, multiplier: 1.5, maxLeverage: 10 },
    });
    expect(SETUP_LIFECYCLE_RULES.position).toEqual({
      reentry: { minPullbackPct: 2, maxPullbackPct: 3 },
      leverageUpgrade: { triggerPct: 7, multiplier: 5, maxLeverage: 50 },
    });
    expect(AUTO_KILL_SCORE_THRESHOLD).toBe(6.5);
    expect(MAX_REENTRIES).toBe(1); // „zweite Einstiegschance"
  });

  it('Long-Swing: Reentry-Zone 1,5–2,5 % UNTER Entry, aktiv wenn die Zone vor dem Stop liegt', () => {
    const plan = deriveReentryPlan({ direction: 'long', setupType: 'swing', entry: 100, stopLoss: 95 });
    expect(plan.enabled).toBe(true);
    expect(plan.minPullbackPct).toBe(1.5);
    expect(plan.maxPullbackPct).toBe(2.5);
    expect(plan.zoneLow).toBeCloseTo(97.5, 10);
    expect(plan.zoneHigh).toBeCloseTo(98.5, 10);
    expect(plan.maxReentries).toBe(1);
    expect(plan.generation).toBe(0);
  });

  it('Short-Scalp: Zone 1,5–2,0 % ÜBER Entry', () => {
    const plan = deriveReentryPlan({ direction: 'short', setupType: 'scalp', entry: 100, stopLoss: 105 });
    expect(plan.enabled).toBe(true);
    expect(plan.zoneLow).toBeCloseTo(101.5, 10);
    expect(plan.zoneHigh).toBeCloseTo(102, 10);
  });

  it('Stop enger als das Pullback-Fenster → Reentry deaktiviert (Zone läge jenseits der Invalidierung)', () => {
    const plan = deriveReentryPlan({ direction: 'long', setupType: 'scalp', entry: 100, stopLoss: 99 });
    expect(plan.enabled).toBe(false);
  });

  it('Reentry-Signal (Generation 1) hat keine weitere Chance mehr', () => {
    const plan = deriveReentryPlan(
      { direction: 'long', setupType: 'swing', entry: 98, stopLoss: 95 },
      { generation: 1, parentSignalId: 'p', rootSignalId: 'r' },
    );
    expect(plan.enabled).toBe(false);
    expect(plan.parentSignalId).toBe('p');
    expect(plan.rootSignalId).toBe('r');
  });

  it('Leverage-Upgrade-Plan je Setup', () => {
    expect(deriveLeverageUpgradePlan('position')).toEqual({ triggerPct: 7, multiplier: 5, maxLeverage: 50 });
  });
});

describe('rescoreSignal (05_ §6-Gewichte, echte Kerzen)', () => {
  it('SMC: Trend bricht (Close unter EMA) → Trend-Beitrag fällt weg', () => {
    // 250 steigende Kerzen, dann Absturz unter die EMA
    const up = trendCandles(250, 100, 1);
    const crash = trendCandles(5, 200, -20, T0 + 250 * H);
    const r = rescoreSignal({
      direction: 'long',
      stopLoss: 50,
      takeProfits: [400],
      confluence: SMC_TAGS,
      candles: [...up, ...crash],
    });
    expect(r).not.toBeNull();
    expect(r!.confluence).not.toContain('Trend (EMA)');
  });

  it('SMC: intakter Trend → Score bleibt (Tags beibehalten, RR neu zum aktuellen Preis)', () => {
    const c = trendCandles(250, 100, 1); // letzter Close 349
    const r = rescoreSignal({ direction: 'long', stopLoss: 340, takeProfits: [380], confluence: SMC_TAGS, candles: c, higherTfTrend: 'bull' });
    // Alle 8 Tags: 1,5+1,5+2+1+1+0,5+1(RR (380-349)/(349-340)=3,4)+1 = 9,5
    expect(r!.score).toBeCloseTo(9.5, 5);
  });

  it('SMC: Higher-TF dreht gegen die Richtung → −1 statt +1', () => {
    const c = trendCandles(250, 100, 1);
    const r = rescoreSignal({ direction: 'long', stopLoss: 340, takeProfits: [380], confluence: SMC_TAGS, candles: c, higherTfTrend: 'bear' });
    expect(r!.score).toBeCloseTo(7.5, 5);
  });

  it('DSL: RR-Score wird zum aktuellen Preis neu berechnet (min(10, RR1 × 3))', () => {
    const c = trendCandles(10, 100, 0); // Close 100
    const r = rescoreSignal({ direction: 'long', stopLoss: 98, takeProfits: [104], confluence: ['dsl:EMA200_up', 'score:rr-basiert'], candles: c });
    expect(r!.score).toBeCloseTo(6, 5); // RR1 = 4/2 = 2 → 6,0
  });

  it('Unbekannte Herkunft (Pine/manuell) → null (kein erfundener Score)', () => {
    const c = trendCandles(10, 100, 0);
    expect(rescoreSignal({ direction: 'long', stopLoss: 98, takeProfits: [104], confluence: ['pine'], candles: c })).toBeNull();
  });
});

describe('assessOpenSignal → Auto-Kill', () => {
  const createdAt = new Date(T0 + 249.5 * H);

  it('Preis über/unter Stop VOR Entry (Kerze nach Erstellung) → stop_breached', () => {
    const base = trendCandles(250, 100, 1);
    const after: Candle = { ts: new Date(T0 + 250 * H), open: 349, high: 350, low: 330, close: 348, volume: 100 };
    const r = assessOpenSignal({
      direction: 'long', stopLoss: 335, takeProfits: [380], score: 9, confluence: SMC_TAGS,
      candles: [...base, after], createdAt,
    });
    expect(r.kill?.reason).toBe('stop_breached');
  });

  it('Docht VOR der Erstellung zählt nicht (look-ahead-frei)', () => {
    const base = trendCandles(250, 100, 1);
    base[248] = { ...base[248]!, low: 300 };
    const r = assessOpenSignal({
      direction: 'long', stopLoss: 335, takeProfits: [380], score: 9, confluence: SMC_TAGS,
      candles: base, createdAt,
    });
    expect(r.kill).toBeNull();
  });

  it('Live-Preis jenseits des Stops → stop_breached', () => {
    const base = trendCandles(250, 100, 1);
    const r = assessOpenSignal({
      direction: 'short', stopLoss: 352, takeProfits: [300], score: 9, confluence: SMC_TAGS,
      candles: base, createdAt, price: 353,
    });
    expect(r.kill?.reason).toBe('stop_breached');
  });

  it('Gegenläufiger Struktur-Bruch nach Erstellung → structure_broken', () => {
    // Swing-Tief bilden, danach Schlusskurs-Bruch darunter (bearish Event) — nach Erstellung
    const c: Candle[] = [];
    const prices = [
      ...Array.from({ length: 20 }, (_, i) => 120 - i), // fällt auf 101
      ...Array.from({ length: 20 }, (_, i) => 102 + i), // steigt auf 121 → Swing-Tief bei 101 bestätigt
      ...Array.from({ length: 10 }, (_, i) => 119 - i * 2.5), // fällt unter 101 → bearish Bruch
    ];
    prices.forEach((p, i) => c.push({ ts: new Date(T0 + i * H), open: p, high: p + 0.5, low: p - 0.5, close: p, volume: 100 }));
    const r = assessOpenSignal({
      direction: 'long', stopLoss: 50, takeProfits: [200], score: 9, confluence: ['pine'],
      candles: c, createdAt: new Date(T0 + 39.5 * H),
    });
    expect(r.structureBroken).toBe(true);
    expect(r.kill?.reason).toBe('structure_broken');
  });

  it('Score fällt unter 6,5 → score_below_threshold', () => {
    const c = trendCandles(10, 100, 0); // Close 100, RR1 = 1/2 → 1,5
    const r = assessOpenSignal({
      direction: 'long', stopLoss: 98, takeProfits: [101], score: 7.5, confluence: ['score:rr-basiert'],
      candles: c, createdAt: new Date(T0 + 9.5 * H),
    });
    expect(r.score).toBeCloseTo(1.5, 5);
    expect(r.kill?.reason).toBe('score_below_threshold');
  });

  it('Score war schon bei Erstellung < 6,5 und ist NICHT gefallen → kein Kill (§9: „fällt")', () => {
    const c = trendCandles(10, 100, 0);
    const r = assessOpenSignal({
      direction: 'long', stopLoss: 98, takeProfits: [102], score: 3, confluence: ['score:rr-basiert'],
      candles: c, createdAt: new Date(T0 + 9.5 * H),
    });
    expect(r.score).toBeCloseTo(3, 5);
    expect(r.kill).toBeNull();
  });

  it('Gesundes Setup → kein Kill', () => {
    const c = trendCandles(250, 100, 1);
    const r = assessOpenSignal({
      direction: 'long', stopLoss: 340, takeProfits: [380], score: 9.5, confluence: SMC_TAGS,
      candles: c, createdAt, higherTfTrend: 'bull',
    });
    expect(r.kill).toBeNull();
  });
});

describe('evaluateReentry (§9: Pullback-Fenster → zweite Einstiegschance)', () => {
  const plan = deriveReentryPlan({ direction: 'long', setupType: 'swing', entry: 100, stopLoss: 95 });
  const base = { plan, direction: 'long' as const, stopLoss: 95, takeProfits: [105, 110], structureBroken: false, rescoredScore: 8 };

  it('Preis im Fenster, Struktur intakt, Score ≥ 6,5 → Trigger mit Entry = Live-Preis', () => {
    const r = evaluateReentry({ ...base, price: 98 });
    expect(r).toEqual({ trigger: true, entry: 98 });
  });

  it('Preis außerhalb des Fensters → kein Trigger', () => {
    expect(evaluateReentry({ ...base, price: 99 }).trigger).toBe(false);
    expect(evaluateReentry({ ...base, price: 97 }).trigger).toBe(false);
  });

  it('Plan deaktiviert / Struktur gebrochen / Score zu niedrig / nicht bewertbar → kein Trigger', () => {
    expect(evaluateReentry({ ...base, price: 98, plan: { ...plan, enabled: false } }).reason).toBe('plan_disabled');
    expect(evaluateReentry({ ...base, price: 98, structureBroken: true }).reason).toBe('structure_broken');
    expect(evaluateReentry({ ...base, price: 98, rescoredScore: 6 }).reason).toBe('score_below_threshold');
    expect(evaluateReentry({ ...base, price: 98, rescoredScore: null }).reason).toBe('not_rescorable');
  });

  it('Generation am Limit → kein weiterer Reentry', () => {
    expect(evaluateReentry({ ...base, price: 98, plan: { ...plan, generation: 1 } }).reason).toBe('max_reentries');
  });

  it('Short spiegelbildlich', () => {
    const p = deriveReentryPlan({ direction: 'short', setupType: 'swing', entry: 100, stopLoss: 105 });
    const r = evaluateReentry({ plan: p, direction: 'short', stopLoss: 105, takeProfits: [95], structureBroken: false, rescoredScore: 8, price: 102 });
    expect(r).toEqual({ trigger: true, entry: 102 });
  });
});

describe('evaluateLeverageUpgrade (§9: Bewegung ≥ Trigger + Bestätigung, gedeckelt)', () => {
  const plan = deriveLeverageUpgradePlan('swing'); // +5 %, ×1,5, max 10
  const base = { plan, direction: 'long' as const, entryPrice: 100, currentLeverage: 2, riskMaxLeverage: 10, stopPrice: 100 };

  it('Bewegung ≥ Trigger UND Stop sichert Entry (nach TP1/Break-Even) → Vorschlag ×Faktor', () => {
    const r = evaluateLeverageUpgrade({ ...base, price: 105 });
    expect(r).toMatchObject({ suggested: 3, from: 2, movePct: 5 });
  });

  it('Bewegung zu klein → kein Vorschlag', () => {
    expect(evaluateLeverageUpgrade({ ...base, price: 104.9 })).toBeNull();
  });

  it('ohne Bestätigung (Stop noch unter Entry) → kein Vorschlag', () => {
    expect(evaluateLeverageUpgrade({ ...base, price: 110, stopPrice: 95 })).toBeNull();
    expect(evaluateLeverageUpgrade({ ...base, price: 110, stopPrice: null })).toBeNull();
  });

  it('Deckel: Setup-Max UND Risk-Engine-Max (das kleinere gewinnt)', () => {
    const p = deriveLeverageUpgradePlan('position'); // ×5 max 50
    expect(evaluateLeverageUpgrade({ ...base, plan: p, price: 110, currentLeverage: 4, riskMaxLeverage: 10 })!.suggested).toBe(10);
    expect(evaluateLeverageUpgrade({ ...base, plan: p, price: 110, currentLeverage: 4, riskMaxLeverage: 100 })!.suggested).toBe(20);
  });

  it('bereits am Deckel → kein Vorschlag', () => {
    expect(evaluateLeverageUpgrade({ ...base, price: 110, currentLeverage: 10 })).toBeNull();
  });

  it('Short spiegelbildlich', () => {
    const r = evaluateLeverageUpgrade({ ...base, direction: 'short', price: 95, stopPrice: 100, currentLeverage: 1 });
    expect(r).toMatchObject({ suggested: 1.5, from: 1 });
  });
});
