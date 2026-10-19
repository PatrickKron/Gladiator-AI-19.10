import { describe, expect, it } from 'vitest';
import {
  TRADES_CSV_HEADER,
  buildTradesCsv,
  csvCell,
  holdingDays,
  holdingOverOneYear,
  taxYear,
  type ExportTrade,
} from './trades-csv.js';

/** Steuer-Export (10_ §6): reiner CSV-Builder — ohne DB, vollständig getestet. */

const base: ExportTrade = {
  symbol: 'BTC/USDT',
  direction: 'long',
  venue: 'paper-internal',
  entryTs: new Date('2025-01-10T12:00:00Z'),
  exitTs: new Date('2025-01-12T12:00:00Z'),
  qty: '0.5',
  entryPrice: '40000',
  exitPrice: '41000',
  grossPnl: '500',
  fee: '12.5',
  funding: '1.25',
  netPnl: '486.25',
  mode: 'paper',
};

describe('csvCell (Escaping)', () => {
  it('lässt einfache Werte unverändert', () => {
    expect(csvCell('BTC/USDT')).toBe('BTC/USDT');
    expect(csvCell('-12.5')).toBe('-12.5');
    expect(csvCell(null)).toBe('');
  });

  it('quotet Felder mit Semikolon, Anführungszeichen oder Zeilenumbruch und verdoppelt "', () => {
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('sag "hallo"')).toBe('"sag ""hallo"""');
    expect(csvCell('zeile1\nzeile2')).toBe('"zeile1\nzeile2"');
    expect(csvCell('x\ry')).toBe('"x\ry"');
  });

  it('entschärft Formel-Injection in Textfeldern (=, +, @, Tab), Zahlen bleiben unberührt', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1+1')).toBe("'+1+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('-0.25')).toBe('-0.25');
  });
});

describe('Haltedauer & §23-EStG-Haltefrist', () => {
  it('Haltedauer in Tagen (2 Nachkommastellen)', () => {
    expect(holdingDays(base.entryTs, base.exitTs!)).toBe('2.00');
    expect(holdingDays(new Date('2025-01-01T00:00:00Z'), new Date('2025-01-01T06:00:00Z'))).toBe('0.25');
  });

  it('> 1 Jahr erst NACH dem Jahrestag (Kalenderjahr, nicht 365 Tage)', () => {
    const entry = new Date('2024-03-01T10:00:00Z');
    expect(holdingOverOneYear(entry, new Date('2025-03-01T10:00:00Z'))).toBe(false); // genau 1 Jahr
    expect(holdingOverOneYear(entry, new Date('2025-03-01T10:00:01Z'))).toBe(true);
    expect(holdingOverOneYear(entry, new Date('2025-02-28T10:00:00Z'))).toBe(false);
  });

  it('Steuerjahr nach deutscher Zeit (Europe/Berlin), nicht UTC', () => {
    // 31.12.2024 23:30 UTC = 01.01.2025 00:30 MEZ → Veräußerungsjahr 2025
    expect(taxYear(new Date('2024-12-31T23:30:00Z'))).toBe(2025);
    expect(taxYear(new Date('2024-12-31T22:30:00Z'))).toBe(2024);
  });
});

describe('buildTradesCsv', () => {
  it('Hinweis-Kommentarzeile, deutsche Kopfzeile, Semikolon-getrennt, Punkt als Dezimaltrenner', () => {
    const csv = buildTradesCsv([base]);
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^# /);
    expect(lines[0]).toMatch(/simuliert/i);
    expect(lines[0]).toMatch(/nicht steuerrelevant/i);
    expect(lines[1]).toBe(TRADES_CSV_HEADER.join(';'));
    expect(TRADES_CSV_HEADER).toEqual([
      'Symbol',
      'Richtung',
      'Eröffnet',
      'Geschlossen',
      'Haltedauer (Tage)',
      'Menge',
      'Einstieg',
      'Ausstieg',
      'Brutto-PnL',
      'Gebühren',
      'Funding',
      'Netto-PnL',
      'Modus',
      'Börse',
      'Haltefrist > 1 Jahr',
    ]);
    expect(lines[2]).toBe(
      'BTC/USDT;long;2025-01-10T12:00:00.000Z;2025-01-12T12:00:00.000Z;2.00;0.5;40000;41000;500;12.5;1.25;486.25;paper;paper-internal;nein',
    );
  });

  it('Jahresfilter nach Veräußerungsjahr; offene Trades werden nicht exportiert', () => {
    const t2024 = { ...base, exitTs: new Date('2024-06-01T00:00:00Z'), entryTs: new Date('2024-05-01T00:00:00Z') };
    const open = { ...base, exitTs: null, exitPrice: null, netPnl: null, grossPnl: null };
    const csv = buildTradesCsv([base, t2024, open], { year: 2025 });
    const rows = csv.trimEnd().split('\n').slice(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('2025-01-12');
    expect(buildTradesCsv([base, t2024, open]).trimEnd().split('\n').slice(2)).toHaveLength(2);
  });

  it('sortiert chronologisch nach Schließzeit, markiert Haltefrist > 1 Jahr mit „ja"', () => {
    const longHold = { ...base, entryTs: new Date('2023-01-01T00:00:00Z'), exitTs: new Date('2025-01-05T00:00:00Z') };
    const rows = buildTradesCsv([base, longHold]).trimEnd().split('\n').slice(2);
    expect(rows[0]!.endsWith(';ja')).toBe(true);
    expect(rows[1]!.endsWith(';nein')).toBe(true);
  });

  it('Live-Trades: Hinweis nennt die Steuerrelevanz nicht als simuliert', () => {
    const csv = buildTradesCsv([{ ...base, mode: 'live' }]);
    expect(csv.split('\n')[0]).toMatch(/Live-Trades/);
    expect(csv.split('\n')[2]).toContain(';live;');
  });

  it('leere Liste → nur Hinweis + Kopfzeile', () => {
    expect(buildTradesCsv([]).trimEnd().split('\n')).toHaveLength(2);
  });
});
