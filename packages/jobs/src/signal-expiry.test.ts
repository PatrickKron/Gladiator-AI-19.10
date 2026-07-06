import { describe, expect, it } from 'vitest';
import { SIGNAL_TTL_HOURS, isSignalExpired, signalExpiryCutoff } from './signal-expiry.js';

const now = new Date('2026-07-06T12:00:00Z');

describe('Signal-Ablauf (TTL je Timeframe)', () => {
  it('frisches Signal läuft NICHT ab', () => {
    const created = new Date('2026-07-06T11:30:00Z'); // 30 min alt
    expect(isSignalExpired(created, '1h', now)).toBe(false);
  });

  it('1h-Signal läuft nach der TTL ab (12 h)', () => {
    const fresh = new Date('2026-07-06T01:00:00Z'); // 11 h alt → noch gültig
    const stale = new Date('2026-07-05T23:00:00Z'); // 13 h alt → abgelaufen
    expect(isSignalExpired(fresh, '1h', now)).toBe(false);
    expect(isSignalExpired(stale, '1h', now)).toBe(true);
  });

  it('kurze Timeframes laufen schneller ab als lange (15m < 1d)', () => {
    const cutoff15m = signalExpiryCutoff('15m', now).getTime();
    const cutoff1d = signalExpiryCutoff('1d', now).getTime();
    // 15m-Cutoff liegt NÄHER an jetzt (kürzere TTL) als der 1d-Cutoff
    expect(cutoff15m).toBeGreaterThan(cutoff1d);
  });

  it('unbekannter Timeframe nutzt eine sichere Standard-TTL (24 h), läuft nicht sofort ab', () => {
    const created = new Date('2026-07-06T01:00:00Z'); // 11 h alt
    expect(isSignalExpired(created, '3h', now)).toBe(false);
    const old = new Date('2026-07-05T06:00:00Z'); // 30 h alt
    expect(isSignalExpired(old, '3h', now)).toBe(true);
  });

  it('alle Scan-Timeframes haben eine positive TTL', () => {
    for (const tf of ['15m', '1h', '4h', '1d']) {
      expect(SIGNAL_TTL_HOURS[tf]).toBeGreaterThan(0);
    }
  });
});
