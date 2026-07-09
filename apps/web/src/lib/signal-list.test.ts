import { describe, expect, it } from 'vitest';
import {
  ageText,
  decodeListFilters,
  encodeListFilters,
  expiryLeftMs,
  formatDuration,
  splitByExpiry,
  swarmVerdict,
  type ReviewLite,
} from './signal-list.js';
import { DEFAULT_FILTERS } from './signal-filters.js';

const rev = (agent: string, vote: ReviewLite['vote'], confidence = 0.8, reason = `${agent}-${vote}`): ReviewLite => ({
  agent,
  vote,
  confidence,
  reason,
});

describe('swarmVerdict', () => {
  it('gibt null-Urteil ohne Reviews (Review ausstehend)', () => {
    const v = swarmVerdict([]);
    expect(v.vote).toBeNull();
    expect(v.confidence).toBeNull();
    expect(v.riskReject).toBeNull();
    expect(v.lines).toEqual([]);
  });

  it('Portfolio-Urteil gewinnt als finale Instanz', () => {
    const v = swarmVerdict([rev('technik', 'confirm'), rev('portfolio', 'reject', 0.95)]);
    expect(v.vote).toBe('reject');
    expect(v.confidence).toBe(0.95);
  });

  it('ohne Portfolio zählt das schlechteste Einzelurteil (konservativ)', () => {
    const v = swarmVerdict([rev('technik', 'confirm'), rev('devil', 'caution', 0.6)]);
    expect(v.vote).toBe('caution');
    expect(v.confidence).toBe(0.6);
  });

  it('meldet das harte Risk-Veto separat — Live-Befund: Risk lehnt oft ALLE Signale ab', () => {
    const v = swarmVerdict([
      rev('risk', 'reject', 0.95, 'Margin reicht nicht (14004.72 > 10000.00).'),
      rev('portfolio', 'reject', 0.95),
    ]);
    expect(v.riskReject).toBe('Margin reicht nicht (14004.72 > 10000.00).');
  });

  it('Risk mit caution ist KEIN Veto', () => {
    const v = swarmVerdict([rev('risk', 'caution'), rev('portfolio', 'confirm')]);
    expect(v.riskReject).toBeNull();
    expect(v.vote).toBe('confirm');
  });

  it('sortiert Portfolio in den Tooltip-Zeilen ans Ende', () => {
    const v = swarmVerdict([rev('portfolio', 'reject'), rev('technik', 'confirm')]);
    expect(v.lines.map((l) => l.agent)).toEqual(['technik', 'portfolio']);
  });
});

describe('splitByExpiry', () => {
  const row = (id: string, status: string, createdAt: string) => ({ id, status, createdAt });

  it('neueste zuerst, Abgelaufene als eigener Block ans Ende', () => {
    const { active, expired } = splitByExpiry([
      row('a', 'new', '2026-07-08T10:00:00Z'),
      row('b', 'expired', '2026-07-09T09:00:00Z'),
      row('c', 'confirmed', '2026-07-09T11:00:00Z'),
      row('d', 'expired', '2026-07-05T08:00:00Z'),
    ]);
    expect(active.map((r) => r.id)).toEqual(['c', 'a']);
    expect(expired.map((r) => r.id)).toEqual(['b', 'd']);
  });

  it('kommt mit Date-Objekten und leeren Listen klar', () => {
    expect(splitByExpiry([])).toEqual({ active: [], expired: [] });
    const { active } = splitByExpiry([{ status: 'new', createdAt: new Date('2026-07-09T00:00:00Z') }]);
    expect(active).toHaveLength(1);
  });
});

describe('expiryLeftMs / formatDuration / ageText', () => {
  const now = Date.parse('2026-07-09T12:00:00Z');

  it('berechnet Restlaufzeit nach Timeframe-TTL (1h → 12 h)', () => {
    const created = '2026-07-09T10:00:00Z'; // vor 2 h → 10 h übrig
    expect(expiryLeftMs(created, '1h', now)).toBe(10 * 3_600_000);
  });

  it('negativ = überfällig; unbekannter Timeframe fällt auf 24 h zurück', () => {
    expect(expiryLeftMs('2026-07-09T07:00:00Z', '15m', now)).toBeLessThan(0); // TTL 4 h, 5 h alt
    expect(expiryLeftMs('2026-07-09T00:00:00Z', 'weird', now)).toBe(12 * 3_600_000);
  });

  it('formatiert grob und scanbar: min → h → T', () => {
    expect(formatDuration(5 * 60_000)).toBe('5 min');
    expect(formatDuration(3 * 3_600_000)).toBe('3 h');
    expect(formatDuration(3 * 86_400_000)).toBe('3 T');
    expect(formatDuration(0)).toBe('1 min'); // nie „0 min" anzeigen
  });

  it('ageText: Alter relativ zu jetzt, nie negativ', () => {
    expect(ageText('2026-07-09T10:00:00Z', now)).toBe('2 h');
    expect(ageText('2026-07-09T13:00:00Z', now)).toBe('1 min'); // Uhr-Skew → nicht negativ
  });
});

describe('encodeListFilters / decodeListFilters (Listen-Default = all)', () => {
  it('leerer Hash → Status all (Liste zeigt alles, Abgelaufene gedimmt hinten)', () => {
    expect(decodeListFilters('#/signals').status).toBe('all');
    expect(decodeListFilters('').status).toBe('all');
  });

  it('explizite Wahl „new" überlebt den Roundtrip (in signal-filters wäre new Default und fiele weg)', () => {
    const f = { ...DEFAULT_FILTERS, status: 'new' };
    const q = encodeListFilters(f);
    expect(q).toContain('status=new');
    expect(decodeListFilters('#/signals?' + q).status).toBe('new');
  });

  it('„all" bleibt aus der URL (kurze Links), Roundtrip stabil', () => {
    const f = { ...DEFAULT_FILTERS, status: 'all' };
    const q = encodeListFilters(f);
    expect(q).not.toContain('status');
    expect(decodeListFilters('#/signals?' + q).status).toBe('all');
  });

  it('andere Filter laufen unverändert durch den Wrapper', () => {
    const f = { ...DEFAULT_FILTERS, status: 'expired', symbol: 'ETH/USDT', direction: 'long', favoritesOnly: true };
    const back = decodeListFilters('#/signals?' + encodeListFilters(f));
    expect(back).toEqual(f);
  });
});
