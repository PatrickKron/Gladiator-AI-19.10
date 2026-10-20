import { describe, expect, it } from 'vitest';
import { barSpacingSec, stepTrade, tradeFocusRange } from './trade-view.js';

describe('tradeFocusRange', () => {
  it('Trade-Spanne plus Rand in Kerzen auf beiden Seiten', () => {
    // 1h-Kerzen, Trade über 10 Kerzen, 15 Kerzen Rand
    expect(tradeFocusRange(36_000, 72_000, 3_600, 15)).toEqual({ from: 36_000 - 15 * 3_600, to: 72_000 + 15 * 3_600 });
  });

  it('Entry = Exit (Ausstieg in der Folgekerze) → trotzdem sichtbares Fenster', () => {
    const r = tradeFocusRange(36_000, 36_000, 3_600, 15);
    expect(r.to - r.from).toBe(30 * 3_600);
  });

  it('vertauschte Zeiten werden nicht zu einem negativen Fenster', () => {
    const r = tradeFocusRange(72_000, 36_000, 3_600, 5);
    expect(r.from).toBeLessThan(r.to);
    expect(r).toEqual({ from: 36_000 - 5 * 3_600, to: 72_000 + 5 * 3_600 });
  });

  it('bleibt im geladenen Kerzenfenster', () => {
    const r = tradeFocusRange(36_000, 72_000, 3_600, 15, { first: 30_000, last: 80_000 });
    expect(r).toEqual({ from: 30_000, to: 80_000 });
  });
});

describe('stepTrade', () => {
  it('ohne Auswahl: vor → erster, zurück → letzter Trade', () => {
    expect(stepTrade(null, 1, 5)).toBe(0);
    expect(stepTrade(null, -1, 5)).toBe(4);
  });

  it('bleibt an den Enden stehen (kein Umlauf)', () => {
    expect(stepTrade(4, 1, 5)).toBe(4);
    expect(stepTrade(0, -1, 5)).toBe(0);
    expect(stepTrade(2, 1, 5)).toBe(3);
  });

  it('keine Trades → keine Auswahl', () => {
    expect(stepTrade(null, 1, 0)).toBeNull();
    expect(stepTrade(3, -1, 0)).toBeNull();
  });
});

describe('barSpacingSec', () => {
  it('kleinster Abstand zwischen Kerzen (Lücken verfälschen nichts)', () => {
    expect(barSpacingSec([{ time: 0 }, { time: 7_200 }, { time: 10_800 }, { time: 14_400 }])).toBe(3_600);
  });

  it('weniger als zwei Kerzen → null', () => {
    expect(barSpacingSec([{ time: 0 }])).toBeNull();
    expect(barSpacingSec([])).toBeNull();
  });
});
