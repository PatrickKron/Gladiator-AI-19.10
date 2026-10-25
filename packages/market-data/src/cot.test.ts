import { describe, expect, it } from 'vitest';
import {
  CFTC_DATASET_URL,
  COT_MARKETS,
  cotHistoryPoints,
  cotIsInverse,
  cotMarketForSymbol,
  cotScore,
  deriveCotPositioning,
  invertCotRows,
  parseCotRows,
  verifyCotRows,
  type CotRow,
} from './cot.js';

describe('cotMarketForSymbol (explizite Alias-Tabelle, kein Präfix-Raten)', () => {
  it('mappt bekannte Symbole', () => {
    expect(cotMarketForSymbol('BTC/USDT')?.label).toBe('BITCOIN_CME');
    expect(cotMarketForSymbol('xau/usd')?.label).toBe('GOLD');
    expect(cotMarketForSymbol('EUR/USD')?.label).toBe('EURO_FX');
  });
  it('null für nicht abgedeckte Symbole', () => {
    expect(cotMarketForSymbol('DOGE/USDT')).toBeNull();
    expect(cotMarketForSymbol('')).toBeNull();
  });
  it.each([
    ['GC=F', 'GOLD'], ['XAUUSD', 'GOLD'], ['XAU/USD', 'GOLD'], ['GC1!', 'GOLD'], ['GLD', 'GOLD'], ['IAU', 'GOLD'],
    ['SI=F', 'SILVER'], ['XAGUSD', 'SILVER'], ['XAG/USD', 'SILVER'], ['SLV', 'SILVER'],
    ['CL=F', 'CRUDE_OIL_WTI'], ['USOIL', 'CRUDE_OIL_WTI'], ['WTIUSD', 'CRUDE_OIL_WTI'], ['USO', 'CRUDE_OIL_WTI'],
    ['BTC/USDT', 'BITCOIN_CME'], ['BTC/USD', 'BITCOIN_CME'], ['BTC-USD', 'BITCOIN_CME'], ['BTCUSD', 'BITCOIN_CME'], ['BTC/USDC', 'BITCOIN_CME'], ['BTC=F', 'BITCOIN_CME'], ['IBIT', 'BITCOIN_CME'],
    ['ETH/USDT', 'ETHER_CME'], ['ETH-USD', 'ETHER_CME'], ['ETHUSD', 'ETHER_CME'], ['ETH=F', 'ETHER_CME'],
    ['ES=F', 'SP500_EMINI'], ['^GSPC', 'SP500_EMINI'], ['SPX', 'SP500_EMINI'], ['SPY', 'SP500_EMINI'], ['ES1!', 'SP500_EMINI'],
    ['NQ=F', 'NASDAQ100_EMINI'], ['^NDX', 'NASDAQ100_EMINI'], ['QQQ', 'NASDAQ100_EMINI'],
    ['EURUSD=X', 'EURO_FX'], ['EUR/USD', 'EURO_FX'], ['EURUSD', 'EURO_FX'], ['6E=F', 'EURO_FX'],
    ['USDJPY=X', 'JAPANESE_YEN'], ['JPY=X', 'JAPANESE_YEN'], ['USD/JPY', 'JAPANESE_YEN'], ['6J=F', 'JAPANESE_YEN'],
    ['GBPUSD=X', 'BRITISH_POUND'], ['GBP/USD', 'BRITISH_POUND'], ['6B=F', 'BRITISH_POUND'],
    ['USDCHF=X', 'SWISS_FRANC'], ['CHF=X', 'SWISS_FRANC'], ['6S=F', 'SWISS_FRANC'],
    ['AUDUSD=X', 'AUSTRALIAN_DOLLAR'], ['AUD/USD', 'AUSTRALIAN_DOLLAR'], ['6A=F', 'AUSTRALIAN_DOLLAR'],
    ['USDCAD=X', 'CANADIAN_DOLLAR'], ['CAD=X', 'CANADIAN_DOLLAR'], ['6C=F', 'CANADIAN_DOLLAR'],
    ['HG=F', 'COPPER'], ['XCUUSD', 'COPPER'],
    ['NG=F', 'NATURAL_GAS'], ['XNGUSD', 'NATURAL_GAS'],
    ['PL=F', 'PLATINUM'], ['XPTUSD', 'PLATINUM'], ['XPT/USD', 'PLATINUM'],
  ])('%s → %s', (symbol, label) => {
    expect(cotMarketForSymbol(symbol)?.label).toBe(label);
  });
  it.each(['GOLD', 'CL', 'CLX', 'SIRI', 'SIG', 'ESTC', 'ES', 'SI', 'GC', 'WTI', 'NQ', 'HG', 'ETHFI/USDT', 'BTCDOM/USDT', 'SPXL', 'SILVER', 'EURUSDT', 'SOL/USDT'])(
    'früherer Präfix-Fehltreffer bzw. mehrdeutiger Ticker %s → null',
    (symbol) => {
      expect(cotMarketForSymbol(symbol)).toBeNull();
    },
  );
  it('Tabelle ist eindeutig: Codes, Labels, Aliase je genau einmal; jeder Markt prüft seinen CFTC-Namen', () => {
    const codes = COT_MARKETS.map((m) => m.code);
    const labels = COT_MARKETS.map((m) => m.label);
    const aliases = COT_MARKETS.flatMap((m) => [...m.appSymbols, ...(m.inverseSymbols ?? [])].map((s) => s.toUpperCase()));
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(COT_MARKETS.length).toBeGreaterThanOrEqual(16);
    for (const m of COT_MARKETS) expect(m.cftcName).toBeInstanceOf(RegExp);
  });
});

