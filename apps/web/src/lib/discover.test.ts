import { describe, expect, it } from 'vitest';
import { assetClassKey, categoryKey, classFilterKey, classStyle, filterAssets, fmtQuote } from './discover.js';

/**
 * „Entdecken"-Redesign: die Filter-/Label-Logik ist pure — hier abgesichert,
 * damit Patricks Kernkritik (rohe DB-Strings, unklare Klassen) nicht zurückkehrt.
 */

const A = (ticker: string, name: string, assetType: string, isFavorite = false) => ({ ticker, name, assetType, isFavorite });

describe('assetClassKey (Klassen-Badge)', () => {
  it('mappt alle 6 echten DB-Klassen auf i18n-Keys (case-insensitiv)', () => {
    expect(assetClassKey('CRYPTO')).toBe('discover.class_crypto');
    expect(assetClassKey('stock')).toBe('discover.class_stock');
    expect(assetClassKey('ETF')).toBe('discover.class_etf');
    expect(assetClassKey('INDEX')).toBe('discover.class_index');
    expect(assetClassKey('FUTURE')).toBe('discover.class_future');
    expect(assetClassKey('Commodity')).toBe('discover.class_commodity');
  });

  it('unbekannte Typen → null (View zeigt ehrlich den Rohwert)', () => {
    expect(assetClassKey('BOND')).toBeNull();
    expect(assetClassKey('')).toBeNull();
  });
});

describe('classFilterKey (Filter-Chips)', () => {
  it('liefert Plural-Keys je Klasse', () => {
    expect(classFilterKey('STOCK')).toBe('discover.filter_stock');
    expect(classFilterKey('COMMODITY')).toBe('discover.filter_commodity');
  });
});

describe('classStyle (Badge-Farben)', () => {
  it('jede Klasse hat eine eigene Textfarbe (CSS-Variable)', () => {
    expect(classStyle('CRYPTO').color).toBe('var(--color-cyan)');
    expect(classStyle('stock').color).toBe('var(--color-violet)');
  });

  it('unbekannte Klassen fallen neutral aus, nie undefined', () => {
    expect(classStyle('BOND').color).toBe('var(--color-mut)');
  });
});

describe('categoryKey (Paket-Kategorien)', () => {
  it('mappt alle 11 echten v1-Kategorien (Patricks Kritik: rohe DB-Strings wie CASHFLOW_INCOME)', () => {
    const real = [
      'MARKET_ENGINE',
      'EQUITY_CORE',
      'GROWTH_DISRUPTION',
      'CASHFLOW_INCOME',
      'GLOBAL_MARKETS',
      'HARD_ASSETS',
      'FIXED_INCOME',
      'DIGITAL_ASSETS',
      'SENTIMENT_HEDGE',
      'LUXURY_NICHES',
      'FUTURE_FRONTIERS',
    ];
    for (const cat of real) {
      expect(categoryKey(cat), `Kategorie ${cat} braucht einen i18n-Key`).toBe(`discover.cat_${cat.toLowerCase()}`);
    }
  });

  it('unbekannte Kategorie → null (kein geratenes Label)', () => {
    expect(categoryKey('BRAND_NEW_CATEGORY')).toBeNull();
  });
});

describe('filterAssets (Klasse → Favoriten → Suche)', () => {
  const assets = [
    A('BTC', 'Bitcoin', 'CRYPTO', true),
    A('ETH', 'Ethereum', 'CRYPTO'),
    A('AAPL', 'Apple', 'STOCK', true),
    A('MSFT', 'Microsoft', 'STOCK'),
    A('SPY', 'S&P 500 ETF', 'ETF'),
  ];

  it('ohne Filter: alle in Listen-Reihenfolge', () => {
    expect(filterAssets(assets, { query: '', klass: 'all', onlyFavorites: false }).map((a) => a.ticker)).toEqual([
      'BTC',
      'ETH',
      'AAPL',
      'MSFT',
      'SPY',
    ]);
  });

  it('Klassen-Chip filtert exakt eine Klasse', () => {
    expect(filterAssets(assets, { query: '', klass: 'STOCK', onlyFavorites: false }).map((a) => a.ticker)).toEqual(['AAPL', 'MSFT']);
  });

  it('Nur-Favoriten kombiniert mit Klasse', () => {
    expect(filterAssets(assets, { query: '', klass: 'CRYPTO', onlyFavorites: true }).map((a) => a.ticker)).toEqual(['BTC']);
  });

  it('Suche rankt Ticker-Treffer vor Namens-Treffern (rankAssets wiederverwendet)', () => {
    const hits = filterAssets(assets, { query: 'eth', klass: 'all', onlyFavorites: false }).map((a) => a.ticker);
    expect(hits).toEqual(['ETH']);
    // Namens-Treffer: "apple" findet AAPL über den Namen
    expect(filterAssets(assets, { query: 'apple', klass: 'all', onlyFavorites: false }).map((a) => a.ticker)).toEqual(['AAPL']);
  });

  it('kein Treffer → leere Liste (View zeigt „keine Treffer", nicht alles)', () => {
    expect(filterAssets(assets, { query: 'xyz-nichts', klass: 'all', onlyFavorites: false })).toEqual([]);
  });
});

describe('fmtQuote (Kurs mit echter Quell-Währung)', () => {
  // Ganzzahlen, damit die Tests locale-unabhängig sind (kein Dezimal-/Tausendertrennzeichen)
  it('USD/USDT → $, EUR → €, JPY → ¥, GBP → £', () => {
    expect(fmtQuote(42, 'USD')).toBe('42 $');
    expect(fmtQuote(42, 'USDT')).toBe('42 $');
    expect(fmtQuote(42, 'EUR')).toBe('42 €');
    expect(fmtQuote(42, 'JPY')).toBe('42 ¥');
    expect(fmtQuote(42, 'GBP')).toBe('42 £');
  });

  it('exotische Währungen als ISO-Code, null ohne Suffix (Indizes/Renditen)', () => {
    expect(fmtQuote(42, 'HKD')).toBe('42 HKD');
    expect(fmtQuote(42, 'usx')).toBe('42 USX');
    expect(fmtQuote(42, null)).toBe('42');
  });
});
