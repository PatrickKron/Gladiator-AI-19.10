import { describe, expect, it } from 'vitest';
import { candleCloseSourceOf, candleTimeframeFor, signalExecutionBlock } from './signal-venue.js';

/**
 * A2: Signale aus Yahoo/Twelve Data laufen als Paper-Schlusskurs-Ausführung (auch bei Testnet als
 * aktivem Venue) — nie live (dort gibt es für sie keine Börse). Unbekannte Quellen: gesperrt.
 */
describe('signalExecutionBlock', () => {
  it('Binance-Signale sind auf jedem Venue ausführbar (bisheriges Verhalten)', () => {
    expect(signalExecutionBlock('binance')).toBeNull();
    expect(signalExecutionBlock('binance', 'live')).toBeNull();
  });

  it('Yahoo/Twelve Data: Paper und Testnet ausführbar (Schlusskurs-Paper), live gesperrt', () => {
    expect(signalExecutionBlock('yahoo', 'paper')).toBeNull();
    expect(signalExecutionBlock('twelvedata', 'testnet')).toBeNull();
    const reason = signalExecutionBlock('yahoo', 'live');
    expect(reason).toContain('yahoo');
    expect(reason).toMatch(/live gibt es dafür keine Börse/);
  });

  it('unbekannte Quelle: gesperrt', () => {
    expect(signalExecutionBlock('kraken')).toMatch(/Unbekannte Kursquelle/);
  });
});

describe('candleCloseSourceOf', () => {
  it('erkennt nur die Schlusskurs-Venues', () => {
    expect(candleCloseSourceOf('paper-close:yahoo')).toBe('yahoo');
    expect(candleCloseSourceOf('paper-close:twelvedata')).toBe('twelvedata');
    expect(candleCloseSourceOf('paper-close:kraken')).toBeNull();
    expect(candleCloseSourceOf('paper-internal')).toBeNull();
  });
});

describe('candleTimeframeFor', () => {
  it('Börsen-Quellen: 4h liegt als 1h in der DB, sonst unverändert', () => {
    expect(candleTimeframeFor('yahoo', '4h')).toBe('1h');
    expect(candleTimeframeFor('yahoo', '1h')).toBe('1h');
    expect(candleTimeframeFor('binance', '4h')).toBe('4h');
  });
});
