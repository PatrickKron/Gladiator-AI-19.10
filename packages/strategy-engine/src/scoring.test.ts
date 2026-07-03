import { describe, expect, it } from 'vitest';
import { computeScore, riskClassOf } from './scoring.js';
import { sessionOf } from './session.js';

describe('Session-Gating (05_ §8, UTC-Fenster inkl. Overlap)', () => {
  it('ordnet UTC-Stunden den Sessions zu', () => {
    expect(sessionOf(new Date('2026-07-03T02:00:00Z'))).toBe('asia');
    expect(sessionOf(new Date('2026-07-03T09:00:00Z'))).toBe('london');
    expect(sessionOf(new Date('2026-07-03T14:00:00Z'))).toBe('overlap');
    expect(sessionOf(new Date('2026-07-03T17:00:00Z'))).toBe('newyork');
    expect(sessionOf(new Date('2026-07-03T22:30:00Z'))).toBe('off');
  });
});

describe('Confluence-Scoring (05_ §6 — exakte Gewichte, NIE hartkodiert)', () => {
  const base = {
    trendAligned: true,
    structureBreak: true,
    validRetest: true,
    rsiInBand: true,
    volumeConfirmed: true,
    fvgTarget: false,
    sessionActive: false,
    rrAtLeast2: false,
    higherTf: 'neutral' as const,
    counterConfluence: false,
  };

  it('Pflicht-Confluence allein ergibt 7.0 (1.5+1.5+2+1+1)', () => {
    const { score } = computeScore(base);
    expect(score).toBe(7);
  });

  it('addiert optionale Faktoren exakt nach Tabelle', () => {
    expect(computeScore({ ...base, rrAtLeast2: true }).score).toBe(8);
    expect(computeScore({ ...base, rrAtLeast2: true, sessionActive: true }).score).toBe(8.5);
    expect(computeScore({ ...base, rrAtLeast2: true, sessionActive: true, fvgTarget: true }).score).toBe(9.5);
  });

  it('deckelt bei 10 (alle Faktoren = 10.5 → 10)', () => {
    const { score } = computeScore({
      ...base,
      fvgTarget: true,
      sessionActive: true,
      rrAtLeast2: true,
      higherTf: 'aligned',
    });
    expect(score).toBe(10);
  });

  it('Gegen-Confluence und höhere TF dagegen ziehen ab', () => {
    expect(computeScore({ ...base, counterConfluence: true }).score).toBe(6);
    expect(computeScore({ ...base, higherTf: 'opposed' }).score).toBe(6);
  });

  it('liefert die Confluence-Tags für die Signal-Karte', () => {
    const { confluence } = computeScore({ ...base, fvgTarget: true, higherTf: 'aligned' });
    expect(confluence).toContain('Struktur-Bruch');
    expect(confluence).toContain('Retest@EMA/Level');
    expect(confluence).toContain('FVG-Ziel');
    expect(confluence).toContain('Higher-TF bestätigt');
  });

  it('Risk-Klassen: ≥8 low, 6–7.9 medium, <6 high (05_ §6)', () => {
    expect(riskClassOf(8.2)).toBe('low');
    expect(riskClassOf(7.0)).toBe('medium');
    expect(riskClassOf(5.9)).toBe('high');
  });
});
