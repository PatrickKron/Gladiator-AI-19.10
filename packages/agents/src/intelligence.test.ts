import { describe, expect, it } from 'vitest';
import {
  decideHedge,
  escalateRiskClass,
  finalDecisionFor,
  positionSizeModeFor,
  reviewHedge,
  reviewInstitutional,
  type IntelligenceContext,
} from './intelligence.js';

function ctx(over: Partial<IntelligenceContext> = {}): IntelligenceContext {
  return {
    direction: 'long',
    baseRiskClass: 'medium',
    regime: 'bull',
    cpiStatus: 'none',
    cotStatus: 'neutral',
    cotNetRatio: 0,
    buffettStatus: 'not_applicable',
    shadowWarning: '',
    noTradeActive: false,
    ...over,
  };
}

describe('decideHedge — 6 Modi, Prioritätsordnung (PDF §10)', () => {
  it('no_hedge im ruhigen Basisfall', () => {
    expect(decideHedge(ctx()).mode).toBe('no_hedge');
  });

  it('flat bei Krisen-Regime', () => {
    expect(decideHedge(ctx({ regime: 'crisis' })).mode).toBe('flat');
  });

  it('flat im CPI-Release-Fenster', () => {
    expect(decideHedge(ctx({ cpiStatus: 'release_window' })).mode).toBe('flat');
  });

  it('flat bei aktivem No-Trade-Fenster', () => {
    expect(decideHedge(ctx({ noTradeActive: true })).mode).toBe('flat');
  });

  it('flip_warning bei COT-Kontra-Alarm in Trade-Richtung', () => {
    const d = decideHedge(ctx({ direction: 'long', cotStatus: 'contrarian_alert', cotNetRatio: 0.4 }));
    expect(d.mode).toBe('flip_warning');
  });

  it('full_hedge bei mehreren schweren Risiken gleichzeitig', () => {
    const d = decideHedge(ctx({ cpiStatus: 'pre_event', regime: 'high_vol', shadowWarning: 'Stop-Hunt-Cluster', baseRiskClass: 'high' }));
    expect(d.mode).toBe('full_hedge');
  });

  it('partial_hedge im CPI-Vorlauf', () => {
    expect(decideHedge(ctx({ cpiStatus: 'pre_event' })).mode).toBe('partial_hedge');
  });

  it('partial_hedge bei Manipulationswarnung', () => {
    expect(decideHedge(ctx({ shadowWarning: 'Liquidationscluster über Entry' })).mode).toBe('partial_hedge');
  });

  it('reduce bei hoher Volatilität', () => {
    expect(decideHedge(ctx({ regime: 'high_vol' })).mode).toBe('reduce');
  });

  it('reduce bei überlaufener COT in Trade-Richtung (mild)', () => {
    expect(decideHedge(ctx({ direction: 'long', cotStatus: 'crowded_long', cotNetRatio: 0.3 })).mode).toBe('reduce');
  });

  it('reduce bei hoher Risikoklasse', () => {
    expect(decideHedge(ctx({ baseRiskClass: 'high' })).mode).toBe('reduce');
  });

  it('liefert immer stabile Trigger-Schlüssel', () => {
    const d = decideHedge(ctx({ regime: 'high_vol', buffettStatus: 'elevated' }));
    expect(d.triggers).toContain('regime_high_vol');
    expect(d.triggers).toContain('buffett_elevated');
  });
});

describe('reviewHedge → AgentVerdict', () => {
  it('flat = reject (Vorsicht hart), no_hedge = confirm', () => {
    expect(reviewHedge(decideHedge(ctx({ regime: 'crisis' }))).vote).toBe('reject');
    expect(reviewHedge(decideHedge(ctx())).vote).toBe('confirm');
  });
  it('partial/reduce = caution', () => {
    expect(reviewHedge(decideHedge(ctx({ cpiStatus: 'pre_event' }))).vote).toBe('caution');
  });
});

describe('reviewInstitutional (COT + Buffett)', () => {
  it('confirm bei neutraler Positionierung/Bewertung', () => {
    expect(reviewInstitutional(ctx()).vote).toBe('confirm');
  });
  it('caution bei überlaufener COT in Trade-Richtung', () => {
    expect(reviewInstitutional(ctx({ cotStatus: 'crowded_long', cotNetRatio: 0.3 })).vote).toBe('caution');
  });
  it('reject bei COT-Kontra-Alarm in Trade-Richtung', () => {
    expect(reviewInstitutional(ctx({ cotStatus: 'contrarian_alert', cotNetRatio: 0.4 })).vote).toBe('reject');
  });
  it('caution bei extremem Buffett für Longs', () => {
    expect(reviewInstitutional(ctx({ buffettStatus: 'extreme', direction: 'long' })).vote).toBe('caution');
  });
});

describe('Ableitungen für das Signalobjekt', () => {
  it('positionSizeModeFor', () => {
    expect(positionSizeModeFor('flat', 'medium')).toBe('none');
    expect(positionSizeModeFor('full_hedge', 'medium')).toBe('defensive');
    expect(positionSizeModeFor('partial_hedge', 'medium')).toBe('reduced');
    expect(positionSizeModeFor('no_hedge', 'extreme')).toBe('defensive');
    expect(positionSizeModeFor('no_hedge', 'low')).toBe('normal');
  });

  it('finalDecisionFor', () => {
    expect(finalDecisionFor('flat', 'confirm')).toBe('no_trade');
    expect(finalDecisionFor('flip_warning', 'confirm')).toBe('wait');
    expect(finalDecisionFor('partial_hedge', 'confirm')).toBe('hedge');
    expect(finalDecisionFor('no_hedge', 'confirm')).toBe('signal');
    expect(finalDecisionFor('no_hedge', 'reject')).toBe('no_trade');
    expect(finalDecisionFor('no_hedge', 'caution')).toBe('wait');
  });

  it('escalateRiskClass hebt bei Risiko-Flags an, deckelt bei extreme', () => {
    expect(escalateRiskClass('low', ctx())).toBe('low');
    expect(escalateRiskClass('medium', ctx({ regime: 'crisis' }))).toBe('extreme');
    expect(escalateRiskClass('high', ctx({ regime: 'high_vol' }))).toBe('extreme');
    expect(escalateRiskClass('low', ctx({ buffettStatus: 'extreme' }))).toBe('medium');
  });
});
