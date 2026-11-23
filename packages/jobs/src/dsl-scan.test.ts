import { describe, expect, it } from 'vitest';
import { resolveDslScanTargets } from './dsl-scan.js';
import type { RegisteredAsset } from './asset-register.js';

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
