import { describe, expect, it } from 'vitest';
import { buildAssetUrl, buildChartUrl, isChartTf, parseChartHash } from './chart-url.js';

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
    expect(parseChartHash('#/charts?symbol=ETH%2FUSDT&tf=4h')).toEqual({ symbol: 'ETH/USDT', tf: '4h' });
  });
  it('ohne Query → beides null', () => {
    expect(parseChartHash('#/charts')).toEqual({ symbol: null, tf: null });
  });
  it('ungültiger tf → tf null, symbol bleibt', () => {
    expect(parseChartHash('#/charts?symbol=BTC%2FUSDT&tf=2h')).toEqual({ symbol: 'BTC/USDT', tf: null });
  });
  it('Roundtrip build→parse', () => {
    expect(parseChartHash(buildChartUrl('SOL/USDT', '1d'))).toEqual({ symbol: 'SOL/USDT', tf: '1d' });
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

describe('isChartTf', () => {
  it('akzeptiert nur bekannte Timeframes', () => {
    expect(isChartTf('15m')).toBe(true);
    expect(isChartTf('1h')).toBe(true);
    expect(isChartTf('2h')).toBe(false);
    expect(isChartTf(null)).toBe(false);
  });
});
