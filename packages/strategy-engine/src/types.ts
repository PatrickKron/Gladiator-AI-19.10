/** Kerzen-Typ der Engine (strukturgleich mit @gladiator/market-data Candle). */
export type Candle = {
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/** Swing-Punkt (Pivot). WICHTIG: erst ab `confirmedAt` verwendbar (look-ahead-frei). */
export type SwingPoint = {
  type: 'high' | 'low';
  /** Bar-Index des Pivots. */
  index: number;
  price: number;
  /** Bar-Index, ab dem der Pivot bestätigt ist (index + rightBars). */
  confirmedAt: number;
};

/** Marktstruktur-Ereignis. */
export type StructureEvent = {
  kind: 'BOS' | 'CHoCH';
  direction: 'bullish' | 'bearish';
  /** Bar-Index, an dem der Bruch (per Schlusskurs) passiert ist. */
  index: number;
  /** Das gebrochene Swing-Level. */
  brokenLevel: number;
  /** Index des gebrochenen Swings. */
  swingIndex: number;
};
