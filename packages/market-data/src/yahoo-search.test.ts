import { describe, expect, it } from 'vitest';
import { parseYahooSearch, resetYahooSearchCache, searchYahoo } from './yahoo-search.js';

describe('parseYahooSearch', () => {
  it('nur bekannte Typen, Doppelte raus, Name aus shortname/longname, Limit', () => {
    const json = {
      quotes: [
        { symbol: 'AAPL', shortname: 'Apple Inc.', quoteType: 'EQUITY', exchDisp: 'NASDAQ' },
        { symbol: 'aapl', longname: 'Apple Inc.', quoteType: 'EQUITY', exchange: 'NMS' },
        { symbol: 'BTC-USD', shortname: 'Bitcoin USD', quoteType: 'CRYPTOCURRENCY' },
        { symbol: 'AAPL260117C00200000', quoteType: 'OPTION' },
        { symbol: 'EURUSD=X', shortname: 'EUR/USD', quoteType: 'CURRENCY', exchange: 'CCY' },
        { symbol: 'SPY', longname: 'SPDR S&P 500 ETF Trust', quoteType: 'ETF', exchDisp: 'NYSEArca' },
        { symbol: '', quoteType: 'EQUITY' },
      ],
    };
    expect(parseYahooSearch(json)).toEqual([
      { symbol: 'AAPL', name: 'Apple Inc.', type: 'EQUITY', exchange: 'NASDAQ' },
      { symbol: 'EURUSD=X', name: 'EUR/USD', type: 'CURRENCY', exchange: 'CCY' },
      { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', type: 'ETF', exchange: 'NYSEArca' },
    ]);
    expect(parseYahooSearch(json, 1)).toHaveLength(1);
  });
  it('kaputte Antwort → leer, nie geraten', () => {
    expect(parseYahooSearch(null)).toEqual([]);
    expect(parseYahooSearch({ quotes: 'x' })).toEqual([]);
  });
});

describe('searchYahoo', () => {
  it('leere Suche fragt nicht, merkt sich Treffer, wirft bei HTTP-Fehler', async () => {
    resetYahooSearchCache();
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response(JSON.stringify({ quotes: [{ symbol: 'MSFT', shortname: 'Microsoft', quoteType: 'EQUITY' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await searchYahoo('   ', 5, fake)).toEqual([]);
    expect(calls).toBe(0);
    expect((await searchYahoo('micro', 5, fake))[0]!.symbol).toBe('MSFT');
    expect((await searchYahoo('Micro', 5, fake))[0]!.symbol).toBe('MSFT');
    expect(calls).toBe(1);
    const bad = (async () => new Response('nope', { status: 429 })) as unknown as typeof fetch;
    await expect(searchYahoo('fail', 5, bad)).rejects.toThrow(/HTTP 429/);
  });
  it('Forex-Schreibweise: „eurusd“ ohne Währungstreffer fragt zusätzlich EURUSD=X und stellt es voran', async () => {
    resetYahooSearchCache();
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      const q = new URL(url).searchParams.get('q');
      const quotes = q === 'EURUSD=X' ? [{ symbol: 'EURUSD=X', shortname: 'EUR/USD', quoteType: 'CURRENCY' }] : [{ symbol: 'EURN', shortname: 'Euronav', quoteType: 'EQUITY' }];
      return new Response(JSON.stringify({ quotes }), { status: 200 });
    }) as unknown as typeof fetch;
    const hits = await searchYahoo('eurusd', 10, fake);
    expect(hits.map((h) => h.symbol)).toEqual(['EURUSD=X', 'EURN']);
    expect(urls.length).toBe(2);
    // Aktien-Suchwort mit sechs Buchstaben, aber Währungstreffer schon dabei ⇒ keine zweite Anfrage
    resetYahooSearchCache();
    const withFx = (async () => new Response(JSON.stringify({ quotes: [{ symbol: 'USDJPY=X', shortname: 'USD/JPY', quoteType: 'CURRENCY' }] }), { status: 200 })) as unknown as typeof fetch;
    const calls: number[] = [];
    const counting = (async (u: string, i: RequestInit) => { calls.push(1); return withFx(u, i); }) as unknown as typeof fetch;
    expect((await searchYahoo('usdjpy', 10, counting))[0]!.symbol).toBe('USDJPY=X');
    expect(calls.length).toBe(1);
  });
});

describe('echte Daten (Yahoo-Suche)', () => {
  it('„apple“ findet AAPL als Aktie, „eurusd“ findet EURUSD=X als Forex, „spy“ einen ETF', async () => {
    resetYahooSearchCache();
    const apple = await searchYahoo('apple', 10);
    expect(apple.find((h) => h.symbol === 'AAPL')?.type).toBe('EQUITY');
    const fx = await searchYahoo('eurusd', 10);
    expect(fx.find((h) => h.symbol === 'EURUSD=X')?.type).toBe('CURRENCY');
    const spy = await searchYahoo('spy', 10);
    expect(spy.some((h) => h.symbol === 'SPY' && h.type === 'ETF')).toBe(true);
  }, 30_000);
});
