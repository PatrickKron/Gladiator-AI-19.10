import { describe, expect, it } from 'vitest';
import { de } from '../i18n/de.js';
import { bpsLabel, fmtAmount, fmtUsd, pricePrecision, slippageChoices, swapReasonKey, poolAge } from './swap-format.js';

describe('swap-format', () => {
  it('fmtUsd: normale Beträge, Meme-Preise, kompakt', () => {
    expect(fmtUsd(1234.5, 'en')).toBe('$1,234.50');
    expect(fmtUsd(0.0000123456, 'en')).toBe('$0.00001235');
    expect(fmtUsd(1_250_000_000, 'en', true)).toBe('$1.25B');
    expect(fmtUsd(Number.NaN, 'en')).toBe('—');
  });

  it('fmtAmount: große Mengen mit Trennzeichen, kleine mit signifikanten Stellen', () => {
    expect(fmtAmount('3551200.12345', 'de')).toBe('3.551.200,12');
    expect(fmtAmount('0.5', 'de')).toBe('0,5');
    expect(fmtAmount('0.000012345', 'en')).toBe('0.00001235');
    expect(fmtAmount('kaputt', 'de')).toBe('kaputt');
  });

  it('pricePrecision: Meme-Preise mit genug Stellen, große Preise mit 2', () => {
    expect(pricePrecision(0.00002134)).toBe(8); // 0,00002134
    expect(pricePrecision(0.5)).toBe(4);
    expect(pricePrecision(150)).toBe(4);
    expect(pricePrecision(65_000)).toBe(2);
    expect(pricePrecision(1e-20)).toBe(12);
    expect(pricePrecision(Number.NaN)).toBe(2);
  });

  it('Slippage-Auswahl endet an der eigenen Obergrenze', () => {
    expect(slippageChoices(100)).toEqual([10, 50, 100]);
    expect(slippageChoices(1_500)).toEqual([10, 50, 100, 300, 500, 1_000, 1_500]);
    expect(slippageChoices(250)).toEqual([10, 50, 100, 250]);
  });

  it('bpsLabel', () => {
    expect(bpsLabel(50, 'en')).toBe('0.5 %');
    expect(bpsLabel(1_500, 'de')).toBe('15 %');
  });

  it('jeder Grund des Swap-Gates hat eine Übersetzung', () => {
    const reasons = ['recipient_not_owner', 'invalid_amount', 'trade_above_limit', 'slippage_above_limit', 'price_impact_above_limit', 'liquidity_below_limit', 'liquidity_unknown', 'token_unsafe', 'token_tax_above_limit'];
    const swap = (de as unknown as { swap: Record<string, string> }).swap;
    for (const r of reasons) expect(swap[swapReasonKey(r).slice('swap.'.length)]).toBeTruthy();
  });
});

describe('poolAge', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  it('Minuten, Stunden, Tage; unbekannt → —', () => {
    expect(poolAge('2026-10-20T11:55:00Z', 'en', now)).toBe('5 min. ago');
    expect(poolAge('2026-10-20T09:00:00Z', 'en', now)).toBe('3 hr. ago');
    expect(poolAge('2026-10-17T12:00:00Z', 'en', now)).toBe('3 days ago');
    expect(poolAge(null, 'en', now)).toBe('—');
    expect(poolAge('kaputt', 'en', now)).toBe('—');
  });
});
