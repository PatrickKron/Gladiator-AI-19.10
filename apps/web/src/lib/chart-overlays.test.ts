import { describe, expect, it } from 'vitest';
import { alertConditionForPrice, buildChartOverlayLines, overlayVenueMatches } from './chart-overlays.js';

describe('chart-overlays', () => {
  it('bestimmt Alert-Bedingung automatisch relativ zum aktuellen Kurs', () => {
    expect(alertConditionForPrice(105, 100)).toBe('above');
    expect(alertConditionForPrice(100, 100)).toBe('above');
    expect(alertConditionForPrice(95, 100)).toBe('below');
    expect(alertConditionForPrice(95, null)).toBe('above');
  });

  it('trennt Aktien-Venues sauber von Krypto-Venues', () => {
    expect(overlayVenueMatches('yahoo', 'yahoo')).toBe(true);
    expect(overlayVenueMatches('yahoo', 'binance')).toBe(false);
    expect(overlayVenueMatches('binance', 'bybit', true)).toBe(true);
    expect(overlayVenueMatches('binance', 'yahoo', true)).toBe(false);
  });

  it('baut Preislinien für Agenten-Position, Demo-Position und aktive Alerts ohne ausgelöste Alerts', () => {
    const lines = buildChartOverlayLines({
      symbol: 'BTC/USDT',
      venue: 'binance',
      agentPositions: [
        {
          symbol: 'BTC/USDT',
          candleVenue: 'binance',
          direction: 'long',
          mode: 'live',
          entryPrice: 90_000,
          stopLoss: { price: 88_000 },
          takeProfits: [{ price: 95_000 }],
        },
        {
          symbol: 'ETH/USDT',
          candleVenue: 'binance',
          direction: 'short',
          entryPrice: 3_000,
        },
      ],
      demoPositions: [
        {
          symbol: 'BTC/USDT',
          venue: 'bybit',
          direction: 'short',
          entryPrice: 92_000,
          stopLoss: 94_000,
          takeProfit: 86_000,
          liquidationPrice: 98_500,
        },
      ],
      alerts: [
        { symbol: 'BTC/USDT', venue: 'binance', condition: 'above', price: '96000', triggeredAt: null, note: 'Ausbruch' },
        { symbol: 'BTC/USDT', venue: 'binance', condition: 'below', price: '85000', triggeredAt: '2026-11-20T00:00:00Z' },
        { symbol: 'BTC/USDT', venue: 'yahoo', condition: 'above', price: '97000', triggeredAt: null },
      ],
    });

    expect(lines.map((l) => [l.title, l.price, l.kind])).toEqual([
      ['LIVE LONG', 90_000, 'entry'],
      ['LIVE SL', 88_000, 'sl'],
      ['LIVE TP1', 95_000, 'tp'],
      ['Demo SHORT', 92_000, 'entry'],
      ['Demo SL', 94_000, 'sl'],
      ['Demo TP', 86_000, 'tp'],
      ['Demo Liq', 98_500, 'liq'],
      ['🔔 ≥ Ausbruch', 96_000, 'alert'],
    ]);
  });
});
