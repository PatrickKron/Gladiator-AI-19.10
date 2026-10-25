import { describe, expect, it } from 'vitest';
import { assetMacroPlan, derivativeState, noTradeNoticeKey, priceUnit, safe003State } from './asset-tabs.js';

describe('assetMacroPlan — welche Makro-Blöcke gelten für das gewählte Asset', () => {
  it('BTC (Binance): Funding/OI ja, On-Chain BTC, keine Bewertung, kein Realzins', () => {
    expect(assetMacroPlan('BTC/USDT', 'binance')).toMatchObject({ derivatives: true, onchain: 'btc', valuation: null, realYield: false, etf: false });
  });
  it('ETH: On-Chain ETH; SOL: kein On-Chain', () => {
    expect(assetMacroPlan('ETH/USDT', 'binance').onchain).toBe('eth');
    expect(assetMacroPlan('SOL/USDT', 'binance')).toMatchObject({ derivatives: true, onchain: null });
  });
  it('Yahoo-Krypto BTC-USD: On-Chain ja, aber kein Binance-Perp-Feed', () => {
    expect(assetMacroPlan('BTC-USD', 'yahoo')).toMatchObject({ derivatives: false, onchain: 'btc' });
  });
  it('US-Aktie/ETF/Index: Buffett-Indikator; ETF zeigt COT des Basiswerts', () => {
    expect(assetMacroPlan('AAPL', 'yahoo')).toMatchObject({ derivatives: false, onchain: null, valuation: 'us', etf: false });
    expect(assetMacroPlan('GLD', 'yahoo')).toMatchObject({ valuation: 'us', etf: true });
    expect(assetMacroPlan('^GSPC', 'yahoo').valuation).toBe('us');
  });
  it('Nicht-US-Aktie: Buffett nicht anwendbar (ehrlich benannt)', () => {
    expect(assetMacroPlan('SAP.DE', 'yahoo').valuation).toBe('non_us');
  });
  it('Gold/Rohstoff: Realzins-Block', () => {
    expect(assetMacroPlan('GC=F', 'yahoo')).toMatchObject({ realYield: true, valuation: null, derivatives: false });
    expect(assetMacroPlan('XAU/USD', 'twelvedata').realYield).toBe(true);
    expect(assetMacroPlan('EURUSD=X', 'yahoo').realYield).toBe(false);
  });
  it('unbekanntes Asset: nichts Asset-Spezifisches außer COT-Abfrage', () => {
    expect(assetMacroPlan('???', 'yahoo')).toMatchObject({ profile: null, derivatives: false, onchain: null, valuation: null, realYield: false });
  });
});

describe('derivativeState', () => {
  const base = { fundingRate: 0.0001, fundingTs: '2026-10-25T08:00:00Z', perp: true as boolean | null, inSync: true };
  it('Daten da → ok', () => expect(derivativeState(base)).toBe('ok'));
  it('kein gleichnamiger Perp → no_perp', () => expect(derivativeState({ ...base, fundingRate: null, fundingTs: null, perp: false, inSync: false })).toBe('no_perp'));
  it('Perp da, aber nicht im Sync-Universum → not_synced', () => expect(derivativeState({ ...base, fundingRate: null, fundingTs: null, inSync: false })).toBe('not_synced'));
  it('im Sync, noch keine Punkte → pending', () => expect(derivativeState({ ...base, fundingRate: null, fundingTs: null })).toBe('pending'));
  it('Perp-Liste unbekannt / keine Antwort → unknown', () => {
    expect(derivativeState({ ...base, fundingRate: null, fundingTs: null, perp: null, inSync: false })).toBe('unknown');
    expect(derivativeState(undefined)).toBe('unknown');
  });
});

describe('noTradeNoticeKey — Engine-Sperre nie als „frei" zeigen', () => {
  it('je Reichweite ein eigener Text, ohne Fenster keiner', () => {
    expect(noTradeNoticeKey('asset')).toBe('aegis.noTradeAsset');
    expect(noTradeNoticeKey('global')).toBe('aegis.noTradeGlobalOnly');
    expect(noTradeNoticeKey('none')).toBeNull();
  });
});

describe('priceUnit', () => {
  it('Zeichen für die großen Währungen, sonst ISO-Code, unbekannt leer', () => {
    expect(priceUnit('USD')).toBe('$');
    expect(priceUnit('EUR')).toBe('€');
    expect(priceUnit('GBP')).toBe('£');
    expect(priceUnit('CHF')).toBe('CHF');
    expect(priceUnit(null)).toBe('');
    expect(priceUnit(undefined)).toBe('');
  });
});

describe('safe003State', () => {
  it('über dem Limit → breach, darunter ok, ohne Daten unknown, ohne Limit na', () => {
    expect(safe003State(11, 10)).toBe('breach');
    expect(safe003State(10, 10)).toBe('ok');
    expect(safe003State(null, 10)).toBe('unknown');
    expect(safe003State(5, null)).toBe('na');
  });
});
