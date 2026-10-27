import type { Candle } from './candles.js';
import { TIMEFRAME_MS } from './timeframes.js';

/**
 * Kerzen zu einem größeren Zeitrahmen zusammenfassen (A1 Signal-Scan je Quelle): Yahoo liefert
 * kein 4h, der Multi-TF-Scan braucht es aber (Scan-TF und Trend-Kontext für 1h). Pur, ohne DB.
 *
 * - Buckets auf UTC-Grenzen (4h: 00/04/08/12/16/20) — nur Ziele bis 1d, die einen Tag teilen
 *   (Wochen/Monate liegen nicht auf Epochen-Grenzen).
 * - Nur zeitlich ABGESCHLOSSENE Buckets: Bucket-Ende und Ende der letzten Quellkerze ≤ now. Ein
 *   Bucket mit weniger Quellkerzen (Börse öffnet 13:30 UTC) zählt — er ist vorbei, nicht unvollständig.
 * - Lücken (Nacht, Wochenende, Feiertag) bleiben Lücken; nichts wird aufgefüllt oder erfunden.
 * - Doppelte Zeitstempel: die erste Kerze gewinnt.
 */
export function aggregateCandles(candles: readonly Candle[], sourceTf: string, targetTf: string, now: Date): Candle[] {
  const src = (TIMEFRAME_MS as Record<string, number>)[sourceTf];
  const dst = (TIMEFRAME_MS as Record<string, number>)[targetTf];
  const day = TIMEFRAME_MS['1d'];
  if (!src || !dst || dst <= src || dst % src !== 0 || dst > day || day % dst !== 0) {
    throw new Error(`Aggregation ${sourceTf} → ${targetTf} nicht unterstützt.`);
  }

  const seen = new Set<number>();
  const sorted = [...candles]
    .sort((a, b) => a.ts.getTime() - b.ts.getTime())
    .filter((c) => {
      const t = c.ts.getTime();
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });

  const out: Candle[] = [];
  let cur: { start: number; lastEnd: number; candle: Candle } | null = null;
  const flush = () => {
    if (cur && Math.max(cur.start + dst, cur.lastEnd) <= now.getTime()) out.push(cur.candle);
  };
  for (const c of sorted) {
    const t = c.ts.getTime();
    const start = Math.floor(t / dst) * dst;
    if (cur && cur.start === start) {
      cur.candle.high = Math.max(cur.candle.high, c.high);
      cur.candle.low = Math.min(cur.candle.low, c.low);
      cur.candle.close = c.close;
      cur.candle.volume += c.volume;
      cur.lastEnd = t + src;
      continue;
    }
    flush();
    cur = { start, lastEnd: t + src, candle: { ts: new Date(start), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume } };
  }
  flush();
  return out;
}

/**
 * Nur abgeschlossene Kerzen: Seit dem Upsert-Speichern liegt die gerade laufende Kerze in der DB.
 * Scans bewerten den letzten ABGESCHLOSSENEN Bar — alles ab der ersten offenen Kerze fällt weg.
 * Unbekannter Zeitrahmen ⇒ unverändert (keine geratene Länge).
 */
export function closedCandles<T extends { ts: Date }>(candles: readonly T[], timeframe: string, now: Date): T[] {
  const len = (TIMEFRAME_MS as Record<string, number>)[timeframe];
  if (!len) return [...candles];
  const cut = now.getTime() - len;
  const idx = candles.findIndex((c) => c.ts.getTime() > cut);
  return idx === -1 ? [...candles] : candles.slice(0, idx);
}