describe('cotIsInverse (Kontrakt notiert die Fremdwährung in USD)', () => {
  it('USD/JPY, USD/CHF, USD/CAD sind spiegelbildlich zum CME-Kontrakt', () => {
    for (const s of ['USDJPY=X', 'JPY=X', 'USD/JPY', 'USDCHF=X', 'USDCAD=X', 'CAD=X']) expect(cotIsInverse(s)).toBe(true);
  });
  it('direkte Notierung und Nicht-Forex: nicht gespiegelt', () => {
    for (const s of ['EURUSD=X', '6J=F', 'GBPUSD=X', 'AUDUSD=X', 'GC=F', 'BTC/USDT', 'AAPL']) expect(cotIsInverse(s)).toBe(false);
  });
});

describe('invertCotRows (Sicht eines spiegelbildlich notierten Symbols, z. B. USD/JPY)', () => {
  const mk = (d: string, long: number, short: number): CotRow => ({ marketCode: '097741', marketName: 'YEN', reportDate: new Date(d), openInterest: 100_000, noncommLong: long, noncommShort: short, commLong: 10, commShort: 20 });
  it('tauscht Long/Short (Large Specs und Commercials), Rest unverändert', () => {
    expect(invertCotRows([mk('2026-07-01', 60_000, 40_000)])[0]).toMatchObject({ noncommLong: 40_000, noncommShort: 60_000, commLong: 20, commShort: 10, openInterest: 100_000, marketCode: '097741' });
  });
  it('abgeleitete Positionierung exakt gespiegelt: Netto, Woche, Long ↔ Short', () => {
    const hist: CotRow[] = [];
    for (let i = 0; i < 20; i++) hist.push(mk(`2026-0${1 + Math.floor(i / 5)}-0${(i % 5) + 1}`, 50_000 + i * 1000, 50_000));
    const native = deriveCotPositioning(hist);
    const inv = deriveCotPositioning(invertCotRows(hist));
    expect(['crowded_long', 'contrarian_alert']).toContain(native.status);
    expect(['crowded_short', 'contrarian_alert']).toContain(inv.status);
    expect(inv.netRatio).toBeCloseTo(-native.netRatio, 12);
    expect(inv.netNonComm).toBe(-native.netNonComm);
    expect(inv.weekChange).toBeCloseTo(-native.weekChange, 12);
  });
  it('mit Gleichständen in der Historie bleibt der Perzentilrang echt (kein 1 − p-Näherungswert)', () => {
    const hist = [mk('2026-07-01', 50_000, 50_000), mk('2026-07-08', 50_000, 50_000), mk('2026-07-15', 50_000, 50_000)];
    expect(deriveCotPositioning(invertCotRows(hist)).percentile).toBe(deriveCotPositioning(hist).percentile);
  });
});

