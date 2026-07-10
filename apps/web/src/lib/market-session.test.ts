import { describe, expect, it } from 'vitest';
import { currentSessionEnd, nextSessionStart, sessionAt } from './market-session.js';

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 6, 10, h, m));

describe('sessionAt (identische UTC-Fenster wie die Engine)', () => {
  it('Asia 00–07, London 07–13, Overlap 13–16, New York 16–21, sonst off', () => {
    expect(sessionAt(at(0))).toBe('asia');
    expect(sessionAt(at(6, 59))).toBe('asia');
    expect(sessionAt(at(7))).toBe('london');
    expect(sessionAt(at(12, 59))).toBe('london');
    expect(sessionAt(at(13))).toBe('overlap');
    expect(sessionAt(at(15, 59))).toBe('overlap');
    expect(sessionAt(at(16))).toBe('newyork');
    expect(sessionAt(at(20, 59))).toBe('newyork');
    expect(sessionAt(at(21))).toBe('off');
    expect(sessionAt(at(23))).toBe('off');
  });
});

describe('nextSessionStart / currentSessionEnd', () => {
  it('nach New York kommt Asia am Folgetag 00:00 UTC', () => {
    const n = nextSessionStart(at(22));
    expect(n.session).toBe('asia');
    expect(n.startsAt.getUTCDate()).toBe(11);
    expect(n.startsAt.getUTCHours()).toBe(0);
  });

  it('mitten in London endet die Session um 13:00 UTC', () => {
    const end = currentSessionEnd(at(9, 30));
    expect(end?.getUTCHours()).toBe(13);
    expect(currentSessionEnd(at(22))).toBeNull();
  });

  it('vor London startet London um 07:00 UTC (in der Off-Zeit gibt es keinen Vor-Start am selben Tag)', () => {
    // 05:00 UTC läuft Asia — nächster Start ist London 07:00
    const n = nextSessionStart(at(5));
    expect(n.session).toBe('london');
    expect(n.startsAt.getUTCHours()).toBe(7);
  });
});
