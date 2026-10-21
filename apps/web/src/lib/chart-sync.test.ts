import { describe, expect, it } from 'vitest';
import { barIndexAt, joinSyncGroup, syncGroupSize, type SyncEvent } from './chart-sync.js';

describe('chart-sync: Gruppe', () => {
  it('Mitglieder bekommen fremde Ereignisse, nie das eigene; Gruppen sind getrennt', () => {
    const got: Record<string, SyncEvent[]> = { a: [], b: [], c: [] };
    const a = joinSyncGroup('g1', (ev) => got.a!.push(ev));
    const b = joinSyncGroup('g1', (ev) => got.b!.push(ev));
    const c = joinSyncGroup('g2', (ev) => got.c!.push(ev));
    a.publish({ kind: 'crosshair', time: 100 });
    expect(got.a).toEqual([]);
    expect(got.b).toEqual([{ kind: 'crosshair', time: 100 }]);
    expect(got.c).toEqual([]);
    b.publish({ kind: 'range', from: 1, to: 2 });
    expect(got.a).toEqual([{ kind: 'range', from: 1, to: 2 }]);
    expect(syncGroupSize('g1')).toBe(2);
    a.leave();
    b.publish({ kind: 'crosshair', time: null });
    expect(got.a).toHaveLength(1);
    b.leave();
    c.leave();
    expect(syncGroupSize('g1')).toBe(0);
    expect(syncGroupSize('g2')).toBe(0);
  });
});

describe('chart-sync: barIndexAt', () => {
  const times = [0, 3600, 7200, 10800]; // Stundenkerzen
  it('findet die Kerze, in die der Zeitpunkt fällt', () => {
    expect(barIndexAt(times, 0)).toBe(0);
    expect(barIndexAt(times, 3599)).toBe(0);
    expect(barIndexAt(times, 3600)).toBe(1);
    expect(barIndexAt(times, 9000)).toBe(2);
    expect(barIndexAt(times, 10800)).toBe(3);
    expect(barIndexAt(times, 14399)).toBe(3);
  });
  it('vor der ersten und deutlich nach der letzten Kerze: keine', () => {
    expect(barIndexAt(times, -1)).toBe(-1);
    expect(barIndexAt(times, 14400)).toBe(-1);
    expect(barIndexAt([], 5)).toBe(-1);
    expect(barIndexAt([60], 60)).toBe(0);
  });
});
