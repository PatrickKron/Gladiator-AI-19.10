import { assetProfile, type AssetClass } from '@gladiator/core';
import { aggregateCandles, closedCandles } from '@gladiator/market-data';
import type { Candle } from '@gladiator/strategy-engine';
import type { CandleVenue, RegisteredAsset } from './asset-register.js';
import { MAX_UNIVERSE } from './universe.js';

/**
 * Scan-Ziele je Quelle (A1, Übergabe 2026-10-27): der Signal-Scan rechnet jedes registrierte
 * Asset (Binance, Yahoo, Twelve Data) statt nur Krypto. Pur, ohne DB — die DB-Seite liefert
 * `registeredAssets()` und die Kerzen.
 */

/** Gesamt-Cap des Scans; Krypto bleibt zusätzlich auf MAX_UNIVERSE (Binance-Backfill je Lauf). */
export const MAX_SCAN_TARGETS = 80;

export type ScanTarget = { symbol: string; venue: CandleVenue; assetClass: AssetClass };

const REGISTER_CLASS: Record<string, AssetClass> = {
  CRYPTO: 'crypto',
  STOCK: 'stock',
  ETF: 'etf',
  INDEX: 'index',
  FOREX: 'forex',
};

/**
 * Asset-Klasse des Signals aus dem Register. Futures nur, wenn der Kontrakt sicher ein Rohstoff
 * ist (asset-profile); Index-/Zins-/unbekannte Futures und Fonds ⇒ null (das Signal-Modell hat
 * dafür keine Klasse — nie raten).
 */
export function signalAssetClassFor(asset: Pick<RegisteredAsset, 'symbol' | 'venue' | 'assetType'>): AssetClass | null {
  const type = asset.assetType.toUpperCase();
  const direct = REGISTER_CLASS[type];
  if (direct) return direct;
  if (type === 'FUTURE') return assetProfile(asset.symbol, asset.venue)?.assetClass === 'commodity' ? 'commodity' : null;
  return null;
}

/** Register (Prioritäts-Reihenfolge) → Scan-Ziele mit Caps; übersprungene mit Grund fürs Log. */
export function buildScanTargets(registered: readonly RegisteredAsset[]): { targets: ScanTarget[]; skipped: string[] } {
  const targets: ScanTarget[] = [];
  const skipped: string[] = [];
  let crypto = 0;
  for (const asset of registered) {
    if (targets.length >= MAX_SCAN_TARGETS) break;
    const assetClass = signalAssetClassFor(asset);
    if (!assetClass) {
      skipped.push(`${asset.venue}:${asset.symbol} — Asset-Klasse „${asset.assetType}“ hat im Signal-Modell keine Entsprechung`);
      continue;
    }
    if (asset.venue === 'binance') {
      if (crypto >= MAX_UNIVERSE) continue;
      crypto++;
    }
    targets.push({ symbol: asset.symbol, venue: asset.venue, assetClass });
  }
  return { targets, skipped };
}

/** Börsen-Quellen liefern kein 4h — der Scan baut es aus 1h. */
export function scanSourceTimeframe(venue: string, timeframe: string): string {
  return venue !== 'binance' && timeframe === '4h' ? '1h' : timeframe;
}

/**
 * Ladefenster für aus 1h gebaute Reihen: Yahoo hält 1h ein Jahr; ~7 Stundenkerzen je Handelstag
 * ⇒ ~2 abgeschlossene 4h-Buckets je Tag ⇒ ein Jahr ≈ 500 Buckets (≥ 220 für EMA200).
 */
export const AGGREGATE_LOOKBACK_MS = 400 * 86_400_000;

/** Rohkerzen (aufsteigend, aus `scanSourceTimeframe`) → nur abgeschlossene Kerzen im Scan-Zeitrahmen. */
export function prepareScanCandles(venue: string, timeframe: string, raw: readonly Candle[], now: Date): Candle[] {
  const sourceTf = scanSourceTimeframe(venue, timeframe);
  const closed = closedCandles(raw, sourceTf, now);
  return sourceTf === timeframe ? closed : aggregateCandles(closed, sourceTf, timeframe, now);
}
