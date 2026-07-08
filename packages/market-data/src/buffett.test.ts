import { describe, expect, it } from 'vitest';
import { buffettScore, computeBuffettRatio, deriveBuffettStatus, type BuffettPoint } from './buffett.js';

describe('computeBuffettRatio', () => {
  it('teilt Zähler durch Nenner', () => {
    expect(computeBuffettRatio(40000, 25000)).toBeCloseTo(1.6);
  });
  it('null bei ungültigem Nenner', () => {
    expect(computeBuffettRatio(40000, 0)).toBeNull();
    expect(computeBuffettRatio(40000, -1)).toBeNull();
    expect(computeBuffettRatio(NaN, 25000)).toBeNull();
  });
});

function hist(values: number[]): BuffettPoint[] {
  return values.map((v, i) => ({ ts: new Date(Date.UTC(2020, 0, 1 + i)), ratio: v }));
}

describe('deriveBuffettStatus (perzentil-basiert, selbstkalibrierend)', () => {
  it('not_applicable bei zu wenig Historie', () => {
    expect(deriveBuffettStatus(hist([1, 1.1, 1.2])).status).toBe('not_applicable');
  });

  it('neutral im mittleren Bereich', () => {
    const values = Array.from({ length: 20 }, (_, i) => 1 + i * 0.05);
    // aktueller Wert = Median-nah → einer aus der Mitte ans Ende hängen
    const h = hist([...values, 1.5]);
    expect(deriveBuffettStatus(h).status).toBe('neutral');
  });

  it('extreme, wenn aktueller Wert historisch am höchsten', () => {
    const values = Array.from({ length: 20 }, (_, i) => 1 + i * 0.05);
    const h = hist([...values, 5.0]); // deutlich über allem
    const res = deriveBuffettStatus(h);
    expect(res.percentile).toBeGreaterThanOrEqual(0.9);
    expect(res.status).toBe('extreme');
  });

  it('elevated im oberen Viertel (aber nicht extrem)', () => {
    // 21 Werte 1.00..2.00; Kandidat bei Perzentil ~0.8
    const base = Array.from({ length: 20 }, (_, i) => 1 + i * 0.05);
    const candidate = base[16]!; // ~0.8 Perzentil
    const res = deriveBuffettStatus(hist([...base, candidate]));
    expect(res.status).toBe('elevated');
  });
});

describe('buffettScore', () => {
  it('neutral für nicht-Aktienmärkte (not_applicable)', () => {
    expect(buffettScore('not_applicable', 'long')).toBe(0.5);
  });
  it('bestraft Longs bei hoher Bewertung stärker als bei neutraler', () => {
    expect(buffettScore('extreme', 'long')).toBeLessThan(buffettScore('neutral', 'long'));
    expect(buffettScore('extreme', 'long')).toBeLessThan(buffettScore('elevated', 'long'));
  });
  it('stützt Shorts bei hoher Bewertung', () => {
    expect(buffettScore('extreme', 'short')).toBeGreaterThan(0.6);
  });
  it('bleibt in [0,1]', () => {
    for (const s of ['not_applicable', 'neutral', 'elevated', 'extreme'] as const) {
      for (const d of ['long', 'short'] as const) {
        const v = buffettScore(s, d);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});
