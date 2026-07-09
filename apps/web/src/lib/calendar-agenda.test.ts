import { describe, expect, it } from 'vitest';
import {
  buildAgenda,
  countdownParts,
  dayKey,
  isNoTradeEvent,
  isPast,
  nextHighImpact,
  severityOf,
  startOfWeekMonday,
  type AgendaEventLike,
} from './calendar-agenda.js';

/**
 * Agenda-Logik des Makro-Kalenders (pur, node-env): Gruppierung, Lücken-Faltung,
 * Countdown und No-Trade-Kennzeichnung. Alle Daten lokal konstruiert (new Date(y,m,d))
 * → Zeitzonen-unabhängig deterministisch.
 */

const ev = (over: Partial<AgendaEventLike> & { scheduledAt: Date }): AgendaEventLike => ({
  importance: 2,
  impact: null,
  ...over,
});

describe('severityOf / isNoTradeEvent / isPast', () => {
  it('severity: serverseitige Klassifikation gewinnt vor roher importance', () => {
    expect(severityOf(ev({ scheduledAt: new Date(), importance: 1, impact: { severity: 3 } }))).toBe(3);
    expect(severityOf(ev({ scheduledAt: new Date(), importance: 2 }))).toBe(2);
    expect(severityOf({ scheduledAt: new Date() })).toBe(1);
  });

  it('No-Trade spiegelt EXAKT die Risk-Engine (importance ≥ 3, NICHT severity)', () => {
    expect(isNoTradeEvent(ev({ scheduledAt: new Date(), importance: 3 }))).toBe(true);
    // severity 3, aber importance 2 → Risk-Engine blockt NICHT → UI darf es nicht behaupten
    expect(isNoTradeEvent(ev({ scheduledAt: new Date(), importance: 2, impact: { severity: 3 } }))).toBe(false);
    expect(isNoTradeEvent({ scheduledAt: new Date() })).toBe(false);
  });

  it('isPast: Startzeit vor jetzt → vergangen', () => {
    const now = new Date(2026, 6, 9, 12, 0);
    expect(isPast(ev({ scheduledAt: new Date(2026, 6, 9, 11, 59) }), now)).toBe(true);
    expect(isPast(ev({ scheduledAt: new Date(2026, 6, 9, 12, 1) }), now)).toBe(false);
  });
});

describe('startOfWeekMonday / dayKey', () => {
  it('liefert Montag für jeden Wochentag', () => {
    // 2026-07-09 ist ein Donnerstag → Montag = 2026-07-06
    expect(dayKey(startOfWeekMonday(new Date(2026, 6, 9)))).toBe('2026-07-06');
    // Sonntag gehört noch zur laufenden Woche
    expect(dayKey(startOfWeekMonday(new Date(2026, 6, 12)))).toBe('2026-07-06');
    // Montag bleibt Montag
    expect(dayKey(startOfWeekMonday(new Date(2026, 6, 6)))).toBe('2026-07-06');
  });
});

