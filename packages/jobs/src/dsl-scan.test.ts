import { describe, expect, it } from 'vitest';
import { inferFallbackRegime, regimeAllowsScan, resolveDslScanTargets } from './dsl-scan.js';
import type { RegisteredAsset } from './asset-register.js';
import type { Candle } from '@gladiator/strategy-engine';

const makeAsset = (
  symbol: string,
  venue: RegisteredAsset['venue'],
  assetType: string,
): RegisteredAsset => ({
  symbol,
  venue,
  assetType,
  name: symbol,
  ticker: symbol,
  favoritedAt: null,
  userAdded: false,
  createdAt: new Date(0),
});

const REGISTERED: RegisteredAsset[] = [
  makeAsset('BTC/USDT', 'binance', 'crypto'),
  makeAsset('ETH/USDT', 'binance', 'crypto'),
  makeAsset('SOL/USDT', 'binance', 'crypto'),
  makeAsset('RHM.DE', 'yahoo', 'stock'),
  makeAsset('XAU/USD', 'twelvedata', 'forex'),
];

describe('resolveDslScanTargets (Multi-Asset-Signal-Scan)', () => {
  it('scannt standardmäßig das Hauptsymbol der Strategie', () => {
    const res = resolveDslScanTargets({ symbol: 'BTC/USDT' }, REGISTERED);
    expect(res.unknownSymbols).toEqual([]);
    expect(res.targets).toEqual([{ symbol: 'BTC/USDT', venue: 'binance', assetClass: 'crypto' }]);
  });

  it('scannt bei signalSymbols: ["*"] alle registrierten Assets aller Quellen', () => {
    const res = resolveDslScanTargets({ symbol: 'BTC/USDT', signalSymbols: ['*'] }, REGISTERED);
    expect(res.unknownSymbols).toEqual([]);
    expect(res.targets.map((t) => `${t.venue}:${t.symbol}`)).toEqual([
      'binance:BTC/USDT',
      'binance:ETH/USDT',
      'binance:SOL/USDT',
      'yahoo:RHM.DE',
      'twelvedata:XAU/USD',
    ]);
  });

  it('scannt gezielte Multi-Asset-Listen dedupliziert und meldet unbekannte Symbole ehrlich', () => {
    const res = resolveDslScanTargets(
      { symbol: 'BTC/USDT', signalSymbols: ['ETH/USDT', 'RHM.DE', 'eth/usdt', 'UNKNOWN_XYZ'] },
      REGISTERED,
    );
    expect(res.targets.map((t) => `${t.venue}:${t.symbol}`)).toEqual(['binance:ETH/USDT', 'yahoo:RHM.DE']);
    expect(res.unknownSymbols).toEqual(['UNKNOWN_XYZ']);
  });
});

describe('Automatische Regime-Weiche (Welle 21)', () => {
  it('erlaubt ohne Einschränkung alle Marktphasen und filtert bei gesetzten Regimes strikt', () => {
    expect(regimeAllowsScan(undefined, 'crisis')).toBe(true);
    expect(regimeAllowsScan([], 'sideways')).toBe(true);
    expect(regimeAllowsScan(['bull', 'bear'], 'bull')).toBe(true);
    expect(regimeAllowsScan(['bull', 'bear'], 'sideways')).toBe(false);
    expect(regimeAllowsScan(['bull', 'bear'], 'crisis')).toBe(false);
    expect(regimeAllowsScan(['sideways'], 'sideways')).toBe(true);
  });

  it('leitet Bull-, Sideways- und Crisis-Regime deterministisch aus echten Kerzen ab', () => {
    const mk = (closes: number[], spreadPct = 0.005): Candle[] =>
      closes.map((c, i) => ({
        ts: new Date(1_700_000_000_000 + i * 3_600_000),
        open: c,
        high: c * (1 + spreadPct),
        low: c * (1 - spreadPct),
        close: c,
        volume: 100,
      }));
    const bullCandles = mk(Array.from({ length: 65 }, (_, i) => 100 + i * 0.5), 0.004);
    expect(inferFallbackRegime(bullCandles)).toBe('bull');

    const flatCandles = mk(Array.from({ length: 65 }, (_, i) => 100 + (i % 2 === 0 ? 0.2 : -0.2)), 0.004);
    expect(inferFallbackRegime(flatCandles)).toBe('sideways');

    const crisisCandles = mk(Array.from({ length: 65 }, () => 100), 0.04); // 8 % bar range
    expect(inferFallbackRegime(crisisCandles)).toBe('crisis');
  });
});
