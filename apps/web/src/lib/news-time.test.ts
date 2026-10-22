import { describe, expect, it } from 'vitest';
import { groupByDay, newsWhen } from './news-time.js';

const L = { today: 'Heute', yesterday: 'Gestern' };
const now = new Date('2026-10-22T14:00:00');

describe('newsWhen', () => {
  it('relativ in Minuten/Stunden/Tagen, absolut mit Wochentag und Uhrzeit, Tag = Heute/Gestern/Datum', () => {
    expect(newsWhen(new Date('2026-10-22T13:40:00'), now, 'de-DE', L)).toMatchObject({ relative: 'vor 20 Minuten', day: 'Heute' });
    expect(newsWhen(new Date('2026-10-22T11:00:00'), now, 'de-DE', L)).toMatchObject({ relative: 'vor 3 Stunden', day: 'Heute' });
    expect(newsWhen(new Date('2026-10-21T20:00:00'), now, 'de-DE', L)).toMatchObject({ relative: 'vor 18 Stunden', day: 'Gestern' });
    const old = newsWhen(new Date('2026-10-19T09:30:00'), now, 'de-DE', L);
    expect(old.relative).toBe('vor 3 Tagen');
    expect(old.day).toMatch(/Montag, 19\. Oktober/);
    expect(old.absolute).toMatch(/19\.10\./);
    expect(old.absolute).toMatch(/09:30/);
  });
  it('englische Locale', () => {
    expect(newsWhen(new Date('2026-10-22T11:00:00'), now, 'en-US', { today: 'Today', yesterday: 'Yesterday' }).relative).toBe('3 hours ago');
  });
});

describe('groupByDay', () => {
  it('hält die Reihenfolge und fasst aufeinanderfolgende Meldungen desselben Tages zusammen', () => {
    const items = [
      { id: 1, publishedAt: '2026-10-22T13:00:00' },
      { id: 2, publishedAt: '2026-10-22T09:00:00' },
      { id: 3, publishedAt: '2026-10-21T22:00:00' },
      { id: 4, publishedAt: '2026-10-19T08:00:00' },
    ];
    const g = groupByDay(items, now, 'de-DE', L);
    expect(g.map((x) => [x.day, x.items.map((i) => i.id)])).toEqual([
      ['Heute', [1, 2]],
      ['Gestern', [3]],
      ['Montag, 19. Oktober', [4]],
    ]);
  });
});
