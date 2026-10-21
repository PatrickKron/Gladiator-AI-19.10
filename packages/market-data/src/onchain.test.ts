/**
 * DNA-Quadrant (On-Chain): Parser + Einordnung rein; „echte Daten“ fragt
 * Coin Metrics Community und DefiLlama ab (läuft in der CI).
 */
import { describe, expect, it } from 'vitest';
import { fetchOnchainSnapshot, mvrvZone, parseCoinMetrics, parseStablecoinChart, pointChangePct, summarizeAsset, windowChangePct, type DailyPoint } from './onchain.js';

const DAY = 86_400_000;
const series = (values: number[], start = Date.UTC(2026, 0, 1)): DailyPoint[] => values.map((value, i) => ({ ts: start + i * DAY, value }));

describe('mvrvZone', () => {
  const hist = Array.from({ length: 100 }, (_, i) => 1 + i / 50); // 1,00 … 2,98
  it('unter 1 = unterbewertet; sonst nach eigenem Perzentil', () => {
    expect(mvrvZone(0.9, hist).zone).toBe('undervalued');
    expect(mvrvZone(1.5, hist)).toMatchObject({ zone: 'neutral' });
    expect(mvrvZone(2.7, hist).zone).toBe('elevated');
    expect(mvrvZone(2.97, hist).zone).toBe('overheated');
  });
  it('zu wenig Geschichte → keine Zone (außer klar unter 1); NaN → nichts', () => {
    expect(mvrvZone(2.5, hist.slice(0, 30))).toEqual({ zone: null, percentile: null });
    expect(mvrvZone(0.8, hist.slice(0, 30)).zone).toBe('undervalued');
    expect(mvrvZone(Number.NaN, hist)).toEqual({ zone: null, percentile: null });
  });
});

describe('Veränderungen', () => {
  it('30-Tage-Fenster: Ø letzte 30 gegen Ø der 30 davor', () => {
    expect(windowChangePct(series([...Array(30).fill(100), ...Array(30).fill(110)]))).toBeCloseTo(10, 10);
    expect(windowChangePct(series(Array(40).fill(1)))).toBeNull(); // zu kurz
  });
  it('Bestand: heute gegen vor 30 Tagen', () => {
    const s = series(Array.from({ length: 45 }, (_, i) => 100 + i));
    expect(pointChangePct(s, 30)).toBeCloseTo(((144 - 114) / 114) * 100, 10);
    expect(pointChangePct(series([1, 2]), 30)).toBeNull();
  });
});

describe('Parser', () => {
  it('Coin Metrics: Reihen je Asset, leere/kaputte Werte raus', () => {
    const m = parseCoinMetrics({
      data: [
        { asset: 'btc', time: '2026-01-01T00:00:00.000000000Z', CapMVRVCur: '2.1', AdrActCnt: '800000' },
        { asset: 'btc', time: '2026-01-02T00:00:00.000000000Z', CapMVRVCur: '', AdrActCnt: '810000' },
        { asset: 'eth', time: 'kaputt', CapMVRVCur: '1.2' },
        { asset: 'eth', time: '2026-01-02T00:00:00.000000000Z', CapMVRVCur: 'x', AdrActCnt: '500000' },
      ],
    });
    expect(m.get('btc')!.mvrv).toEqual([{ ts: Date.UTC(2026, 0, 1), value: 2.1 }]);
    expect(m.get('btc')!.active.map((p) => p.value)).toEqual([800000, 810000]);
    expect(m.get('eth')!.mvrv).toEqual([]);
    expect(parseCoinMetrics(null).size).toBe(0);
  });
  it('DefiLlama: Sekunden → ms, aufsteigend, nur gültige USD-Werte', () => {
    expect(parseStablecoinChart([{ date: '200', totalCirculatingUSD: { peggedUSD: 5 } }, { date: '100', totalCirculatingUSD: { peggedUSD: 4 } }, { date: '300' }])).toEqual([
      { ts: 100_000, value: 4 },
      { ts: 200_000, value: 5 },
    ]);
    expect(parseStablecoinChart({})).toEqual([]);
  });
  it('Zusammenfassung: fehlende Reihe ehrlich als Fehler', () => {
    expect(summarizeAsset('eth', undefined)).toMatchObject({ mvrv: null, zone: null, error: 'keine Daten' });
    const s = summarizeAsset('btc', { mvrv: series(Array.from({ length: 100 }, (_, i) => 1 + i / 100)), active: series([...Array(30).fill(100), ...Array(30).fill(90)]) });
    expect(s).toMatchObject({ mvrv: 1.99, zone: 'overheated', activeAddresses: 90, error: null });
    expect(s.activeAddresses30dPct).toBeCloseTo(-10, 10);
  });
});

describe('fetchOnchainSnapshot', () => {
  it('eine Quelle down → nur ihr Teil null mit Grund', async () => {
    const net = (async (url: string) => {
      if (String(url).includes('coinmetrics')) return new Response('weg', { status: 503 });
      return new Response(JSON.stringify([{ date: String(Date.UTC(2026, 0, 1) / 1000), totalCirculatingUSD: { peggedUSD: 250e9 } }]));
    }) as unknown as typeof fetch;
    const s = await fetchOnchainSnapshot(net);
    expect(s.assets.every((a) => a.mvrv === null && /Coin Metrics nicht erreichbar \(HTTP 503\)/.test(a.error ?? ''))).toBe(true);
    expect(s.stablecoins).toMatchObject({ totalUsd: 250e9, change30dPct: null, error: null });
  });
});

describe('echte Daten (Coin Metrics Community, DefiLlama)', () => {
  it('BTC/ETH-MVRV plausibel, aktive Adressen > 0, Stablecoin-Umlauf > 50 Mrd. $', async () => {
    const s = await fetchOnchainSnapshot();
    for (const a of s.assets) {
      expect(a.error).toBeNull();
      expect(a.mvrv).toBeGreaterThan(0.2);
      expect(a.mvrv).toBeLessThan(10);
      expect(a.zone).not.toBeNull();
      expect(a.activeAddresses).toBeGreaterThan(10_000);
      expect(Date.now() - Date.parse(a.asOf!)).toBeLessThan(10 * 86_400_000);
    }
    expect(s.stablecoins.error).toBeNull();
    expect(s.stablecoins.totalUsd).toBeGreaterThan(50e9);
    expect(s.stablecoins.change30dPct).not.toBeNull();
  }, 60_000);
});
