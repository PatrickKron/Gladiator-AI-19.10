/**
 * Datenqualitäts-Prüfung für OHLCV-Kerzen (08_ §3b):
 * fehlerhafte Kerzen werden NICHT stillschweigend übernommen oder interpoliert.
 */

export type Candle = {
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type RawOhlcv = [number, number, number, number, number, number];

export function parseCandle(raw: RawOhlcv): Candle {
  const [ts, open, high, low, close, volume] = raw;
  return { ts: new Date(ts), open, high, low, close, volume };
}

/** Prüft eine Kerze auf Plausibilität. Liefert Fehlerliste (leer = ok). */
export function validateCandle(c: Candle): string[] {
  const errors: string[] = [];
  const nums = [c.open, c.high, c.low, c.close, c.volume];
  if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) errors.push('nicht-numerischer Wert');
  if (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) errors.push('Preis <= 0');
  if (c.volume < 0) errors.push('negatives Volumen');
  if (c.high < c.low) errors.push('high < low');
  if (c.high < Math.max(c.open, c.close)) errors.push('high unter open/close');
  if (c.low > Math.min(c.open, c.close)) errors.push('low über open/close');
  if (Number.isNaN(c.ts.getTime())) errors.push('ungültiger Timestamp');
  if (c.ts.getTime() > Date.now() + 60_000) errors.push('Timestamp in der Zukunft');
  return errors;
}

/** Trennt gültige und verworfene Kerzen; verworfene werden gemeldet, nie geraten. */
export function sanitizeCandles(raw: RawOhlcv[]): { valid: Candle[]; rejected: { candle: Candle; errors: string[] }[] } {
  const valid: Candle[] = [];
  const rejected: { candle: Candle; errors: string[] }[] = [];
  for (const r of raw) {
    const candle = parseCandle(r);
    const errors = validateCandle(candle);
    if (errors.length === 0) valid.push(candle);
    else rejected.push({ candle, errors });
  }
  return { valid, rejected };
}
