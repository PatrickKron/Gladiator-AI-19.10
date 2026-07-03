import { describe, expect, it } from 'vitest';
import { planFills, type OpenProtectionOrder } from './lifecycle.js';

/**
 * Reine Fill-Planung des PositionMonitors: Welche Schutz-Orders (TP/SL)
 * greifen beim aktuellen ECHTEN Preis? Konservativ: SL vor TP.
 */

function orders(): OpenProtectionOrder[] {
  return [
    { id: 'sl', type: 'stop_market', triggerPrice: 90, qtyFraction: 1 },
    { id: 'tp1', type: 'take_profit_market', triggerPrice: 110, qtyFraction: 0.5 },
    { id: 'tp2', type: 'take_profit_market', triggerPrice: 120, qtyFraction: 0.3 },
    { id: 'tp3', type: 'take_profit_market', triggerPrice: 130, qtyFraction: 0.2 },
  ];
}

describe('planFills (Long)', () => {
  it('kein Trigger im neutralen Bereich', () => {
    expect(planFills('long', orders(), 100)).toEqual([]);
  });

  it('SL triggert unter dem Stop', () => {
    const fills = planFills('long', orders(), 89);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ id: 'sl', closesPosition: true });
  });

  it('TP1 triggert über dem Ziel — nur TP1, Rest bleibt offen', () => {
    const fills = planFills('long', orders(), 111);
    expect(fills.map((f) => f.id)).toEqual(['tp1']);
    expect(fills[0]!.closesPosition).toBe(false);
  });

  it('Preis über TP2: TP1 und TP2 füllen in Reihenfolge', () => {
    const fills = planFills('long', orders(), 125);
    expect(fills.map((f) => f.id)).toEqual(['tp1', 'tp2']);
  });

  it('letzter TP schließt die Position', () => {
    const fills = planFills('long', orders(), 131);
    expect(fills.map((f) => f.id)).toEqual(['tp1', 'tp2', 'tp3']);
    expect(fills[2]!.closesPosition).toBe(true);
  });

  it('KONSERVATIV: SL und TP gleichzeitig erreichbar → nur SL', () => {
    // Preis-Check minütlich: wenn der Preis unter Stop liegt, zählt der Stop —
    // auch wenn ein TP theoretisch zwischendurch erreicht worden sein könnte.
    const fills = planFills('long', orders(), 85);
    expect(fills.map((f) => f.id)).toEqual(['sl']);
  });
});

describe('planFills (Short, gespiegelt)', () => {
  const shortOrders: OpenProtectionOrder[] = [
    { id: 'sl', type: 'stop_market', triggerPrice: 110, qtyFraction: 1 },
    { id: 'tp1', type: 'take_profit_market', triggerPrice: 90, qtyFraction: 0.5 },
    { id: 'tp2', type: 'take_profit_market', triggerPrice: 80, qtyFraction: 0.5 },
  ];

  it('Short-SL triggert über dem Stop', () => {
    expect(planFills('short', shortOrders, 112).map((f) => f.id)).toEqual(['sl']);
  });

  it('Short-TPs triggern unter dem Ziel', () => {
    expect(planFills('short', shortOrders, 79).map((f) => f.id)).toEqual(['tp1', 'tp2']);
  });
});
