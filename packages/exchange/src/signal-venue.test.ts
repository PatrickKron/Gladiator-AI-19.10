import { describe, expect, it } from 'vitest';
import { signalExecutionBlock } from './signal-venue.js';

/**
 * A1 Signal-Scan je Quelle: Signale aus Yahoo/Twelve Data entstehen ab jetzt, ihre Ausführung
 * (Schlusskurs-Ausführung im Agenten-Konto) folgt erst mit A2. Bis dahin wird ehrlich gesperrt —
 * nie über Binance-Marktregeln eines falschen Symbols.
 */
describe('signalExecutionBlock', () => {
  it('Binance-Signale sind ausführbar (bisheriges Verhalten)', () => {
    expect(signalExecutionBlock('binance')).toBeNull();
  });

  it('andere Kerzenquellen: verständlicher Grund statt Börsenfehler', () => {
    const reason = signalExecutionBlock('yahoo');
    expect(reason).toContain('yahoo');
    expect(reason).toMatch(/noch nicht/);
    expect(signalExecutionBlock('twelvedata')).not.toBeNull();
  });
});
