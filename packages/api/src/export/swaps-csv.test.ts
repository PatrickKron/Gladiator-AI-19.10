/**
 * Steuer-Export der Wallet-Swaps: nur ausgeführte, Steuerjahr nach deutscher
 * Zeit, ehrlicher Hinweis (Paper nicht steuerrelevant, USD, Durchschnittskosten),
 * Formel-Schutz für Token-Namen.
 */
import { describe, expect, it } from 'vitest';
import { buildSwapsCsv, SWAPS_CSV_HEADER, type ExportSwap } from './swaps-csv.js';

const base: ExportSwap = {
  ts: new Date('2026-03-01T10:00:00Z'),
  wallet: 'Trading',
  chain: 'Solana',
  mode: 'live',
  side: 'buy',
  status: 'filled',
  inAmount: '0.5',
  inSymbol: 'SOL',
  inToken: 'So11111111111111111111111111111111111111112',
  outAmount: '1234.5',
  outSymbol: 'BONK',
  outToken: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  valueUsd: '75.00000000',
  feeUsd: '0.00075000',
  realizedPnlUsd: null,
  txHash: 'sig1',
  aggregator: 'jupiter',
};

describe('buildSwapsCsv', () => {
  it('Kopf, Hinweis, nur ausgeführte Swaps, chronologisch; Kauf/Verkauf auf Deutsch', () => {
    const csv = buildSwapsCsv([
      { ...base, ts: new Date('2026-05-01T00:00:00Z'), side: 'sell', realizedPnlUsd: '12.5', txHash: 'sig2' },
      base,
      { ...base, status: 'failed', txHash: 'sig3' },
      { ...base, status: 'pending', txHash: 'sig4' },
    ]);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toMatch(/^# Hinweis: Enthält echte Swaps .*Durchschnittskosten.*FIFO in EUR/);
    expect(lines[1]).toBe(SWAPS_CSV_HEADER.join(';'));
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain(';Kauf;0.5;SOL;');
    expect(lines[2]).toContain(';sig1;jupiter');
    expect(lines[3]).toContain(';Verkauf;');
    expect(lines[3]).toContain(';12.5;;;;sig2;');
    expect(csv).not.toContain('sig3');
    expect(csv).not.toContain('sig4');
  });

  it('EUR-Spalten zum Tageskurs; ohne Kurse leer mit ehrlichem Hinweis', () => {
    const withEur = buildSwapsCsv([base], { eurRate: () => 1.25 });
    expect(withEur.split('\n')[0]).toMatch(/EZB-Referenzkurs des Tages/);
    expect(withEur.split('\n')[2]).toContain(';1.25;60.0000;0.0006;sig1;');
    const without = buildSwapsCsv([base], { eurRate: null });
    expect(without.split('\n')[0]).toMatch(/EZB-Kurse waren nicht abrufbar/);
    expect(without.split('\n')[2]).toContain(';;;;sig1;');
  });

  it('Steuerjahr nach deutscher Zeit (Silvester 23:30 UTC = schon das neue Jahr)', () => {
    const newYear = { ...base, ts: new Date('2025-12-31T23:30:00Z'), txHash: 'neujahr' };
    expect(buildSwapsCsv([newYear], { year: 2026 })).toContain('neujahr');
    expect(buildSwapsCsv([newYear], { year: 2025 })).not.toContain('neujahr');
  });

  it('nur Paper → Hinweis ohne „echte Swaps“; Token-Namen mit Formel werden entschärft', () => {
    const csv = buildSwapsCsv([{ ...base, mode: 'paper', outSymbol: '=HYPERLINK("x")' }]);
    expect(csv.split('\n')[0]).not.toMatch(/echte Swaps/);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
