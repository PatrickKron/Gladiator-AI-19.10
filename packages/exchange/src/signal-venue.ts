/**
 * Ausführbarkeit eines Signals nach Kerzenquelle (`signals.venue`, Migration 0044). Binance-Signale
 * laufen über den aktiven Trading-Venue. Signale aus Yahoo/Twelve Data (Aktien, ETF, Forex,
 * Rohstoffe) haben keine Börse im System — sie laufen seit A2 als Paper-Schlusskurs-Ausführung
 * (`CandleCloseVenue`), auch wenn der aktive Venue ein Testnet ist; nie live. null = ausführbar.
 */
export const CANDLE_CLOSE_SOURCES = ['yahoo', 'twelvedata'] as const;
export type CandleCloseSource = (typeof CANDLE_CLOSE_SOURCES)[number];

/** Venue-Kennung der Schlusskurs-Positionen/-Orders (`positions.venue`, `orders.venue`). */
export const CANDLE_CLOSE_VENUE_PREFIX = 'paper-close:';

export function isCandleCloseSource(source: string): source is CandleCloseSource {
  return (CANDLE_CLOSE_SOURCES as readonly string[]).includes(source);
}

/** `paper-close:yahoo` → `yahoo`; jede andere Venue-Kennung → null. */
export function candleCloseSourceOf(venueId: string): CandleCloseSource | null {
  if (!venueId.startsWith(CANDLE_CLOSE_VENUE_PREFIX)) return null;
  const source = venueId.slice(CANDLE_CLOSE_VENUE_PREFIX.length);
  return isCandleCloseSource(source) ? source : null;
}

export function signalExecutionBlock(source: string, venueKind: 'paper' | 'testnet' | 'live' = 'paper'): string | null {
  if (source === 'binance') return null;
  if (isCandleCloseSource(source)) {
    // Paper und Testnet (kein echtes Geld): Schlusskurs-Paper. Live: es gibt keine Börse dafür.
    return venueKind === 'live'
      ? `Signale aus der Kursquelle „${source}“ laufen nur als Paper-Schlusskurs-Ausführung — live gibt es dafür keine Börse.`
      : null;
  }
  return `Unbekannte Kursquelle „${source}“ — Ausführung nicht möglich.`;
}

/** Gespeicherte Kerzen-TF einer Signal-TF: Börsen-Quellen speichern kein 4h (Scans bauen es aus 1h). */
export function candleTimeframeFor(source: string, timeframe: string): string {
  return isCandleCloseSource(source) && timeframe === '4h' ? '1h' : timeframe;
}