describe('verifyCotRows (falscher Code darf nie still falsche Daten liefern)', () => {
  const gold = COT_MARKETS.find((m) => m.label === 'GOLD')!;
  const r = (marketCode: string, marketName: string): CotRow => ({ marketCode, marketName, reportDate: new Date('2026-07-01'), openInterest: 1, noncommLong: 1, noncommShort: 1, commLong: 1, commShort: 1 });
  it('nur Zeilen mit passendem Code UND Namen', () => {
    const res = verifyCotRows(gold, [r('088691', 'GOLD - COMMODITY EXCHANGE INC.'), r('088691', 'SILVER - COMMODITY EXCHANGE INC.'), r('084691', 'GOLD - X')]);
    expect(res.rows).toHaveLength(1);
    expect(res.rejected).toEqual(['088691: SILVER - COMMODITY EXCHANGE INC.', '084691: GOLD - X']);
  });
});

describe('cotHistoryPoints', () => {
  it('aufsteigend nach Datum, netRatio = (long − short) / OI; invertierte Zeilen → gespiegelt', () => {
    const rows: CotRow[] = [
      { marketCode: 'x', marketName: 'x', reportDate: new Date('2026-07-08'), openInterest: 100, noncommLong: 70, noncommShort: 30, commLong: 0, commShort: 0 },
      { marketCode: 'x', marketName: 'x', reportDate: new Date('2026-07-01'), openInterest: 100, noncommLong: 40, noncommShort: 60, commLong: 0, commShort: 0 },
      { marketCode: 'x', marketName: 'x', reportDate: new Date('2026-07-15'), openInterest: 0, noncommLong: 1, noncommShort: 0, commLong: 0, commShort: 0 },
    ];
    expect(cotHistoryPoints(rows)).toEqual([
      { reportDate: '2026-07-01T00:00:00.000Z', netRatio: -0.2 },
      { reportDate: '2026-07-08T00:00:00.000Z', netRatio: 0.4 },
    ]);
    expect(cotHistoryPoints(invertCotRows(rows)).map((p) => p.netRatio)).toEqual([0.2, -0.4]);
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

/**
 * Echte Daten (CFTC Public Reporting, ohne Key — läuft in der CI mit offenem Netz): je Markt der
 * jüngste Report. Ein falscher Kontrakt-Code fällt hier auf (anderer Marktname), statt in der App
 * still falsche Positionierung zu zeigen.
 */
describe('echte Daten (CFTC Socrata, Legacy Futures-Only)', () => {
  it.each(COT_MARKETS.map((m) => [m.label, m] as const))('%s: Code liefert den erwarteten Markt, Report < 120 Tage alt (Code aktiv)', async (_label, m) => {
    const url = `${CFTC_DATASET_URL}?cftc_contract_market_code=${encodeURIComponent(m.code)}&$order=report_date_as_yyyy_mm_dd DESC&$limit=1`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    expect(res.ok).toBe(true);
    const rows = parseCotRows(await res.json());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.marketCode).toBe(m.code);
    expect(rows[0]!.marketName).toMatch(m.cftcName);
    expect(Date.now() - rows[0]!.reportDate.getTime()).toBeLessThan(120 * 86_400_000);
    expect(rows[0]!.openInterest).toBeGreaterThan(0);
  }, 30_000);
});
