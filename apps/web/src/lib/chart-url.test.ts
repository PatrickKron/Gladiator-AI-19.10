import { describe, expect, it } from 'vitest';
import { ASSET_TABS, buildAssetUrl, buildChartUrl, isChartTf, parseChartHash } from './chart-url.js';
import { parseTab } from './tab-hash.js';

describe('buildChartUrl', () => {
  it('enkodiert den Slash im Symbol und hängt tf an', () => {
    expect(buildChartUrl('ETH/USDT', '4h')).toBe('#/charts?symbol=ETH%2FUSDT&tf=4h');
  });
  it('lässt tf weg, wenn nicht angegeben', () => {
    expect(buildChartUrl('BTC/USDT')).toBe('#/charts?symbol=BTC%2FUSDT');
  });
});

describe('parseChartHash', () => {
  it('liest symbol (dekodiert) und tf', () => {
    expect(parseChartHash('#/charts?symbol=ETH%2FUSDT&tf=4h')).toEqual({ symbol: 'ETH/USDT', tf: '4h', venue: null });
  });
  it('ohne Query → beides null', () => {
    expect(parseChartHash('#/charts')).toEqual({ symbol: null, tf: null, venue: null });
  });
  it('ungültiger tf → tf null, symbol bleibt', () => {
    // 3d ist ein Binance-TF, wird von uns aber nicht angeboten → tf null.
    expect(parseChartHash('#/charts?symbol=BTC%2FUSDT&tf=3d')).toEqual({ symbol: 'BTC/USDT', tf: null, venue: null });
  });
  it('Roundtrip build→parse', () => {
    expect(parseChartHash(buildChartUrl('SOL/USDT', '1d'))).toEqual({ symbol: 'SOL/USDT', tf: '1d', venue: null });
  });
});

describe('buildAssetUrl', () => {
  it('lässt den Default-Tab (chart) weg', () => {
    expect(buildAssetUrl('ETH/USDT', 'chart')).toBe('#/charts?symbol=ETH%2FUSDT');
  });
  it('hängt Nicht-Default-Tab an', () => {
    expect(buildAssetUrl('ETH/USDT', 'makro')).toBe('#/charts?symbol=ETH%2FUSDT&tab=makro');
  });
  it('kombiniert tf und tab', () => {
    expect(buildAssetUrl('BTC/USDT', 'risiko', '4h')).toBe('#/charts?symbol=BTC%2FUSDT&tf=4h&tab=risiko');
  });
});

describe('Tabs der Chart-Seite (wie v2: Chart · Analyse · Makro · Risiko)', () => {
  it('Makro und Risiko sind wieder Tabs der Chart-Seite', () => {
    expect(ASSET_TABS).toEqual(['chart', 'kontext', 'makro', 'risiko']);
  });
  it('#/charts?tab=makro|risiko öffnet den Tab; Unbekanntes → Chart', () => {
    expect(parseTab('#/charts?tab=makro', ASSET_TABS, 'chart')).toBe('makro');
    expect(parseTab('#/charts?symbol=ETH%2FUSDT&tab=risiko', ASSET_TABS, 'chart')).toBe('risiko');
    expect(parseTab('#/charts?tab=entscheidung', ASSET_TABS, 'chart')).toBe('chart');
  });
  it('Roundtrip: buildAssetUrl → Tab und Symbol bleiben erhalten', () => {
    const url = buildAssetUrl('SOL/USDT', 'makro', '4h');
    expect(parseTab(url, ASSET_TABS, 'chart')).toBe('makro');
    expect(parseChartHash(url)).toEqual({ symbol: 'SOL/USDT', tf: '4h', venue: null });
  });
});

describe('isChartTf', () => {
  it('akzeptiert nur bekannte Timeframes', () => {
    expect(isChartTf('15m')).toBe(true);
    expect(isChartTf('1h')).toBe(true);
    expect(isChartTf('2h')).toBe(true); // Feature A: jetzt unterstützt
    expect(isChartTf('12h')).toBe(true);
    expect(isChartTf('1M')).toBe(true);
    expect(isChartTf('3d')).toBe(false); // nicht angeboten
    expect(isChartTf(null)).toBe(false);
  });
});

describe('Kerzenquelle (venue) im Deep-Link', () => {
  it('Aktien/Forex tragen die Quelle, Krypto nicht; unbekannte Quelle → null', () => {
    expect(buildChartUrl('AAPL', '1d', 'twelvedata')).toBe('#/charts?symbol=AAPL&tf=1d&venue=twelvedata');
    expect(buildChartUrl('BTC/USDT', '1h', 'binance')).toBe('#/charts?symbol=BTC%2FUSDT&tf=1h');
    expect(buildAssetUrl('EUR/USD', 'kontext', '4h', 'yahoo')).toBe('#/charts?symbol=EUR%2FUSD&tf=4h&tab=kontext&venue=yahoo');
    expect(parseChartHash('#/charts?symbol=AAPL&tf=1d&venue=twelvedata')).toEqual({ symbol: 'AAPL', tf: '1d', venue: 'twelvedata' });
    expect(parseChartHash('#/charts?symbol=AAPL&venue=nasdaq')).toEqual({ symbol: 'AAPL', tf: null, venue: null });
    expect(parseChartHash('#/charts')).toEqual({ symbol: null, tf: null, venue: null });
  });
});
