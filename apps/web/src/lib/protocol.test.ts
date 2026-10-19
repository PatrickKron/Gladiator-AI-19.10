import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION_PREFIXES, auditQuery, exportYears, tradesCsvFilename } from './protocol.js';

describe('auditQuery (Filter → tRPC-Input)', () => {
  it('leere Felder werden weggelassen', () => {
    expect(auditQuery({ action: '', entity: '  ', from: '', to: '' })).toEqual({});
  });

  it('Datum (lokaler Tag) → ISO: from = Tagesbeginn, to = Tagesende', () => {
    const q = auditQuery({ action: 'order.', entity: 'position', from: '2026-03-01', to: '2026-03-02' });
    expect(q.actionPrefix).toBe('order.');
    expect(q.entityType).toBe('position');
    expect(new Date(q.from!).getTime()).toBe(new Date(2026, 2, 1, 0, 0, 0, 0).getTime());
    expect(new Date(q.to!).getTime()).toBe(new Date(2026, 2, 2, 23, 59, 59, 999).getTime());
  });

  it('ungültiges Datum wird ignoriert statt zu werfen', () => {
    expect(auditQuery({ action: '', entity: '', from: 'quatsch', to: '' })).toEqual({});
  });

  it('Präfix-Vorgaben decken die sicherheitsrelevanten Bereiche ab', () => {
    for (const p of ['order.', 'position.', 'auth.', 'settings.']) expect(AUDIT_ACTION_PREFIXES).toContain(p);
  });
});

describe('Steuer-Export-Helfer', () => {
  it('Jahre: aktuelles Jahr absteigend, 5 Stück', () => {
    expect(exportYears(new Date(2026, 9, 19))).toEqual([2026, 2025, 2024, 2023, 2022]);
  });

  it('Dateiname je Jahr bzw. alle Jahre', () => {
    expect(tradesCsvFilename(2025)).toBe('gladiator-trades-2025.csv');
    expect(tradesCsvFilename(null)).toBe('gladiator-trades-alle.csv');
  });
});
