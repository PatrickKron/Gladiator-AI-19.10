import { describe, expect, it } from 'vitest';
import { localeFor } from './locale.js';

describe('Formatierungs-Locale aus der UI-Sprache', () => {
  it('bildet Sprachcodes auf Regionen ab, Unbekanntes und Leeres → Deutsch', () => {
    expect(localeFor('de')).toBe('de-DE');
    expect(localeFor('de-AT')).toBe('de-DE');
    expect(localeFor('en')).toBe('en-US');
    expect(localeFor('EN-GB')).toBe('en-US');
    expect(localeFor('it')).toBe('it-IT');
    expect(localeFor('es')).toBe('es-ES');
    expect(localeFor('fr')).toBe('fr-FR');
    expect(localeFor('xx')).toBe('de-DE');
    expect(localeFor(undefined)).toBe('de-DE');
    expect(localeFor(null)).toBe('de-DE');
  });

  it('dieselbe Zahl sieht je Sprache konsistent aus (Tausender und Dezimaltrenner)', () => {
    expect((110_000.5).toLocaleString(localeFor('de'), { minimumFractionDigits: 1, maximumFractionDigits: 1 })).toBe('110.000,5');
    expect((110_000.5).toLocaleString(localeFor('en'), { minimumFractionDigits: 1, maximumFractionDigits: 1 })).toBe('110,000.5');
    expect(new Date(Date.UTC(2026, 9, 21, 12, 0)).toLocaleDateString(localeFor('de'), { timeZone: 'UTC' })).toBe('21.10.2026');
    expect(new Date(Date.UTC(2026, 9, 21, 12, 0)).toLocaleDateString(localeFor('en'), { timeZone: 'UTC' })).toBe('10/21/2026');
  });
});
