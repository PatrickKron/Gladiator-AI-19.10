/**
 * Kanonische Chart-Timeframes des Systems (Feature A: „alle verfügbaren TFs").
 * Binance liefert per ccxt alle davon; Twelve Data alle außer 12h. Die
 * Reihenfolge ist die Anzeigereihenfolge. Die UI bietet je Asset NUR die
 * Timeframes an, für die ECHTE Kerzen in der DB liegen
 * (market.availableTimeframes) — nichts wird erfunden.
 */

export const SUPPORTED_TIMEFRAMES = ['5m', '15m', '30m', '1h', '2h', '4h', '12h', '1d', '1w', '1M'] as const;
export type SupportedTimeframe = (typeof SUPPORTED_TIMEFRAMES)[number];

/** Ist ein String einer der unterstützten Timeframes? */
export function isSupportedTimeframe(v: string | null | undefined): v is SupportedTimeframe {
  return v != null && (SUPPORTED_TIMEFRAMES as readonly string[]).includes(v);
}

/**
 * Länge eines Timeframes in Millisekunden — für Frische-Checks im Backfill.
 * Monats-Kerze als 30-Tage-Näherung (nur Heuristik, nie als Kerzen-Zeitstempel).
 */
export const TIMEFRAME_MS: Record<SupportedTimeframe, number> = {
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
  '1M': 2_592_000_000,
};

/**
 * Kerzen pro Jahr je Timeframe — zur Annualisierung von Sharpe/Sortino im
 * Backtest. Kalendarische Näherung (365 T/Jahr), konsistent mit den Bar-Längen.
 */
export const BARS_PER_YEAR: Record<SupportedTimeframe, number> = {
  '5m': 105_120,
  '15m': 35_040,
  '30m': 17_520,
  '1h': 8_760,
  '2h': 4_380,
  '4h': 2_190,
  '12h': 730,
  '1d': 365,
  '1w': 52,
  '1M': 12,
};

/**
 * Die vorhandenen Timeframes eines Assets in kanonische Reihenfolge bringen und
 * auf die unterstützten beschränken. Rein/testbar — Basis für die TF-Buttons.
 */
export function orderTimeframes(present: Iterable<string>): SupportedTimeframe[] {
  const set = new Set(present);
  return SUPPORTED_TIMEFRAMES.filter((tf) => set.has(tf));
}
