import { describe, expect, it } from 'vitest';
import type { Candle } from '@gladiator/strategy-engine';
import type { RegisteredAsset } from './asset-register.js';
import { buildScanTargets, MAX_SCAN_TARGETS, prepareScanCandles, scanSourceTimeframe, signalAssetClassFor } from './scan-targets.js';
import { MAX_UNIVERSE } from './universe.js';

/**
 * A1 Signal-Scan je Quelle (Übergabe 2026-10-27): Universum aus dem Asset-Register statt nur
 * Krypto, Asset-Klasse aus dem Register (nie geraten), 4h für Yahoo aus 1h, nur abgeschlossene
 * Kerzen. Pur, ohne DB — mit Fixture-Kerzen.
 */

const reg = (symbol: string, venue: RegisteredAsset['venue'], assetType: string): RegisteredAsset => ({
  symbol,
  venue,
  assetType,
  name: symbol,
  ticker: symbol,
  favoritedAt: null,
  userAdded: true,
  createdAt: new Date(0),
});

describe('signalAssetClassFor', () => {
  it('übernimmt die Register-Klasse für Krypto/Aktie/ETF/Index/Forex', () => {
    expect(signalAssetClassFor(reg('BTC/USDT', 'binance', 'CRYPTO'))).toBe('crypto');
    expect(signalAssetClassFor(reg('AAPL', 'yahoo', 'STOCK'))).toBe('stock');
    expect(signalAssetClassFor(reg('SPY', 'yahoo', 'ETF'))).toBe('etf');
    expect(signalAssetClassFor(reg('^GDAXI', 'yahoo', 'INDEX'))).toBe('index');
    expect(signalAssetClassFor(reg('EURUSD=X', 'yahoo', 'FOREX'))).toBe('forex');
  });

  it('Future: nur bekannte Rohstoff-Kontrakte werden commodity; Index-/unbekannte Futures und Fonds bleiben offen (null)', () => {
    expect(signalAssetClassFor(reg('GC=F', 'yahoo', 'FUTURE'))).toBe('commodity');
    expect(signalAssetClassFor(reg('CL=F', 'yahoo', 'FUTURE'))).toBe('commodity');
    expect(signalAssetClassFor(reg('ES=F', 'yahoo', 'FUTURE'))).toBeNull();
    expect(signalAssetClassFor(reg('VFIAX', 'yahoo', 'FUND'))).toBeNull();
    expect(signalAssetClassFor(reg('XYZ', 'yahoo', 'SONSTWAS'))).toBeNull();
  });
});

describe('buildScanTargets', () => {
  it('nimmt jede Quelle in Register-Reihenfolge und überspringt unklare Klassen mit Grund', () => {
    const { targets, skipped } = buildScanTargets([
      reg('BTC/USDT', 'binance', 'CRYPTO'),
      reg('AAPL', 'yahoo', 'STOCK'),
      reg('ES=F', 'yahoo', 'FUTURE'),
      reg('EUR/USD', 'twelvedata', 'FOREX'),
    ]);
    expect(targets).toEqual([
      { symbol: 'BTC/USDT', venue: 'binance', assetClass: 'crypto' },
      { symbol: 'AAPL', venue: 'yahoo', assetClass: 'stock' },
      { symbol: 'EUR/USD', venue: 'twelvedata', assetClass: 'forex' },
    ]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('yahoo:ES=F');
  });

  it('Krypto bleibt auf MAX_UNIVERSE gedeckelt (Binance-Backfill), gesamt auf MAX_SCAN_TARGETS', () => {
    const crypto = Array.from({ length: MAX_UNIVERSE + 5 }, (_, i) => reg(`C${i}/USDT`, 'binance', 'CRYPTO'));
    const stocks = Array.from({ length: MAX_SCAN_TARGETS }, (_, i) => reg(`S${i}`, 'yahoo', 'STOCK'));
    const { targets } = buildScanTargets([...crypto, ...stocks]);
    expect(targets.filter((t) => t.venue === 'binance')).toHaveLength(MAX_UNIVERSE);
    expect(targets).toHaveLength(MAX_SCAN_TARGETS);
  });
});

describe('scanSourceTimeframe / prepareScanCandles', () => {
  const k = (iso: string, close: number, volume = 1): Candle => ({ ts: new Date(iso), open: close, high: close + 1, low: close - 1, close, volume });

  it('4h kommt bei Börsen-Quellen aus 1h, bei Binance direkt', () => {
    expect(scanSourceTimeframe('binance', '4h')).toBe('4h');
    expect(scanSourceTimeframe('yahoo', '4h')).toBe('1h');
    expect(scanSourceTimeframe('twelvedata', '4h')).toBe('1h');
    expect(scanSourceTimeframe('yahoo', '1h')).toBe('1h');
  });

  it('Yahoo 4h: Stundenkerzen werden zu abgeschlossenen UTC-4h-Buckets', () => {
    const raw = [k('2026-10-23T13:30:00Z', 100), k('2026-10-23T14:30:00Z', 101), k('2026-10-23T16:30:00Z', 102), k('2026-10-23T17:30:00Z', 103)];
    const out = prepareScanCandles('yahoo', '4h', raw, new Date('2026-10-23T18:00:00Z'));
    expect(out.map((c) => c.ts.toISOString())).toEqual(['2026-10-23T12:00:00.000Z']);
    expect(out[0]!.close).toBe(101);
  });

  it('jede Quelle: die noch offene letzte Kerze wird nicht bewertet', () => {
    const raw = [k('2026-10-26T10:00:00Z', 1), k('2026-10-26T11:00:00Z', 2)];
    expect(prepareScanCandles('binance', '1h', raw, new Date('2026-10-26T11:30:00Z'))).toHaveLength(1);
    expect(prepareScanCandles('yahoo', '1h', raw, new Date('2026-10-26T12:00:00Z'))).toHaveLength(2);
  });
});

describe('resolveDslTarget (DSL-Scan)', () => {
  it('Register-Treffer liefert Quelle + Klasse; Krypto-Paar ohne Register bleibt Binance; Rest unbekannt', async () => {
    const { resolveDslTarget } = await import('./dsl-scan.js');
    const registered = [reg('AAPL', 'yahoo', 'STOCK'), reg('ETH/USDT', 'binance', 'CRYPTO')];
    expect(resolveDslTarget('aapl', registered)).toEqual({ symbol: 'AAPL', venue: 'yahoo', assetClass: 'stock' });
    expect(resolveDslTarget('XRP/USDT', registered)).toEqual({ symbol: 'XRP/USDT', venue: 'binance', assetClass: 'crypto' });
    expect(resolveDslTarget('MSFT', registered)).toBeNull();
  });
});
