import { describe, expect, it } from 'vitest';
import { parseInstructionDsl } from './dsl.js';
import { presetBySlug, STRATEGY_PRESETS } from './strategy-presets.js';

describe('Strategie-Katalog Presets', () => {
  it('jedes Preset validiert gegen das DSL-Schema (dieselbe Engine wie alle Strategien)', () => {
    for (const p of STRATEGY_PRESETS) {
      const r = parseInstructionDsl(p.dsl);
      expect(r.ok, `${p.slug}: ${r.ok ? '' : (r as { errors: string[] }).errors.join('; ')}`).toBe(true);
    }
  });

  it('Slugs sind eindeutig und id == slug (eine Wahrheit)', () => {
    const slugs = STRATEGY_PRESETS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const p of STRATEGY_PRESETS) expect(p.dsl.id).toBe(p.slug);
  });

  it('alle drei Kategorien sind vertreten (Konservativ/Ausgewogen/Aggressiv)', () => {
    const cats = new Set(STRATEGY_PRESETS.map((p) => p.category));
    expect(cats).toEqual(new Set(['conservative', 'balanced', 'aggressive']));
    // Sortiment: mindestens 3 je Kategorie
    for (const cat of ['conservative', 'balanced', 'aggressive'] as const) {
      expect(STRATEGY_PRESETS.filter((p) => p.category === cat).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('Kategorie-Risiko-Leitplanken werden eingehalten', () => {
    for (const p of STRATEGY_PRESETS) {
      if (p.category === 'conservative') {
        expect(p.dsl.risk.riskPctPerTrade).toBeLessThanOrEqual(0.5);
        expect(p.dsl.risk.maxLeveragePerTrade).toBe(1);
      }
      if (p.category === 'balanced') {
        expect(p.dsl.risk.riskPctPerTrade).toBeLessThanOrEqual(1);
        expect(p.dsl.risk.maxLeveragePerTrade).toBeLessThanOrEqual(2);
      }
      if (p.category === 'aggressive') {
        expect(p.dsl.risk.riskPctPerTrade).toBeLessThanOrEqual(2);
        expect(p.dsl.risk.maxLeveragePerTrade).toBeLessThanOrEqual(5);
      }
    }
  });

  it('nur Symbole mit echter Kerzen-Historie (BTC/ETH/SOL-USDT)', () => {
    for (const p of STRATEGY_PRESETS) {
      expect(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']).toContain(p.dsl.symbol);
    }
  });

  it('presetBySlug findet Presets, unbekannte Slugs → null', () => {
    expect(presetBySlug('katalog-momentum-btc-1h')?.category).toBe('balanced');
    expect(presetBySlug('gibt-es-nicht')).toBeNull();
  });
});
