import { describe, expect, it } from 'vitest';
import {
  buildClusterKey,
  clusterKeyLevels,
  CLUSTER_ALL,
  isLegacyClusterKey,
  marketStructureOf,
  parseClusterKey,
} from './study-cluster.js';

describe('Cluster-Key (13_ §2) — eine Funktion für Labor UND Paper', () => {
  const base = {
    strategy: 'smc-core',
    symbol: 'BTC/USDT',
    setupType: 'swing',
    timeframe: '4h',
    session: 'london',
    emaRegime: 'above' as const,
    marketPhase: 'bull' as const,
  };

  it('baut strategy|symbol|setupType|timeframe|session|structure', () => {
    expect(buildClusterKey(base)).toBe('smc-core|BTC/USDT|swing|4h|london|uptrend');
  });

  it('Marktstruktur aus EMA-Regime + Marktphase: gleichgerichtet = Trend, sonst Übergang', () => {
    expect(marketStructureOf('above', 'bull')).toBe('uptrend');
    expect(marketStructureOf('below', 'bear')).toBe('downtrend');
    expect(marketStructureOf('above', 'bear')).toBe('transition');
    expect(marketStructureOf('below', 'bull')).toBe('transition');
    // Unbekannt → ehrlich 'all' statt geraten
    expect(marketStructureOf(null, 'bull')).toBe(CLUSTER_ALL);
    expect(marketStructureOf('above', undefined)).toBe(CLUSTER_ALL);
  });

  it('fehlende Session/Struktur → "all" (ehrlich unbekannt, nicht geraten)', () => {
    expect(buildClusterKey({ ...base, session: null, emaRegime: null })).toBe('smc-core|BTC/USDT|swing|4h|all|all');
  });

  it('Trennzeichen im Strategie-Slug kann den Key nicht verschieben', () => {
    const key = buildClusterKey({ ...base, strategy: 'a|b' });
    expect(key.split('|')).toHaveLength(6);
    expect(parseClusterKey(key)!.strategy).toBe('a/b');
  });

  it('Position 1 = Symbol, 3 = Timeframe (Kompatibilität mit buildDevilEvidence)', () => {
    const parts = buildClusterKey(base).split('|');
    expect(parts[1]).toBe('BTC/USDT');
    expect(parts[3]).toBe('4h');
  });

  it('parse ↔ build ist verlustfrei; Fremdformat → null', () => {
    const key = buildClusterKey(base);
    expect(parseClusterKey(key)).toEqual({
      strategy: 'smc-core',
      symbol: 'BTC/USDT',
      setupType: 'swing',
      timeframe: '4h',
      session: 'london',
      structure: 'uptrend',
    });
    expect(parseClusterKey('kaputt|nur|drei')).toBeNull();
  });

  it('Ebenen für den Fallback (13_ §8): exakt → ohne Struktur → ohne Session+Struktur', () => {
    expect(clusterKeyLevels('smc-core|BTC/USDT|swing|4h|london|uptrend')).toEqual([
      { level: 'exact', key: 'smc-core|BTC/USDT|swing|4h|london|uptrend' },
      { level: 'session', key: 'smc-core|BTC/USDT|swing|4h|london|all' },
      { level: 'base', key: 'smc-core|BTC/USDT|swing|4h|all|all' },
    ]);
    // Bereits grobe Keys erzeugen keine Duplikate
    expect(clusterKeyLevels('smc-core|BTC/USDT|swing|4h|all|all')).toEqual([
      { level: 'base', key: 'smc-core|BTC/USDT|swing|4h|all|all' },
    ]);
    expect(clusterKeyLevels('x')).toEqual([]);
  });

  it('Alt-Format (Labor vor Session 11: Session+Struktur immer "all") wird erkannt', () => {
    expect(isLegacyClusterKey('smc-core|BTC/USDT|swing|4h|all|all')).toBe(true);
    expect(isLegacyClusterKey('smc-core|BTC/USDT|swing|4h|london|all')).toBe(false);
  });
});