describe('buildAgenda', () => {
  const mon = new Date(2026, 6, 6); // Mo
  const nextMon = new Date(2026, 6, 13);

  it('gruppiert nach Tagen, sortiert Events innerhalb des Tages nach Uhrzeit', () => {
    const late = ev({ scheduledAt: new Date(2026, 6, 7, 14, 30) });
    const early = ev({ scheduledAt: new Date(2026, 6, 7, 8, 0) });
    const sections = buildAgenda([late, early], mon, nextMon);
    const day = sections.find((s) => s.kind === 'day');
    expect(day).toBeDefined();
    expect(day!.kind === 'day' && day!.events).toEqual([early, late]);
  });

  it('faltet zusammenhängende leere Tage zu EINER Lücke (auch an den Rändern)', () => {
    const wed = ev({ scheduledAt: new Date(2026, 6, 8, 10, 0) });
    const sections = buildAgenda([wed], mon, nextMon);
    // Mo–Di Lücke (2 Tage), Mi Events, Do–So Lücke (4 Tage)
    expect(sections.map((s) => s.kind)).toEqual(['gap', 'day', 'gap']);
    const [lead, , trail] = sections;
    expect(lead!.kind === 'gap' && lead!.days).toBe(2);
    expect(trail!.kind === 'gap' && trail!.days).toBe(4);
    expect(trail!.kind === 'gap' && dayKey(trail!.from)).toBe('2026-07-09');
    expect(trail!.kind === 'gap' && dayKey(trail!.to)).toBe('2026-07-12');
  });

  it('leerer Zeitraum → genau eine Lücke über alle Tage', () => {
    const sections = buildAgenda([], mon, nextMon);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.kind === 'gap' && sections[0]!.days).toBe(7);
  });

  it('pinned (heute) erscheint IMMER als Tag, auch ohne Events, und teilt die Lücke', () => {
    const today = new Date(2026, 6, 9);
    const sections = buildAgenda([], mon, nextMon, today);
    expect(sections.map((s) => s.kind)).toEqual(['gap', 'day', 'gap']);
    const day = sections[1]!;
    expect(day.kind === 'day' && dayKey(day.date)).toBe('2026-07-09');
    expect(day.kind === 'day' && day.events).toEqual([]);
  });

  it('pinned außerhalb des Zeitraums hat keinen Effekt', () => {
    const sections = buildAgenda([], mon, nextMon, new Date(2026, 7, 1));
    expect(sections).toHaveLength(1);
    expect(sections[0]!.kind).toBe('gap');
  });

  it('Events außerhalb des Zeitraums erzeugen keine Tage', () => {
    const outside = ev({ scheduledAt: new Date(2026, 6, 20, 9, 0) });
    const sections = buildAgenda([outside], mon, nextMon);
    expect(sections.every((s) => s.kind === 'gap')).toBe(true);
  });
});

describe('countdownParts', () => {
  const now = new Date(2026, 6, 9, 12, 0, 0);

  it('2 h 15 min → {h:2, m:15}', () => {
    expect(countdownParts(new Date(2026, 6, 9, 14, 15), now)).toEqual({ h: 2, m: 15 });
  });

  it('unter einer Stunde → {h:0, m:45}', () => {
    expect(countdownParts(new Date(2026, 6, 9, 12, 45), now)).toEqual({ h: 0, m: 45 });
  });

  it('unter einer Minute → {h:0, m:0} („jetzt gleich")', () => {
    expect(countdownParts(new Date(2026, 6, 9, 12, 0, 30), now)).toEqual({ h: 0, m: 0 });
  });

  it('vergangen → null', () => {
    expect(countdownParts(new Date(2026, 6, 9, 11, 59), now)).toBeNull();
  });
});

describe('nextHighImpact', () => {
  const now = new Date(2026, 6, 9, 12, 0);

  it('findet das zeitlich nächste zukünftige High-Impact-Event', () => {
    const later = ev({ scheduledAt: new Date(2026, 6, 10, 14, 30), importance: 3 });
    const sooner = ev({ scheduledAt: new Date(2026, 6, 9, 14, 30), importance: 3 });
    expect(nextHighImpact([later, sooner], now)).toBe(sooner);
  });

  it('ignoriert vergangene und Low/Medium-Events', () => {
    const past = ev({ scheduledAt: new Date(2026, 6, 9, 11, 0), importance: 3 });
    const medium = ev({ scheduledAt: new Date(2026, 6, 9, 13, 0), importance: 2 });
    expect(nextHighImpact([past, medium], now)).toBeNull();
  });

  it('Anzeige-severity zählt: impact.severity 3 qualifiziert auch bei importance 2', () => {
    const classified = ev({ scheduledAt: new Date(2026, 6, 9, 15, 0), importance: 2, impact: { severity: 3 } });
    expect(nextHighImpact([classified], now)).toBe(classified);
  });

  it('leere Liste → null', () => {
    expect(nextHighImpact([], now)).toBeNull();
  });
});
