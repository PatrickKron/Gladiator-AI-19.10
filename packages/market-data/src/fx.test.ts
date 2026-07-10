import { beforeEach, describe, expect, it } from 'vitest';
import { eurToUsd, getEurUsdRate, resetFxCache, usdToEur, type FetchLike } from './fx.js';

function fakeFetch(payload: unknown, ok = true, status = 200): FetchLike {
  return async () => ({ ok, status, json: async () => payload });
}

beforeEach(() => resetFxCache());

describe('getEurUsdRate', () => {
  it('liefert den echten Binance-EURUSDT-Kurs', async () => {
    expect(await getEurUsdRate(fakeFetch({ price: '1.0842' }))).toBeCloseTo(1.0842);
  });

  it('cached 60s (zweiter Call ohne Netz-Roundtrip)', async () => {
    let calls = 0;
    const counting: FetchLike = async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ price: '1.10' }) };
    };
    await getEurUsdRate(counting, 1_000_000);
    await getEurUsdRate(counting, 1_030_000);
    expect(calls).toBe(1);
    await getEurUsdRate(counting, 1_070_000); // > 60s → neu laden
    expect(calls).toBe(2);
  });

  it('HTTP-Fehler / kaputte Antwort / unplausibler Kurs ⇒ ehrlich null', async () => {
    expect(await getEurUsdRate(fakeFetch({}, false, 429))).toBeNull();
    expect(await getEurUsdRate(fakeFetch({ price: 'unfug' }))).toBeNull();
    expect(await getEurUsdRate(fakeFetch({ price: '42' }))).toBeNull();
    expect(await getEurUsdRate(fakeFetch({ price: '0.01' }))).toBeNull();
    const throwing: FetchLike = async () => {
      throw new Error('Netz weg');
    };
    expect(await getEurUsdRate(throwing)).toBeNull();
  });
});

describe('usdToEur / eurToUsd', () => {
  it('rechnet mit echtem Kurs um', () => {
    expect(usdToEur(108, 1.08)).toBeCloseTo(100);
    expect(eurToUsd(100, 1.08)).toBeCloseTo(108);
  });

  it('ohne Kurs ⇒ null (nie erfundene Umrechnung)', () => {
    expect(usdToEur(100, null)).toBeNull();
    expect(eurToUsd(100, null)).toBeNull();
    expect(usdToEur(100, 0)).toBeNull();
  });
});
