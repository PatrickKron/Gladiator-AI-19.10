import { assetProfile, isUsEquity, type AssetProfile } from '@gladiator/core/asset-profile';

/**
 * Chart-Seite, Tabs Makro/Risiko je Asset (Patrick 2026-10-25) — reine Entscheidungen, welche
 * Blöcke für das GEWÄHLTE Asset gelten. Gleiche Regeln wie der Server (`assetProfile` aus
 * @gladiator/core); was nicht passt, wird mit ehrlichem Satz ausgeblendet, nie mit Fremddaten gefüllt.
 */

export type AssetMacroPlan = {
  profile: AssetProfile | null;
  /** Funding/OI abfragen (nur Binance-Krypto-Paare haben einen Perp-Feed). */
  derivatives: boolean;
  /** On-Chain gibt es nur für BTC und ETH. */
  onchain: 'btc' | 'eth' | null;
  /** Buffett-Indikator: US-Aktienmarkt; Nicht-US-Aktie ehrlich „nicht anwendbar". */
  valuation: 'us' | 'non_us' | null;
  /** Realzins (DFII10) für Rohstoffe — nur, wenn die Serie schon synchronisiert ist. */
  realYield: boolean;
  /** ETF → COT des Basiswerts (UI sagt das dazu). */
  etf: boolean;
};

export function assetMacroPlan(symbol: string, venue: string): AssetMacroPlan {
  const profile = assetProfile(symbol, venue);
  const base = profile?.base ?? null;
  const equity = profile !== null && (profile.assetClass === 'stock' || profile.assetClass === 'etf' || profile.assetClass === 'index');
  return {
    profile,
    derivatives: venue === 'binance' && profile?.assetClass === 'crypto',
    onchain: base === 'BTC' ? 'btc' : base === 'ETH' ? 'eth' : null,
    valuation: equity ? (isUsEquity(profile) ? 'us' : 'non_us') : null,
    realYield: profile?.assetClass === 'commodity',
    etf: profile?.assetClass === 'etf',
  };
}

export type DerivEntryLike = { fundingRate: number | null; fundingTs: string | Date | null; perp: boolean | null; inSync: boolean };

/** Zustand des Funding/OI-Blocks: Daten da, kein Perp, Perp ohne Sync, Sync ohne Punkte, unbekannt. */
export function derivativeState(e: DerivEntryLike | null | undefined): 'ok' | 'no_perp' | 'not_synced' | 'pending' | 'unknown' {
  if (!e) return 'unknown';
  if (e.fundingTs && e.fundingRate !== null) return 'ok';
  if (e.perp === false) return 'no_perp';
  if (e.perp === null) return 'unknown';
  return e.inSync ? 'pending' : 'not_synced';
}

/** i18n-Schlüssel zum Engine-Fenster: betrifft das Asset ↔ sperrt nur global. Ohne Fenster null. */
export function noTradeNoticeKey(scope: 'none' | 'asset' | 'global'): string | null {
  if (scope === 'asset') return 'aegis.noTradeAsset';
  if (scope === 'global') return 'aegis.noTradeGlobalOnly';
  return null;
}

const UNIT: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };

/** Einheit hinter einem Kurs; unbekannte Kurswährung → kein Zeichen (nie ein falsches „$"). */
export function priceUnit(ccy: string | null | undefined): string {
  if (!ccy) return '';
  return UNIT[ccy] ?? ccy;
}

/** SAFE-003-Ampel: Bewegung gegen Limit (Engine: „>" sperrt). */
export function safe003State(movePct: number | null, maxPct: number | null): 'ok' | 'breach' | 'unknown' | 'na' {
  if (maxPct === null) return 'na';
  if (movePct === null) return 'unknown';
  return movePct > maxPct ? 'breach' : 'ok';
}
