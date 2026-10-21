import { describe, expect, it } from 'vitest';
import { buildTodayItems, eventPriority, notificationPriority, signalPriority } from './today-items.js';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const iso = (offsetMin: number) => new Date(NOW + offsetMin * 60_000).toISOString();

describe('„Heute wichtig": Rangfolge aus echten Quellen', () => {
  it('Signale: Score zählt am meisten, frische vor alten', () => {
    const a = signalPriority({ id: 'a', symbol: 'BTC/USDT', direction: 'long', score: 9.5, createdAt: iso(-30), timeframe: '1h' }, NOW);
    const b = signalPriority({ id: 'b', symbol: 'ETH/USDT', direction: 'long', score: 9.5, createdAt: iso(-600), timeframe: '1h' }, NOW);
    const c = signalPriority({ id: 'c', symbol: 'SOL/USDT', direction: 'short', score: 6, createdAt: iso(-1), timeframe: '1h' }, NOW);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it('Termine: nur kommende mit mittlerem/hohem Impact innerhalb 24 h; näher = wichtiger', () => {
    expect(eventPriority({ id: '1', title: 'CPI', importance: 3, scheduledAt: iso(90), currency: 'USD' }, NOW)).toBeGreaterThan(0);
    expect(eventPriority({ id: '2', title: 'CPI', importance: 3, scheduledAt: iso(-10), currency: 'USD' }, NOW)).toBeNull(); // vorbei
    expect(eventPriority({ id: '3', title: 'Rede', importance: 1, scheduledAt: iso(60), currency: 'EUR' }, NOW)).toBeNull(); // niedrig
    expect(eventPriority({ id: '4', title: 'NFP', importance: 3, scheduledAt: iso(60 * 30), currency: 'USD' }, NOW)).toBeNull(); // > 24 h
    const near = eventPriority({ id: '5', title: 'CPI', importance: 3, scheduledAt: iso(60), currency: 'USD' }, NOW)!;
    const far = eventPriority({ id: '6', title: 'CPI', importance: 3, scheduledAt: iso(60 * 20), currency: 'USD' }, NOW)!;
    expect(near).toBeGreaterThan(far);
  });

  it('Ereignisse: gelesene und alte fallen raus, Kill-Switch ganz oben, Signal-Ereignisse nicht doppelt', () => {
    const base = { id: 'n', title: 'x', createdAt: iso(-5), read: false, link: null };
    expect(notificationPriority({ ...base, kind: 'kill_switch' }, NOW)).toBe(120);
    expect(notificationPriority({ ...base, kind: 'price_alert' }, NOW)).toBe(70);
    expect(notificationPriority({ ...base, kind: 'screen' }, NOW)).toBe(70);
    expect(notificationPriority({ ...base, kind: 'signal' }, NOW)).toBe(0);
    expect(notificationPriority({ ...base, kind: 'system', read: true }, NOW)).toBeNull();
    expect(notificationPriority({ ...base, kind: 'system', createdAt: iso(-60 * 72) }, NOW)).toBeNull();
  });

  it('buildTodayItems mischt, sortiert nach Priorität (dann Zeit) und begrenzt', () => {
    const items = buildTodayItems(
      {
        signals: [{ id: 's1', symbol: 'BTC/USDT', direction: 'long', score: 9.5, createdAt: iso(-12), timeframe: '1h' }],
        events: [
          { id: 'e1', title: 'CPI', importance: 3, scheduledAt: iso(150), currency: 'USD' },
          { id: 'e2', title: 'Alt', importance: 3, scheduledAt: iso(-100), currency: 'USD' },
        ],
        notifications: [
          { id: 'n1', kind: 'kill_switch', title: 'Kill', createdAt: iso(-3), read: false, link: '#/traden' },
          { id: 'n2', kind: 'signal', title: 'Sig', createdAt: iso(-3), read: false, link: null },
        ],
        proposals: [{ id: 'p1', name: 'Trendfolger', createdAt: iso(-200) }],
      },
      NOW,
      3,
    );
    expect(items.map((i) => i.kind)).toEqual(['notification', 'event', 'signal']);
    expect(items[0]!.id).toBe('notification:n1');
    const ev = items[1]!;
    expect(ev.kind).toBe('event');
    if (ev.kind === 'event') expect(ev.minutesUntil).toBe(150);
    expect(buildTodayItems({ signals: [], events: [], notifications: [], proposals: [] }, NOW)).toEqual([]);
  });

  it('gleichartige Ereignisse (Art + Titel) erscheinen nur einmal, das jüngste zuerst', () => {
    const items = buildTodayItems(
      {
        signals: [],
        events: [],
        notifications: [
          { id: 'b1', kind: 'briefing', title: 'Morgen-Briefing', createdAt: iso(-600), read: false, link: null },
          { id: 'b2', kind: 'briefing', title: 'Morgen-Briefing', createdAt: iso(-60), read: false, link: null },
          { id: 'b3', kind: 'briefing', title: 'Morgen-Briefing', createdAt: iso(-300), read: false, link: null },
          { id: 'x1', kind: 'system', title: 'Anderes', createdAt: iso(-10), read: false, link: null },
        ],
        proposals: [],
      },
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual(['notification:x1', 'notification:b2']);
  });
});
