import { describe, expect, it } from 'vitest';
import { BINANCE_MARKET_DATA_MIRROR, binancePublicClient, isGeoBlocked } from './binance-public.js';

describe('isGeoBlocked (Binance sperrt Standorte mit HTTP 451)', () => {
  it('erkennt die echte 451-Antwort aus der CI', () => {
    const err = new Error(
      'ExchangeNotAvailable: binance GET https://api.binance.com/api/v3/exchangeInfo 451  { "code": 0, "msg": "Service unavailable from a restricted location according to \'b. Eligibility\'" }',
    );
    expect(isGeoBlocked(err)).toBe(true);
  });

  it('andere Fehler sind keine Standort-Sperre (nicht still umleiten)', () => {
    expect(isGeoBlocked(new Error('binance GET … 429 Too Many Requests'))).toBe(false);
    expect(isGeoBlocked(new Error('fetch failed'))).toBe(false);
    expect(isGeoBlocked('451 irgendwo')).toBe(false);
  });
});

describe('binancePublicClient', () => {
  it('Standard: offizielle API, alle Markttypen', () => {
    const ex = binancePublicClient(false);
    expect((ex.urls.api as Record<string, unknown>).public).toBe('https://api.binance.com/api/v3');
  });

  it('Spiegel: offizieller Marktdaten-Spiegel, nur Spot (Futures-Endpunkte gibt es dort nicht)', () => {
    const ex = binancePublicClient(true);
    expect((ex.urls.api as Record<string, unknown>).public).toBe(`${BINANCE_MARKET_DATA_MIRROR}/api/v3`);
    expect(ex.options.fetchMarkets).toMatchObject({ types: ['spot'] });
  });
});
