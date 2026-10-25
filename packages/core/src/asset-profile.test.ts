import { describe, expect, it } from 'vitest';
import { assetProfile, eventRelevantForAsset, isUsEquity, noTradeScope, type AssetEventLike } from './asset-profile.js';

describe('assetProfile — Krypto', () => {
  it('Binance-Paare: Stable-Quote → USD', () => {
    expect(assetProfile('BTC/USDT', 'binance')).toMatchObject({ assetClass: 'crypto', base: 'BTC', currencies: ['USD'], quoteCurrency: 'USD' });
    expect(assetProfile('eth/usdc', 'binance')).toMatchObject({ assetClass: 'crypto', base: 'ETH', currencies: ['USD'], quoteCurrency: 'USD' });
    expect(assetProfile('SOL/USD', 'binance')).toMatchObject({ assetClass: 'crypto', currencies: ['USD'] });
  });
  it('Perp-Notation (BTC/USDT:USDT) wie Spot', () => {
    expect(assetProfile('BTC/USDT:USDT', 'binanceusdm')).toMatchObject({ assetClass: 'crypto', base: 'BTC', currencies: ['USD'] });
  });
  it('Fiat-Quote ≠ USD: Leitwährung USD + Notierungswährung', () => {
    expect(assetProfile('BTC/EUR', 'binance')).toMatchObject({ assetClass: 'crypto', currencies: ['USD', 'EUR'], quoteCurrency: 'EUR' });
  });
  it('Krypto-Kreuz ohne Fiat (ETH/BTC): Währung unbekannt', () => {
    expect(assetProfile('ETH/BTC', 'binance')).toMatchObject({ assetClass: 'crypto', base: 'ETH', currencies: null, quoteCurrency: null });
  });
  it('Yahoo-Krypto BTC-USD', () => {
    expect(assetProfile('BTC-USD', 'yahoo')).toMatchObject({ assetClass: 'crypto', base: 'BTC', currencies: ['USD'], quoteCurrency: 'USD' });
  });
  it('Binance ohne Paar-Schreibweise → null (kein Raten)', () => {
    expect(assetProfile('BTCUSDT', 'binance')).toBeNull();
  });
});

describe('assetProfile — Forex', () => {
  it('Yahoo EURUSD=X → EUR+USD, Kurs in USD', () => {
    expect(assetProfile('EURUSD=X', 'yahoo')).toMatchObject({ assetClass: 'forex', base: 'EUR', currencies: ['EUR', 'USD'], quoteCurrency: 'USD' });
  });
  it('Yahoo USDJPY=X → USD+JPY; Kurzform JPY=X = USD/JPY', () => {
    expect(assetProfile('USDJPY=X', 'yahoo')).toMatchObject({ assetClass: 'forex', base: 'USD', currencies: ['USD', 'JPY'], quoteCurrency: 'JPY' });
    expect(assetProfile('JPY=X', 'yahoo')).toMatchObject({ assetClass: 'forex', base: 'USD', currencies: ['USD', 'JPY'] });
  });
  it('Twelve Data EUR/USD und TradingView EURUSD', () => {
    expect(assetProfile('EUR/USD', 'twelvedata')).toMatchObject({ assetClass: 'forex', currencies: ['EUR', 'USD'] });
    expect(assetProfile('GBPUSD', null)).toMatchObject({ assetClass: 'forex', currencies: ['GBP', 'USD'] });
  });
  it('unbekannte Währung in =X → null', () => {
    expect(assetProfile('ABCUSD=X', 'yahoo')).toBeNull();
  });
});

