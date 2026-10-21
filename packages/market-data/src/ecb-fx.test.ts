/**
 * EZB-Referenzkurse (EUR/USD) für die steuerliche Umrechnung: Spalten nach
 * Namen, unplausible Werte raus, Wochenende → letzter Kurs davor, Kalendertag
 * nach deutscher Zeit. „Echte Daten“ fragt die offizielle EZB-API (CI).
 */
import { describe, expect, it } from 'vitest';
import { ecbRateOn, fetchEcbUsdPerEur, parseEcbCsv } from './ecb-fx.js';

describe('parseEcbCsv / ecbRateOn', () => {
  // Aufbau wie die EZB-Antwort (format=csvdata); Werte nur Testeingaben
  const csv = ['KEY,FREQ,TIME_PERIOD,OBS_VALUE,OBS_STATUS', 'EXR.D.USD.EUR.SP00.A,D,2026-01-02,1.1000,A', 'EXR.D.USD.EUR.SP00.A,D,2026-01-05,1.2000,A', 'EXR.D.USD.EUR.SP00.A,D,2026-01-06,NaN,A', 'EXR.D.USD.EUR.SP00.A,D,2026-01-07,45,A'].join('\n');

  it('liest Datum und Wert über die Spaltennamen; unplausible Werte fallen weg', () => {
    const m = parseEcbCsv(csv);
    expect([...m.entries()]).toEqual([
      ['2026-01-02', 1.1],
      ['2026-01-05', 1.2],
    ]);
    expect(() => parseEcbCsv('A,B\n1,2')).toThrow(/TIME_PERIOD/);
  });

  it('Wochenende/Feiertag → letzter Kurs davor; Tag nach deutscher Zeit; zu alt → null', () => {
    const m = parseEcbCsv(csv);
    expect(ecbRateOn(m, new Date('2026-01-04T12:00:00Z'))).toBe(1.1); // Sonntag → Freitag
    expect(ecbRateOn(m, new Date('2026-01-04T23:30:00Z'))).toBe(1.2); // in Berlin schon Montag
    expect(ecbRateOn(m, new Date('2026-01-30T12:00:00Z'))).toBeNull();
  });
});

describe('echte Daten (EZB-Daten-API)', () => {
  it('liefert die Referenzkurse einer Arbeitswoche, plausibel', async () => {
    const m = await fetchEcbUsdPerEur(new Date('2026-01-05T12:00:00Z'), new Date('2026-01-09T12:00:00Z'));
    const week = [...m.entries()].filter(([d]) => d >= '2026-01-05' && d <= '2026-01-09');
    expect(week.length).toBeGreaterThanOrEqual(4);
    for (const [, v] of week) {
      expect(v).toBeGreaterThan(0.8);
      expect(v).toBeLessThan(1.6);
    }
    expect(ecbRateOn(m, new Date('2026-01-10T12:00:00Z'))).toBe(m.get('2026-01-09'));
  }, 30_000);
});
