import { describe, expect, it } from 'vitest';
import { parseYahooChart } from './yahoo.js';
import { parseForexFactoryFeed } from './calendar.js';
import { parseRssFeed } from './news.js';

/** Parser-Tests mit realitätsgetreuen Fixtures — Netzfunktionen bleiben dünn. */

describe('parseYahooChart', () => {
  const fixture = {
    chart: {
      result: [
        {
          meta: { symbol: '^VIX', regularMarketPrice: 17.42, previousClose: 16.9, currency: 'USD' },
          timestamp: [1751500800, 1751587200],
          indicators: { quote: [{ close: [16.9, 17.42], open: [16.8, 17.0], high: [17.1, 17.6], low: [16.5, 16.8], volume: [0, 0] }] },
        },
      ],
      error: null,
    },
  };

  it('extrahiert Preis, previousClose und Tagespunkte', () => {
    const r = parseYahooChart(fixture);
    expect(r).not.toBeNull();
    expect(r!.symbol).toBe('^VIX');
    expect(r!.price).toBe(17.42);
    expect(r!.previousClose).toBe(16.9);
    expect(r!.points).toHaveLength(2);
    expect(r!.points[1]!.close).toBe(17.42);
    expect(r!.points[0]!.ts.getTime()).toBe(1751500800 * 1000);
  });

  it('null-Closes (Feiertage) werden übersprungen, nicht interpoliert', () => {
    const withGap = structuredClone(fixture);
    withGap.chart.result[0]!.indicators.quote[0]!.close = [16.9, null] as unknown as number[];
    const r = parseYahooChart(withGap);
    expect(r!.points).toHaveLength(1);
  });

  it('Fehler-Antwort oder leeres Result → ehrlich null', () => {
    expect(parseYahooChart({ chart: { result: null, error: { code: 'Not Found' } } })).toBeNull();
    expect(parseYahooChart({})).toBeNull();
  });
});

describe('parseForexFactoryFeed (ForexFactory-Weekly-JSON)', () => {
  const fixture = [
    { title: 'CPI y/y', country: 'USD', date: '2026-07-08T12:30:00-04:00', impact: 'High', forecast: '2.4%', previous: '2.3%' },
    { title: 'Unemployment Claims', country: 'USD', date: '2026-07-09T08:30:00-04:00', impact: 'Medium', forecast: '221K', previous: '233K' },
    { title: 'German Factory Orders m/m', country: 'EUR', date: '2026-07-07T02:00:00-04:00', impact: 'Low', forecast: '', previous: '-1.4%' },
  ];

  it('mappt Events mit Impact 3/2/1 und parst Zeit inkl. Zeitzone', () => {
    const events = parseForexFactoryFeed(fixture);
    expect(events).toHaveLength(3);
    const cpi = events[0]!;
    expect(cpi.title).toBe('CPI y/y');
    expect(cpi.currency).toBe('USD');
    expect(cpi.importance).toBe(3);
    expect(cpi.scheduledAt.toISOString()).toBe('2026-07-08T16:30:00.000Z');
    expect(events[1]!.importance).toBe(2);
    expect(events[2]!.importance).toBe(1);
  });

  it('externalId ist deterministisch (Dedupe über Sync-Läufe)', () => {
    const a = parseForexFactoryFeed(fixture)[0]!.externalId;
    const b = parseForexFactoryFeed(fixture)[0]!.externalId;
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(8);
  });

  it('kaputte Einträge werden verworfen, nicht erfunden', () => {
    const events = parseForexFactoryFeed([{ title: 'X', date: 'kein-datum', impact: 'High', country: 'USD' }, ...fixture]);
    expect(events).toHaveLength(3);
  });
});

describe('parseRssFeed', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Test Feed</title>
<item>
  <title><![CDATA[Bitcoin klettert &amp; ETF-Zuflüsse steigen]]></title>
  <link>https://example.com/a?id=1</link>
  <pubDate>Thu, 03 Jul 2026 10:15:00 +0000</pubDate>
  <description><![CDATA[<p>Starke Zuflüsse in Spot-ETFs.</p>]]></description>
</item>
<item>
  <title>Zweiter Artikel</title>
  <link>https://example.com/b</link>
  <pubDate>Thu, 03 Jul 2026 09:00:00 +0000</pubDate>
</item>
</channel></rss>`;

  it('parst Items mit CDATA, Entities und HTML-Strip in der Summary', () => {
    const items = parseRssFeed(xml, 'test');
    expect(items).toHaveLength(2);
    expect(items[0]!.title).toBe('Bitcoin klettert & ETF-Zuflüsse steigen');
    expect(items[0]!.url).toBe('https://example.com/a?id=1');
    expect(items[0]!.summary).toBe('Starke Zuflüsse in Spot-ETFs.');
    expect(items[0]!.publishedAt.toISOString()).toBe('2026-07-03T10:15:00.000Z');
    expect(items[1]!.summary).toBeNull();
  });

  it('Items ohne Link/Datum werden verworfen', () => {
    const broken = '<rss><channel><item><title>ohne link</title></item></channel></rss>';
    expect(parseRssFeed(broken, 'test')).toHaveLength(0);
  });
});