describe('assetProfile — Rohstoffe, Futures, Indizes', () => {
  it('Edelmetalle XAU/USD, XAGUSD → commodity, USD', () => {
    expect(assetProfile('XAU/USD', 'twelvedata')).toMatchObject({ assetClass: 'commodity', base: 'XAU', currencies: ['USD'], quoteCurrency: 'USD' });
    expect(assetProfile('XAGUSD', null)).toMatchObject({ assetClass: 'commodity', base: 'XAG', currencies: ['USD'] });
  });
  it('Gold in EUR: Weltmarkt-Leitwährung USD bleibt dabei', () => {
    expect(assetProfile('XAU/EUR', 'twelvedata')).toMatchObject({ assetClass: 'commodity', currencies: ['EUR', 'USD'], quoteCurrency: 'EUR' });
  });
  it('Rohstoff-Futures GC=F/CL=F/SI=F → commodity, USD', () => {
    for (const s of ['GC=F', 'CL=F', 'SI=F', 'NG=F', 'HG=F']) {
      expect(assetProfile(s, 'yahoo')).toMatchObject({ assetClass: 'commodity', currencies: ['USD'], quoteCurrency: 'USD' });
    }
  });
  it('Index-, Währungs- und Krypto-Futures → future', () => {
    expect(assetProfile('ES=F', 'yahoo')).toMatchObject({ assetClass: 'future', currencies: ['USD'] });
    expect(assetProfile('6E=F', 'yahoo')).toMatchObject({ assetClass: 'future', base: 'EUR', currencies: ['EUR', 'USD'] });
    expect(assetProfile('BTC=F', 'yahoo')).toMatchObject({ assetClass: 'future', base: 'BTC', currencies: ['USD'] });
  });
  it('unbekannter Future: Klasse ja, Währung unbekannt', () => {
    expect(assetProfile('ZZZ=F', 'yahoo')).toMatchObject({ assetClass: 'future', currencies: null, quoteCurrency: null });
  });
  it('Indizes nach Heimatmarkt', () => {
    expect(assetProfile('^GSPC', 'yahoo')).toMatchObject({ assetClass: 'index', currencies: ['USD'] });
    expect(assetProfile('^GDAXI', 'yahoo')).toMatchObject({ assetClass: 'index', currencies: ['EUR'] });
    expect(assetProfile('^N225', 'yahoo')).toMatchObject({ assetClass: 'index', currencies: ['JPY'] });
    expect(assetProfile('^XYZ', 'yahoo')).toMatchObject({ assetClass: 'index', currencies: null });
  });
});

describe('assetProfile — Aktien/ETF', () => {
  it('US-Ticker ohne Suffix → USD', () => {
    expect(assetProfile('AAPL', 'yahoo')).toMatchObject({ assetClass: 'stock', base: null, currencies: ['USD'], quoteCurrency: 'USD' });
    expect(assetProfile('BRK-B', 'yahoo')).toMatchObject({ assetClass: 'stock', currencies: ['USD'] });
  });
  it('frühere COT-Fehltreffer sind Aktien (Barrick GOLD, Colgate CL, SIRI, ESTC)', () => {
    for (const s of ['GOLD', 'CL', 'CLX', 'SIRI', 'SIG', 'ESTC']) {
      expect(assetProfile(s, 'yahoo')).toMatchObject({ assetClass: 'stock', currencies: ['USD'] });
    }
  });
  it('bekannte ETFs → etf', () => {
    expect(assetProfile('SPY', 'yahoo')).toMatchObject({ assetClass: 'etf', currencies: ['USD'] });
    expect(assetProfile('GLD', 'twelvedata')).toMatchObject({ assetClass: 'etf', currencies: ['USD'] });
  });
  it('Börsen-Suffixe → Heimatwährung', () => {
    expect(assetProfile('SAP.DE', 'yahoo')).toMatchObject({ assetClass: 'stock', currencies: ['EUR'], quoteCurrency: 'EUR' });
    expect(assetProfile('MC.PA', 'yahoo')).toMatchObject({ currencies: ['EUR'] });
    expect(assetProfile('NESN.SW', 'yahoo')).toMatchObject({ currencies: ['CHF'], quoteCurrency: 'CHF' });
    expect(assetProfile('7203.T', 'yahoo')).toMatchObject({ currencies: ['JPY'] });
    expect(assetProfile('SHOP.TO', 'yahoo')).toMatchObject({ currencies: ['CAD'] });
  });
  it('London: GBP-Termine, aber Kurs in Pence → Kurswährung unbekannt (kein falsches £)', () => {
    expect(assetProfile('HSBA.L', 'yahoo')).toMatchObject({ assetClass: 'stock', currencies: ['GBP'], quoteCurrency: null });
  });
  it('unbekanntes Suffix → Währung null', () => {
    expect(assetProfile('ABC.QQ', 'yahoo')).toMatchObject({ assetClass: 'stock', currencies: null, quoteCurrency: null });
  });
  it('ohne Quelle ist ein nackter Ticker mehrdeutig → null', () => {
    expect(assetProfile('AAPL', null)).toBeNull();
    expect(assetProfile('BTC')).toBeNull();
  });
  it('leer/Unsinn → null', () => {
    expect(assetProfile('', 'yahoo')).toBeNull();
    expect(assetProfile('   ', 'binance')).toBeNull();
    expect(assetProfile('A B', 'yahoo')).toBeNull();
  });
});

describe('isUsEquity', () => {
  it('nur Aktien/ETF/Index mit USD', () => {
    expect(isUsEquity(assetProfile('AAPL', 'yahoo'))).toBe(true);
    expect(isUsEquity(assetProfile('^GSPC', 'yahoo'))).toBe(true);
    expect(isUsEquity(assetProfile('SAP.DE', 'yahoo'))).toBe(false);
    expect(isUsEquity(assetProfile('BTC/USDT', 'binance'))).toBe(false);
    expect(isUsEquity(null)).toBe(false);
  });
});

