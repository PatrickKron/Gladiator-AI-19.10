import { describe, expect, it } from 'vitest';
import { de } from '../i18n/de.js';
import { bpsLabel, fmtAmount, fmtUsd, pricePrecision, slippageChoices, swapReasonKey, poolAge, avgEntryUsd, initialsPercent, pnlPercent, parseCompactUsd, mcapTriggerPrice, protectionKinds } from './swap-format.js';

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

describe('initialsPercent', () => {
  it('Einstand zurück mit 1 % Puffer, aufgerundet; nur im Gewinn', () => {
    expect(initialsPercent(100, 400)).toBe(25.25); // 101 / 400
    expect(initialsPercent(100, 300)).toBe(33.67);
    expect(initialsPercent(100, 100)).toBeNull(); // kein Gewinn
    expect(initialsPercent(100, 80)).toBeNull();
    expect(initialsPercent(100, 100.5)).toBeNull(); // Puffer ≥ 100 % → Komplettverkauf
    expect(initialsPercent(0, 50)).toBeNull();
    expect(initialsPercent(null, 50)).toBeNull();
  });
});

describe('pnlPercent / avgEntryUsd', () => {
  it('Prozent vom Einstand und Ø-Einstieg; fehlende Werte null', () => {
    expect(pnlPercent(50, 200)).toBe(25);
    expect(pnlPercent(-20, 80)).toBe(-25);
    expect(pnlPercent(null, 80)).toBeNull();
    expect(pnlPercent(5, 0)).toBeNull();
    expect(avgEntryUsd(180, '9000000')).toBeCloseTo(0.00002, 10);
    expect(avgEntryUsd(0, '5')).toBeNull();
    expect(avgEntryUsd(10, '0')).toBeNull();
  });
});

describe('Ziel nach Marktkapitalisierung', () => {
  it('Kurzschreibweise: 10M, 2,5k, 1.2b, $750000; Unsinn → null', () => {
    expect(parseCompactUsd('10M')).toBe(10_000_000);
    expect(parseCompactUsd('2,5k')).toBe(2_500);
    expect(parseCompactUsd(' 1.2b ')).toBe(1_200_000_000);
    expect(parseCompactUsd('$750000')).toBe(750_000);
    for (const bad of ['', 'abc', '10x', '-5m', '0', '1.2.3m', '1,000.50', '1.5,000']) expect(parseCompactUsd(bad)).toBeNull();
    // Tausendertrenner ohne Kürzel (sonst würde ein Stop bei „250,000“ MC zu 250 $ MC und nie auslösen)
    expect(parseCompactUsd('250,000')).toBe(250_000);
    expect(parseCompactUsd('1,000,000')).toBe(1_000_000);
    expect(parseCompactUsd('1.000.000')).toBe(1_000_000);
    expect(parseCompactUsd('2,5')).toBe(2.5);
    // Dreiergruppe + Kürzel ist mehrdeutig (2,5 Mio. oder 2,5 Mrd.?) → nicht raten
    expect(parseCompactUsd('1,000k')).toBeNull();
    expect(parseCompactUsd('2.500m')).toBeNull();
    expect(parseCompactUsd('2.5m')).toBe(2_500_000);
  });

  it('Auslösekurs skaliert mit der Marktkapitalisierung (gleiche Menge im Umlauf)', () => {
    // Kurs 0,0002 $ bei MC 2 Mio. → Ziel 10 Mio. = 5× → 0,001 $
    expect(mcapTriggerPrice(0.0002, 2_000_000, 10_000_000)).toBeCloseTo(0.001, 12);
    expect(mcapTriggerPrice(0.0002, 0, 10_000_000)).toBeNull();
    expect(mcapTriggerPrice(0.0002, 2_000_000, 0)).toBeNull();
  });
});

describe('protectionKinds', () => {
  it('nur offene Schutz-Orders dieses Tokens, feste Reihenfolge, EVM ohne Groß-/Kleinschreibung', () => {
    const T = '0xAbCdEf0000000000000000000000000000000001';
    const orders = [
      { token: T.toLowerCase(), kind: 'dev_sell', status: 'open' },
      { token: T, kind: 'stop_loss', status: 'open' },
      { token: T, kind: 'take_profit', status: 'cancelled' },
      { token: T, kind: 'limit_buy', status: 'open' },
      { token: T, kind: 'alert_above', status: 'open' },
      { token: '0x0000000000000000000000000000000000000002', kind: 'rug_guard', status: 'open' },
    ];
    expect(protectionKinds(orders, T)).toEqual(['stop_loss', 'dev_sell']);
    // Solana-Adressen unterscheiden Groß-/Kleinschreibung
    expect(protectionKinds([{ token: 'AbC', kind: 'rug_guard', status: 'open' }], 'abc')).toEqual([]);
    expect(protectionKinds([], T)).toEqual([]);
  });
});
