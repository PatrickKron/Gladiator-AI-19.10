import { describe, expect, it } from 'vitest';
import {
  cotMarketForSymbol,
  cotScore,
  deriveCotPositioning,
  parseCotRows,
  type CotRow,
} from './cot.js';

describe('cotMarketForSymbol', () => {
  it('mappt bekannte Symbole', () => {
    expect(cotMarketForSymbol('BTC/USDT')?.label).toBe('BITCOIN_CME');
    expect(cotMarketForSymbol('xau/usd')?.label).toBe('GOLD');
    expect(cotMarketForSymbol('EUR/USD')?.label).toBe('EURO_FX');
  });
  it('null für nicht abgedeckte Symbole', () => {
    expect(cotMarketForSymbol('DOGE/USDT')).toBeNull();
  });
});

describe('parseCotRows', () => {
  const good = [
    {
      cftc_contract_market_code: '088691',
      market_and_exchange_names: 'GOLD - COMMODITY EXCHANGE INC.',
      report_date_as_yyyy_mm_dd: '2026-07-01T00:00:00.000',
      open_interest_all: '500000',
      noncomm_positions_long_all: '250000',
      noncomm_positions_short_all: '90000',
      comm_positions_long_all: '120000',
      comm_positions_short_all: '260000',
    },
  ];

  it('parst eine gültige Zeile', () => {
    const rows = parseCotRows(good);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.openInterest).toBe(500000);
    expect(rows[0]!.noncommLong).toBe(250000);
  });

  it('verwirft kaputte/unvollständige Zeilen (kein Raten)', () => {
    expect(parseCotRows([{ cftc_contract_market_code: '088691' }])).toHaveLength(0);
    expect(parseCotRows([{ ...good[0], open_interest_all: 'n/a' }])).toHaveLength(0);
    expect(parseCotRows([{ ...good[0], report_date_as_yyyy_mm_dd: 'kaputt' }])).toHaveLength(0);
    expect(parseCotRows('nope')).toHaveLength(0);
  });
});

function row(net: number, oi = 100_000, date = '2026-01-01'): CotRow {
  // net als Non-Comm-Netto direkt (long = net wenn positiv, sonst short)
  const long = net >= 0 ? 50_000 + net : 50_000;
  const short = net >= 0 ? 50_000 : 50_000 - net;
  return {
    marketCode: '088691',
    marketName: 'GOLD',
    reportDate: new Date(date),
    openInterest: oi,
    noncommLong: long,
    noncommShort: short,
    commLong: 0,
    commShort: 0,
  };
}

describe('deriveCotPositioning', () => {
  it('not_applicable ohne Historie', () => {
    expect(deriveCotPositioning([]).status).toBe('not_applicable');
  });

  it('crowded_long bei Extrem-Perzentil oben', () => {
    // Historie steigend, letzter Wert am Maximum → hohes Perzentil
    const hist: CotRow[] = [];
    for (let i = 0; i < 20; i++) hist.push(row(1000 + i * 1000, 100_000, `2026-0${1 + Math.floor(i / 5)}-0${(i % 5) + 1}`));
    const pos = deriveCotPositioning(hist);
    expect(pos.percentile).toBeGreaterThanOrEqual(0.85);
    expect(['crowded_long', 'contrarian_alert']).toContain(pos.status);
  });

  it('crowded_short bei Extrem-Perzentil unten', () => {
    const hist: CotRow[] = [];
    for (let i = 0; i < 20; i++) hist.push(row(20000 - i * 1000, 100_000, `2026-0${1 + Math.floor(i / 5)}-0${(i % 5) + 1}`));
    const pos = deriveCotPositioning(hist);
    expect(pos.percentile).toBeLessThanOrEqual(0.15);
    expect(['crowded_short', 'contrarian_alert']).toContain(pos.status);
  });

  it('neutral in der Mitte', () => {
    const hist: CotRow[] = [];
    // symmetrisch um 0, letzter Wert nahe Median
    const vals = [-5000, 5000, -3000, 3000, -1000, 1000, -2000, 2000, 0];
    vals.forEach((v, i) => hist.push(row(v, 100_000, `2026-01-0${i + 1}`)));
    const pos = deriveCotPositioning(hist);
    expect(pos.status).toBe('neutral');
  });

  it('contrarian_alert bei Extrem + schneller Zuspitzung', () => {
    const hist: CotRow[] = [];
    for (let i = 0; i < 20; i++) hist.push(row(1000 + i * 500, 100_000, `2026-0${1 + Math.floor(i / 5)}-0${(i % 5) + 1}`));
    // letzter Sprung stark nach oben
    hist.push(row(60_000, 100_000, '2026-05-01'));
    const pos = deriveCotPositioning(hist);
    expect(pos.status).toBe('contrarian_alert');
    expect(pos.weekChange).toBeGreaterThan(0);
  });
});

describe('cotScore', () => {
  it('neutraler Score ohne Positionierung', () => {
    expect(cotScore({ status: 'not_applicable', netNonComm: 0, netRatio: 0, percentile: 0.5, weekChange: 0 }, 'long')).toBe(0.5);
  });
  it('Abschlag, wenn Positionierung mit der Trade-Richtung überläuft', () => {
    const crowdedLong = { status: 'crowded_long' as const, netNonComm: 100, netRatio: 0.4, percentile: 0.9, weekChange: 0.01 };
    expect(cotScore(crowdedLong, 'long')).toBeLessThan(0.5);
    expect(cotScore(crowdedLong, 'short')).toBeGreaterThan(0.5);
  });
  it('bleibt in [0,1]', () => {
    const alert = { status: 'contrarian_alert' as const, netNonComm: 100, netRatio: 0.5, percentile: 0.95, weekChange: 0.1 };
    for (const d of ['long', 'short'] as const) {
      const v = cotScore(alert, d);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
