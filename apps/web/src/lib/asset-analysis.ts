/**
 * Urteile der drei Blicke (Oracle · Shadow · Sentinel) — rein und getestet. Jede Funktion
 * liefert einen i18n-Schlüssel plus Ton; die Zahlen dazu kommen direkt aus den echten
 * Daten. Keine Quelle verbunden ⇒ ehrlicher „nicht verbunden“-Schlüssel, nie ein Urteil
 * aus dem Nichts.
 */

export type Tone = 'pos' | 'neg' | 'warn' | 'mut';
export type Verdict = { tone: Tone; key: string; params?: Record<string, string | number> };

export type OracleInput = {
  macroConnected: boolean;
  grsLabel: 'risk-on' | 'neutral' | 'risk-off' | null;
  emaRegime: 'above' | 'below' | null;
  marketPhase: 'bull' | 'bear' | null;
};

export function oracleVerdict(i: OracleInput): Verdict {
  if (!i.macroConnected && i.emaRegime === null) return { tone: 'mut', key: 'analysis.v.oracleNone' };
  if (!i.macroConnected) return { tone: i.emaRegime === 'above' ? 'pos' : 'neg', key: i.emaRegime === 'above' ? 'analysis.v.regimeUpOnly' : 'analysis.v.regimeDownOnly' };
  if (i.emaRegime === null) return { tone: 'mut', key: `analysis.v.macroOnly_${i.grsLabel ?? 'neutral'}` };
  const up = i.emaRegime === 'above';
  if (up && i.grsLabel === 'risk-on') return { tone: 'pos', key: 'analysis.v.tailwind' };
  if (!up && i.grsLabel === 'risk-off') return { tone: 'neg', key: 'analysis.v.headwind' };
  if (up && i.grsLabel === 'risk-off') return { tone: 'warn', key: 'analysis.v.upAgainstMacro' };
  if (!up && i.grsLabel === 'risk-on') return { tone: 'warn', key: 'analysis.v.downDespiteMacro' };
  return { tone: up ? 'pos' : 'neg', key: up ? 'analysis.v.upNeutral' : 'analysis.v.downNeutral' };
}

export type ShadowInput = {
  derivativesConnected: boolean;
  fundingRate: number | null;
  oiChangePct24h: number | null;
  cotConnected: boolean;
  cotStatus: 'not_applicable' | 'neutral' | 'crowded_long' | 'crowded_short' | 'contrarian_alert' | null;
  cotNetRatio: number | null;
};

/** Funding je 8 h über ±0,05 % gilt als gespannt (Binance-Standard 0,01 %). */
export const FUNDING_HOT = 0.0005;

export function shadowVerdict(i: ShadowInput): Verdict {
  if (!i.derivativesConnected && !i.cotConnected) return { tone: 'mut', key: 'analysis.v.shadowNone' };
  const fundingHot = i.derivativesConnected && i.fundingRate !== null && Math.abs(i.fundingRate) >= FUNDING_HOT;
  const longSide = (i.fundingRate ?? 0) > 0;
  if (i.cotConnected && i.cotStatus === 'contrarian_alert') return { tone: 'warn', key: 'analysis.v.cotContrarian' };
  if (i.cotConnected && i.cotStatus === 'crowded_long') return { tone: 'warn', key: fundingHot && longSide ? 'analysis.v.crowdedLongHot' : 'analysis.v.crowdedLong' };
  if (i.cotConnected && i.cotStatus === 'crowded_short') return { tone: 'warn', key: fundingHot && !longSide ? 'analysis.v.crowdedShortHot' : 'analysis.v.crowdedShort' };
  if (fundingHot) return { tone: 'warn', key: longSide ? 'analysis.v.fundingHotLong' : 'analysis.v.fundingHotShort', params: { pct: (Math.abs(i.fundingRate!) * 100).toFixed(3) } };
  if (i.derivativesConnected && i.oiChangePct24h !== null && Math.abs(i.oiChangePct24h) >= 10) {
    return { tone: 'warn', key: i.oiChangePct24h > 0 ? 'analysis.v.oiSurge' : 'analysis.v.oiDrop', params: { pct: Math.abs(i.oiChangePct24h).toFixed(1) } };
  }
  return { tone: 'pos', key: 'analysis.v.shadowCalm' };
}

export type SentinelInput = {
  killSwitchActive: boolean;
  noTradeActive: boolean;
  noTradeReason: string | null;
  /** Betrifft der Termin des (globalen) Engine-Fensters dieses Asset? `global` = Sperre trotzdem aktiv. */
  noTradeScope?: 'none' | 'asset' | 'global';
  nextHighMinutes: number | null;
  atrPct: number | null;
  exposureNotional: number;
  openPositions: number;
};

export function sentinelVerdict(i: SentinelInput): Verdict {
  if (i.killSwitchActive) return { tone: 'neg', key: 'analysis.v.killSwitch' };
  if (i.noTradeActive) return { tone: 'neg', key: i.noTradeScope === 'global' ? 'analysis.v.noTradeGlobal' : 'analysis.v.noTrade', params: { reason: i.noTradeReason ?? '' } };
  if (i.nextHighMinutes !== null && i.nextHighMinutes <= 120) return { tone: 'warn', key: 'analysis.v.highSoon', params: { min: Math.max(1, Math.round(i.nextHighMinutes)) } };
  if (i.atrPct !== null && i.atrPct >= 5) return { tone: 'warn', key: 'analysis.v.volatile', params: { atr: i.atrPct.toFixed(1) } };
  if (i.openPositions > 0) return { tone: 'pos', key: 'analysis.v.clearWithPosition', params: { n: i.openPositions } };
  return { tone: 'pos', key: 'analysis.v.clear' };
}

export function minutesUntil(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  return (new Date(iso).getTime() - now.getTime()) / 60_000;
}
