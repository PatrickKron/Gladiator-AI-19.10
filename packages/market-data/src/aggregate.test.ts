import { describe, expect, it } from 'vitest';
import { aggregateCandles, closedCandles } from './aggregate.js';
import type { Candle } from './candles.js';

/**
 * 1h → 4h für Quellen ohne 4h-Kerzen (Yahoo; A1 Signal-Scan je Quelle). Pur, ohne DB.
 * UTC-4h-Buckets (00/04/08/12/16/20), nur zeitlich abgeschlossene Buckets, Lücken außerhalb der
 * Börsenzeiten bleiben Lücken — es wird nie eine Kerze erfunden oder aufgefüllt.
 */

const at = (iso: string) => new Date(iso);
const c = (iso: string, o: number, h: number, l: number, cl: number, v: number): Candle => ({ ts: at(iso), open: o, high: h, low: l, close: cl, volume: v });

describe('aggregateCandles 1h → 4h', () => {
  it('fasst einen vollen UTC-Bucket zusammen: open erste, close letzte, high/low extrem, volume Summe', () => {
    const src = [
      c('2026-10-26T00:00:00Z', 10, 12, 9, 11, 1),
      c('2026-10-26T01:00:00Z', 11, 15, 10, 14, 2),
      c('2026-10-26T02:00:00Z', 14, 14, 8, 9, 3),
      c('2026-10-26T03:00:00Z', 9, 10, 9, 10, 4),
    ];
    const out = aggregateCandles(src, '1h', '4h', at('2026-10-26T04:00:00Z'));
    expect(out).toEqual([c('2026-10-26T00:00:00Z', 10, 15, 8, 10, 10)]);
  });

  it('lässt den noch laufenden Bucket weg (nur abgeschlossene Buckets)', () => {
    const src = [
      c('2026-10-26T00:00:00Z', 10, 12, 9, 11, 1),
      c('2026-10-26T04:00:00Z', 11, 13, 10, 12, 1),
      c('2026-10-26T05:00:00Z', 12, 14, 11, 13, 1),
    ];
    const out = aggregateCandles(src, '1h', '4h', at('2026-10-26T06:30:00Z'));
    expect(out.map((k) => k.ts.toISOString())).toEqual(['2026-10-26T00:00:00.000Z']);
  });

  it('Yahoo-Stundenkerzen um :30 (US-Börse 13:30–20:00 UTC) landen im richtigen Bucket; Teil-Buckets der Handelszeit zählen', () => {
    const src = [
      c('2026-10-23T13:30:00Z', 100, 101, 99, 100.5, 10),
      c('2026-10-23T14:30:00Z', 100.5, 102, 100, 101, 10),
      c('2026-10-23T15:30:00Z', 101, 103, 100.5, 102, 10), // reicht bis 16:30 — Bucket 12:00 schließt erst danach
      c('2026-10-23T16:30:00Z', 102, 102, 98, 99, 20),
      c('2026-10-23T17:30:00Z', 99, 100, 97, 98, 20),
      c('2026-10-23T18:30:00Z', 98, 99, 97, 98.5, 20),
      c('2026-10-23T19:30:00Z', 98.5, 99, 98, 98.8, 30),
    ];
    const out = aggregateCandles(src, '1h', '4h', at('2026-10-24T00:00:00Z'));
    expect(out).toEqual([
      c('2026-10-23T12:00:00Z', 100, 103, 99, 102, 30),
      c('2026-10-23T16:00:00Z', 102, 102, 97, 98.8, 90),
    ]);
  });

  it('Bucket, dessen letzte Quellkerze über das Bucket-Ende hinausreicht, gilt erst nach deren Ende als abgeschlossen', () => {
    const src = [c('2026-10-23T15:30:00Z', 101, 103, 100.5, 102, 10)];
    expect(aggregateCandles(src, '1h', '4h', at('2026-10-23T16:10:00Z'))).toEqual([]);
    expect(aggregateCandles(src, '1h', '4h', at('2026-10-23T16:30:00Z'))).toHaveLength(1);
  });

  it('Wochenende/Nacht ohne Kerzen bleibt eine Lücke — keine aufgefüllten Buckets', () => {
    const src = [
      c('2026-10-23T19:30:00Z', 1, 2, 1, 2, 1), // Freitag
      c('2026-10-26T13:30:00Z', 2, 3, 2, 3, 1), // Montag
    ];
    const out = aggregateCandles(src, '1h', '4h', at('2026-10-27T00:00:00Z'));
    expect(out.map((k) => k.ts.toISOString())).toEqual(['2026-10-23T16:00:00.000Z', '2026-10-26T12:00:00.000Z']);
  });

  it('sortiert unsortierte Eingaben und ignoriert doppelte Zeitstempel nicht stillschweigend falsch (erste gewinnt)', () => {
    const src = [
      c('2026-10-26T01:00:00Z', 11, 15, 10, 14, 2),
      c('2026-10-26T00:00:00Z', 10, 12, 9, 11, 1),
      c('2026-10-26T00:00:00Z', 99, 99, 99, 99, 99),
    ];
    const out = aggregateCandles(src, '1h', '4h', at('2026-10-27T00:00:00Z'));
    expect(out).toEqual([c('2026-10-26T00:00:00Z', 10, 15, 9, 14, 3)]);
  });

  it('lehnt Ziel ≤ Quelle, Nicht-Vielfache und Ziele über 1d ab', () => {
    expect(() => aggregateCandles([], '4h', '1h', new Date())).toThrow();
    expect(() => aggregateCandles([], '1h', '1h', new Date())).toThrow();
    expect(() => aggregateCandles([], '30m', '1d', new Date())).not.toThrow();
    // Wochen/Monate liegen nicht auf UTC-Epochen-Grenzen (Epoche = Donnerstag) → nicht unterstützt
    expect(() => aggregateCandles([], '1h', '1w', new Date())).toThrow();
    expect(() => aggregateCandles([], '1h', '1M', new Date())).toThrow();
  });

  it('volumenlose Kerzen (Forex) ergeben Volumen 0, nie NaN', () => {
    const src = [c('2026-10-26T00:00:00Z', 1.1, 1.2, 1.0, 1.15, 0), c('2026-10-26T01:00:00Z', 1.15, 1.16, 1.1, 1.12, 0)];
    const [k] = aggregateCandles(src, '1h', '4h', at('2026-10-26T04:00:00Z'));
    expect(k!.volume).toBe(0);
  });
});

describe('closedCandles', () => {
  it('lässt nur Kerzen durch, deren Intervall vorbei ist (die offene letzte fällt weg)', () => {
    const src = [c('2026-10-26T10:00:00Z', 1, 1, 1, 1, 1), c('2026-10-26T11:00:00Z', 1, 1, 1, 1, 1)];
    expect(closedCandles(src, '1h', at('2026-10-26T11:59:59Z'))).toHaveLength(1);
    expect(closedCandles(src, '1h', at('2026-10-26T12:00:00Z'))).toHaveLength(2);
  });

  it('unbekannter Zeitrahmen ⇒ unverändert (keine geratene Länge)', () => {
    const src = [c('2026-10-26T10:00:00Z', 1, 1, 1, 1, 1)];
    expect(closedCandles(src, '7m', at('2026-10-26T10:00:01Z'))).toEqual(src);
  });

  it('erste offene Kerze schneidet ab — spätere Kerzen sind dann ebenfalls offen', () => {
    const src = [c('2026-10-26T10:00:00Z', 1, 1, 1, 1, 1)];
    expect(closedCandles(src, '1d', at('2026-10-26T23:00:00Z'))).toEqual([]);
  });
});
