import { describe, expect, it } from 'vitest';
import { minutesUntil, oracleVerdict, sentinelVerdict, shadowVerdict } from './asset-analysis.js';

describe('oracleVerdict', () => {
  it('ohne Makro und ohne Regime ehrlich „nichts“, sonst Kombination aus Regime und Makro', () => {
    expect(oracleVerdict({ macroConnected: false, grsLabel: null, emaRegime: null, marketPhase: null }).key).toBe('analysis.v.oracleNone');
    expect(oracleVerdict({ macroConnected: false, grsLabel: null, emaRegime: 'above', marketPhase: 'bull' })).toMatchObject({ tone: 'pos', key: 'analysis.v.regimeUpOnly' });
    expect(oracleVerdict({ macroConnected: true, grsLabel: 'risk-on', emaRegime: 'above', marketPhase: 'bull' })).toMatchObject({ tone: 'pos', key: 'analysis.v.tailwind' });
    expect(oracleVerdict({ macroConnected: true, grsLabel: 'risk-off', emaRegime: 'below', marketPhase: 'bear' })).toMatchObject({ tone: 'neg', key: 'analysis.v.headwind' });
    expect(oracleVerdict({ macroConnected: true, grsLabel: 'risk-off', emaRegime: 'above', marketPhase: 'bull' })).toMatchObject({ tone: 'warn', key: 'analysis.v.upAgainstMacro' });
    expect(oracleVerdict({ macroConnected: true, grsLabel: 'neutral', emaRegime: null, marketPhase: null }).key).toBe('analysis.v.macroOnly_neutral');
  });
});

describe('shadowVerdict', () => {
  it('nichts verbunden → ehrlich; COT-Extreme vor Funding; Funding ab 0,05 % gespannt; OI-Sprung ab 10 %', () => {
    expect(shadowVerdict({ derivativesConnected: false, fundingRate: null, oiChangePct24h: null, cotConnected: false, cotStatus: null, cotNetRatio: null }).key).toBe('analysis.v.shadowNone');
    expect(shadowVerdict({ derivativesConnected: true, fundingRate: 0.0008, oiChangePct24h: 2, cotConnected: true, cotStatus: 'crowded_long', cotNetRatio: 0.4 }).key).toBe('analysis.v.crowdedLongHot');
    expect(shadowVerdict({ derivativesConnected: true, fundingRate: 0.0001, oiChangePct24h: 2, cotConnected: true, cotStatus: 'crowded_long', cotNetRatio: 0.4 }).key).toBe('analysis.v.crowdedLong');
    expect(shadowVerdict({ derivativesConnected: true, fundingRate: -0.0007, oiChangePct24h: 0, cotConnected: false, cotStatus: null, cotNetRatio: null })).toMatchObject({ key: 'analysis.v.fundingHotShort', params: { pct: '0.070' } });
    expect(shadowVerdict({ derivativesConnected: true, fundingRate: 0.0001, oiChangePct24h: 14, cotConnected: false, cotStatus: null, cotNetRatio: null })).toMatchObject({ key: 'analysis.v.oiSurge', params: { pct: '14.0' } });
    expect(shadowVerdict({ derivativesConnected: true, fundingRate: 0.0001, oiChangePct24h: 1, cotConnected: true, cotStatus: 'neutral', cotNetRatio: 0.1 })).toMatchObject({ tone: 'pos', key: 'analysis.v.shadowCalm' });
  });
});

describe('sentinelVerdict', () => {
  const base = { killSwitchActive: false, noTradeActive: false, noTradeReason: null, nextHighMinutes: null, atrPct: 1.2, exposureNotional: 0, openPositions: 0 };
  it('Reihenfolge: Kill-Switch > No-Trade > High-Impact bald > Volatilität > frei', () => {
    expect(sentinelVerdict({ ...base, killSwitchActive: true }).key).toBe('analysis.v.killSwitch');
    expect(sentinelVerdict({ ...base, noTradeActive: true, noTradeReason: 'CPI' })).toMatchObject({ tone: 'neg', key: 'analysis.v.noTrade', params: { reason: 'CPI' } });
    expect(sentinelVerdict({ ...base, nextHighMinutes: 45 })).toMatchObject({ tone: 'warn', params: { min: 45 } });
    expect(sentinelVerdict({ ...base, atrPct: 6.3 })).toMatchObject({ key: 'analysis.v.volatile', params: { atr: '6.3' } });
    expect(sentinelVerdict({ ...base, openPositions: 2 })).toMatchObject({ tone: 'pos', key: 'analysis.v.clearWithPosition' });
    expect(sentinelVerdict(base)).toMatchObject({ tone: 'pos', key: 'analysis.v.clear' });
  });
  it('Engine-Sperre durch einen Termin, der dieses Asset nicht betrifft: trotzdem gesperrt, aber ehrlich als global benannt', () => {
    expect(sentinelVerdict({ ...base, noTradeActive: true, noTradeReason: 'BOJ (JPY)', noTradeScope: 'global' })).toMatchObject({ tone: 'neg', key: 'analysis.v.noTradeGlobal', params: { reason: 'BOJ (JPY)' } });
    expect(sentinelVerdict({ ...base, noTradeActive: true, noTradeReason: 'CPI', noTradeScope: 'asset' }).key).toBe('analysis.v.noTrade');
    // nie „frei", solange die Engine sperrt — auch wenn ein Asset-Termin erst später kommt
    expect(sentinelVerdict({ ...base, noTradeActive: true, noTradeReason: 'BOJ', noTradeScope: 'global', nextHighMinutes: 300 }).tone).toBe('neg');
  });
  it('minutesUntil', () => {
    const now = new Date('2026-10-22T10:00:00Z');
    expect(minutesUntil('2026-10-22T11:30:00Z', now)).toBe(90);
    expect(minutesUntil(null, now)).toBeNull();
  });
});