const ev = (p: Partial<AssetEventLike>): AssetEventLike => ({ currency: 'USD', importance: 3, scope: 'usd', cryptoRelevance: 3, equityRelevance: 3, ...p });

describe('eventRelevantForAsset', () => {
  const btc = assetProfile('BTC/USDT', 'binance');
  const sap = assetProfile('SAP.DE', 'yahoo');
  const aapl = assetProfile('AAPL', 'yahoo');
  const eurusd = assetProfile('EURUSD=X', 'yahoo');
  const gold = assetProfile('GC=F', 'yahoo');

  it('nur High-Impact (importance ≥ 3) — wie die Engine', () => {
    expect(eventRelevantForAsset(btc, ev({ importance: 2 }))).toBe(false);
    expect(eventRelevantForAsset(btc, ev({ importance: null }))).toBe(false);
    expect(eventRelevantForAsset(btc, ev({}))).toBe(true);
  });
  it('Währung muss passen (oder globale Reichweite wie FOMC)', () => {
    expect(eventRelevantForAsset(btc, ev({ currency: 'EUR', scope: 'eur', cryptoRelevance: 2 }))).toBe(false);
    expect(eventRelevantForAsset(btc, ev({ currency: 'USD', scope: 'global' }))).toBe(true);
    expect(eventRelevantForAsset(sap, ev({ currency: 'USD', scope: 'global', equityRelevance: 3 }))).toBe(true);
    expect(eventRelevantForAsset(eurusd, ev({ currency: 'EUR', scope: 'eur' }))).toBe(true);
    expect(eventRelevantForAsset(eurusd, ev({ currency: 'JPY', scope: 'jpy' }))).toBe(false);
  });
  it('Relevanz ≥ 2: Krypto nach cryptoRelevance, US-Aktien nach equityRelevance', () => {
    expect(eventRelevantForAsset(btc, ev({ cryptoRelevance: 1 }))).toBe(false);
    expect(eventRelevantForAsset(btc, ev({ cryptoRelevance: 2 }))).toBe(true);
    expect(eventRelevantForAsset(aapl, ev({ equityRelevance: 1 }))).toBe(false);
    expect(eventRelevantForAsset(aapl, ev({ equityRelevance: 2 }))).toBe(true);
  });
  it('Nicht-US-Aktie, Forex, Rohstoff: Termin der eigenen Währung zählt (equityRelevance gilt nur für US)', () => {
    expect(eventRelevantForAsset(sap, ev({ currency: 'EUR', scope: 'eur', equityRelevance: 1 }))).toBe(true);
    expect(eventRelevantForAsset(gold, ev({ currency: 'USD', cryptoRelevance: 0, equityRelevance: 0 }))).toBe(true);
  });
  it('Asset/Währung unbekannt → konservativ ALLE High-Impact-Termine', () => {
    expect(eventRelevantForAsset(null, ev({ currency: 'JPY', scope: 'jpy', cryptoRelevance: 0 }))).toBe(true);
    expect(eventRelevantForAsset(assetProfile('ETH/BTC', 'binance'), ev({ currency: 'GBP', scope: 'gbp', cryptoRelevance: 1 }))).toBe(true);
    expect(eventRelevantForAsset(null, ev({ importance: 2 }))).toBe(false);
  });
  it('Währung case-insensitiv, fehlende Währung ohne global → nicht zuordenbar', () => {
    expect(eventRelevantForAsset(btc, ev({ currency: 'usd' }))).toBe(true);
    expect(eventRelevantForAsset(btc, ev({ currency: null, scope: 'regional' }))).toBe(false);
  });
});

describe('noTradeScope — nie „frei" zeigen, wenn die Engine sperrt', () => {
  const btc = assetProfile('BTC/USDT', 'binance');
  it('kein Fenster → none', () => {
    expect(noTradeScope(null, btc)).toBe('none');
  });
  it('Fenster-Termin betrifft das Asset → asset', () => {
    expect(noTradeScope(ev({}), btc)).toBe('asset');
  });
  it('Fenster-Termin betrifft das Asset NICHT → global (Engine sperrt trotzdem)', () => {
    expect(noTradeScope(ev({ currency: 'JPY', scope: 'jpy', cryptoRelevance: 1 }), btc)).toBe('global');
  });
  it('Asset unbekannt → asset (nicht als unbetroffen ausgeben)', () => {
    expect(noTradeScope(ev({ currency: 'JPY', scope: 'jpy' }), null)).toBe('asset');
  });
});
