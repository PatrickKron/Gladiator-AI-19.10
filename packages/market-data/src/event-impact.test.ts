import { describe, expect, it } from 'vitest';
import { classifyEvent, detectCategory } from './event-impact.js';

/**
 * Der Klassifikator ist die einzige Wahrheit für „welche Assets bewegt dieses
 * Event" — echte ForexFactory-Titel als Fixtures, ökonomisch geprüfte Zuordnung.
 */

describe('detectCategory', () => {
  const cases: [string, string][] = [
    ['Non-Farm Employment Change', 'nfp'],
    ['ADP Non-Farm Employment Change', 'nfp'],
    ['CPI y/y', 'cpi'],
    ['Core CPI m/m', 'cpi'],
    ['PPI m/m', 'ppi'],
    ['Federal Funds Rate', 'fomc'],
    ['FOMC Statement', 'fomc'],
    ['FOMC Press Conference', 'fomc'],
    ['Fed Chair Powell Speaks', 'fed_speak'],
    ['Main Refinancing Rate', 'ecb'],
    ['ECB Press Conference', 'ecb'],
    ['Official Bank Rate', 'boe'],
    ['BOJ Policy Rate', 'boj'],
    ['RBA Interest Rate Decision', 'rate_decision'],
    ['Advance GDP q/q', 'gdp'],
    ['Unemployment Rate', 'unemployment'],
    ['Unemployment Claims', 'jobless_claims'],
    ['Core Retail Sales m/m', 'retail'],
    ['Flash Manufacturing PMI', 'pmi'],
    ['ISM Services PMI', 'pmi'],
    ['Prelim UoM Consumer Sentiment', 'consumer_sentiment'],
    ['New Home Sales', 'housing'],
    ['Trade Balance', 'trade_balance'],
    ['Bank Holiday', 'holiday'],
    ['Natural Gas Storage', 'other'],
  ];
  it.each(cases)('erkennt „%s" als %s', (title, expected) => {
    expect(detectCategory(title)).toBe(expected);
  });
});

describe('classifyEvent — Asset-Zuordnung', () => {
  it('NFP trifft USD-Paare, Gold, S&P 500 und Krypto stark', () => {
    const r = classifyEvent({ title: 'Non-Farm Employment Change', currency: 'USD', importance: 3 });
    expect(r.category).toBe('nfp');
    expect(r.severity).toBe(3);
    expect(r.markets).toEqual(expect.arrayContaining(['usd_pairs', 'gold', 'sp500', 'dxy']));
    expect(r.cryptoRelevance).toBe(3);
    expect(r.equityRelevance).toBe(3);
  });

  it('FOMC ist global und bewegt alle Märkte inkl. Krypto', () => {
    const r = classifyEvent({ title: 'Federal Funds Rate', currency: 'USD', importance: 3 });
    expect(r.scope).toBe('global');
    expect(r.markets).toContain('all_markets');
    expect(r.markets).toContain('crypto');
    expect(r.cryptoRelevance).toBe(3);
  });

  it('EZB-Entscheid bewegt EUR-Paare + DAX, Krypto mittel', () => {
    const r = classifyEvent({ title: 'Main Refinancing Rate', currency: 'EUR', importance: 3 });
    expect(r.category).toBe('ecb');
    expect(r.scope).toBe('eur');
    expect(r.markets).toEqual(expect.arrayContaining(['eur_pairs', 'dax']));
    expect(r.cryptoRelevance).toBe(2);
  });

  it('US-CPI wirkt stärker auf Krypto als EU-CPI', () => {
    const us = classifyEvent({ title: 'CPI y/y', currency: 'USD', importance: 3 });
    const eu = classifyEvent({ title: 'CPI y/y', currency: 'EUR', importance: 3 });
    expect(us.cryptoRelevance).toBeGreaterThan(eu.cryptoRelevance);
    expect(us.markets).toContain('crypto');
    expect(eu.markets).toContain('eur_pairs');
  });

  it('Feiertag hat Severity 1, keine Aktien-Relevanz, keine Markt-Tags', () => {
    const r = classifyEvent({ title: 'Bank Holiday', currency: 'USD', importance: 1 });
    expect(r.category).toBe('holiday');
    expect(r.severity).toBe(1);
    expect(r.equityRelevance).toBe(0);
    expect(r.markets).toHaveLength(0);
  });

  it('leitet Severity aus Importance ab (null ⇒ 1, 2 ⇒ 2, 3 ⇒ 3)', () => {
    expect(classifyEvent({ title: 'X', currency: 'USD', importance: null }).severity).toBe(1);
    expect(classifyEvent({ title: 'X', currency: 'USD', importance: 2 }).severity).toBe(2);
    expect(classifyEvent({ title: 'X', currency: 'USD', importance: 3 }).severity).toBe(3);
  });

  it('unbekanntes USD-Event fällt auf generische USD-Zuordnung zurück', () => {
    const r = classifyEvent({ title: 'Natural Gas Storage', currency: 'USD', importance: 1 });
    expect(r.category).toBe('other');
    expect(r.markets).toContain('usd_pairs');
    expect(r.cryptoRelevance).toBe(2);
  });

  it('unbekanntes Nicht-Major-Event bleibt honest minimal (keine erfundenen Tags)', () => {
    const r = classifyEvent({ title: 'Some Local Index', currency: 'CAD', importance: 1 });
    expect(r.category).toBe('other');
    expect(r.markets).toHaveLength(0); // CAD ist kein Major-Paar-Tag → nichts erfinden
    expect(r.cryptoRelevance).toBe(1);
    expect(r.equityRelevance).toBe(0);
  });

  it('produziert keine doppelten Markt-Tags', () => {
    const r = classifyEvent({ title: 'FOMC Statement', currency: 'USD', importance: 3 });
    expect(new Set(r.markets).size).toBe(r.markets.length);
  });
});
