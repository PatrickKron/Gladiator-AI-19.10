import { describe, expect, it } from 'vitest';
import type { LatestClose } from '@gladiator/market-data';
import { CandleCloseVenue, venueForPosition, venueForSource, withCandleClose } from './candle-close-venue.js';
import type { TradingVenue } from './venue.js';

/**
 * A2 Schlusskurs-Ausführung: Für Aktien/ETF/Forex/Rohstoffe (Yahoo, Twelve Data) gibt es keine
 * Börse im System — Paper-Fills laufen zum letzten ECHTEN, FRISCHEN Kerzenschluss. Veraltet oder
 * keine Kerze ⇒ Fehler (nie ein alter oder erfundener Kurs). Mock nur hier im Test.
 */
const fresh = (price: number): LatestClose => ({ ok: true, price, timeframe: '1h', ts: new Date('2026-10-27T15:00:00Z') });

describe('CandleCloseVenue', () => {
  it('Kennung, Paper-Art und Mark = frischester Schlusskurs der Quelle', async () => {
    const asked: string[] = [];
    const v = new CandleCloseVenue('yahoo', async (symbol) => {
      asked.push(symbol);
      return fresh(187.25);
    });
    expect(v.id).toBe('paper-close:yahoo');
    expect(v.kind).toBe('paper');
    expect(await v.markPrice('AAPL')).toBe(187.25);
    expect(asked).toEqual(['AAPL']);
  });

  it('veraltete oder fehlende Kerzen ⇒ Fehler statt Kurs', async () => {
    const stale = new CandleCloseVenue('yahoo', async () => ({ ok: false, reason: 'stale', lastTs: new Date('2026-10-01T00:00:00Z') }));
    await expect(stale.markPrice('AAPL')).rejects.toThrow(/veraltet/);
    const none = new CandleCloseVenue('twelvedata', async () => ({ ok: false, reason: 'no_candles', lastTs: null }));
    await expect(none.markPrice('EUR/USD')).rejects.toThrow(/Keine echten Kerzen/);
  });

  it('Market-Order füllt zum Schlusskurs (ehrlich beschriftet), Schutz-Orders bleiben offen, idempotent', async () => {
    const v = new CandleCloseVenue('yahoo', async () => fresh(50));
    const entry = await v.placeOrder({ clientOrderId: 'c1', symbol: 'SAP.DE', side: 'buy', type: 'market', qty: 2 });
    expect(entry).toMatchObject({ status: 'filled', fillPrice: 50, filledQty: 2, raw: { execution: 'candle_close', source: 'yahoo' } });
    expect(await v.placeOrder({ clientOrderId: 'c1', symbol: 'SAP.DE', side: 'buy', type: 'market', qty: 2 })).toBe(entry);
    const sl = await v.placeOrder({ clientOrderId: 'c2', symbol: 'SAP.DE', side: 'sell', type: 'stop_market', qty: 2, triggerPrice: 45, reduceOnly: true });
    expect(sl.status).toBe('open');
    const noTrigger = await v.placeOrder({ clientOrderId: 'c3', symbol: 'SAP.DE', side: 'sell', type: 'stop_market', qty: 2 });
    expect(noTrigger.status).toBe('rejected');
  });

  it('Market-Order ohne frischen Kurs ⇒ Fehler (keine Ausführung zum alten Kurs)', async () => {
    const v = new CandleCloseVenue('yahoo', async () => ({ ok: false, reason: 'stale', lastTs: null }));
    await expect(v.placeOrder({ clientOrderId: 'c4', symbol: 'AAPL', side: 'buy', type: 'market', qty: 1 })).rejects.toThrow(/veraltet/);
  });

  it('Marktregeln erlauben Forex-Kurse (Tick 0.0001) und Bruchstücke', async () => {
    const v = new CandleCloseVenue('yahoo', async () => fresh(1));
    expect(await v.marketRules()).toEqual({ tickSize: 0.0001, lotSize: 0.0001, minNotional: 1 });
  });
});

describe('Schlusskurs-Weiche (SourceRoutingVenue)', () => {
  const base = {
    id: 'paper-internal',
    kind: 'paper',
    markPrice: async () => 42,
  } as unknown as TradingVenue;
  const db = {} as never;

  it('delegiert an den Basis-Venue und routet Börsen-Quellen auf den Schlusskurs-Venue', async () => {
    const routed = withCandleClose(db, base);
    expect(routed.id).toBe('paper-internal');
    expect(routed.kind).toBe('paper');
    expect(await routed.markPrice('BTC/USDT')).toBe(42);
    expect(withCandleClose(db, routed)).toBe(routed);
    expect(venueForSource(routed, 'binance')).toBe(routed);
    expect(venueForSource(routed, 'yahoo').id).toBe('paper-close:yahoo');
    expect(venueForSource(routed, 'yahoo')).toBe(venueForSource(routed, 'yahoo'));
    expect(venueForPosition(routed, 'paper-internal')).toBe(routed);
    expect(venueForPosition(routed, 'paper-close:twelvedata')?.id).toBe('paper-close:twelvedata');
  });

  it('Venue ohne Weiche (z. B. Test-Double): Börsen-Quelle ⇒ Fehler, Schlusskurs-Position ⇒ null', () => {
    expect(venueForSource(base, 'binance')).toBe(base);
    expect(() => venueForSource(base, 'yahoo')).toThrow(/nicht eingerichtet/);
    expect(venueForPosition(base, 'paper-internal')).toBe(base);
    expect(venueForPosition(base, 'paper-close:yahoo')).toBeNull();
  });
});
