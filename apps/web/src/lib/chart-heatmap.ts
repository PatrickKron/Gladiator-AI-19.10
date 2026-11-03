/**
 * Chart-Heatmap-Indikator (Volumen- & Liquiditätsdichte-Profil im Preis-Chart):
 * Berechnet aus den echten geladenen Kerzen ein horizontales Preis-Dichte-Profil
 * (Standard: 24 Preis-Bänder) inklusive Point of Control (POC) und Value Area
 * (VAH / VAL, 70 % der Gesamtdichte um den POC).
 *
 * Funktioniert zuverlässig auf JEDEM Asset:
 * - Krypto, Aktien, ETFs, Rohstoff-Futures mit echtem Handelsvolumen → Modus 'volume'
 *   (Volumen wird über die von der Kerze durchlaufenen Preis-Buckets verteilt,
 *   Kerzenkörper stärker gewichtet als Dochte).
 * - Spot-Forex / Indizes ohne Börsen-Volumen (volume === 0) → ehrlicher Fallback
 *   auf Modus 'liquidity' (Verweildauer + Spanne je Preis-Level, klar als
 *   Liquiditäts-Profil gekennzeichnet).
 * Reine Funktion ohne I/O, kein Zufall.
 */

export type HeatmapCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type HeatmapBucket = {
  bottom: number;
  top: number;
  mid: number;
  weight: number;
  /** Normierte Intensität 0..1 relativ zum stärksten Bucket (POC = 1). */
  intensity: number;
  /** Anteil bullischer Kerzen (close >= open) in diesem Preisband (0..1). */
  buyRatio: number;
  isPoc: boolean;
  inValueArea: boolean;
};

export type ChartHeatmapProfile = {
  mode: 'volume' | 'liquidity';
  fromTime: number;
  toTime: number;
  minPrice: number;
  maxPrice: number;
  pocPrice: number;
  vahPrice: number;
  valPrice: number;
  buckets: HeatmapBucket[];
};

const VALUE_AREA_TARGET = 0.7;

export function computeChartHeatmap(
  candles: readonly HeatmapCandle[],
  bucketCount = 24,
): ChartHeatmapProfile | null {
  if (candles.length < 5 || bucketCount < 4) return null;

  let minPrice = Infinity;
  let maxPrice = -Infinity;
  let positiveVolumeBars = 0;

  for (const c of candles) {
    if (!Number.isFinite(c.low) || !Number.isFinite(c.high) || !Number.isFinite(c.close)) continue;
    if (c.low < minPrice) minPrice = c.low;
    if (c.high > maxPrice) maxPrice = c.high;
    if ((c.volume ?? 0) > 0) positiveVolumeBars++;
  }

  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || maxPrice <= minPrice) {
    return null;
  }

  // Wenn mindestens 20 % der Kerzen echtes Volumen > 0 liefern → Volumen-Profil,
  // sonst (z. B. Spot-Forex mit 0-Volumen) → Preis-Zeit-/Liquiditätsdichte.
  const mode: 'volume' | 'liquidity' =
    positiveVolumeBars >= Math.max(3, Math.floor(candles.length * 0.2)) ? 'volume' : 'liquidity';

  const step = (maxPrice - minPrice) / bucketCount;
  if (step <= 0) return null;

  const weights = new Float64Array(bucketCount);
  const buyWeights = new Float64Array(bucketCount);

  const n = candles.length;
  for (let idx = 0; idx < n; idx++) {
    const c = candles[idx]!;
    const rawVol = c.volume ?? 0;
    const range = Math.max(0, c.high - c.low);
    // Im Liquiditäts-Modus zählt jede Kerze mit Basis-Gewicht + relativer Spanne
    // (leichtes Recency-Gewicht 0.75..1.0 für aktuelle Marktstruktur).
    const recency = 0.75 + 0.25 * (idx / Math.max(1, n - 1));
    const barWeight =
      mode === 'volume'
        ? Math.max(0, rawVol)
        : (1 + (range > 0 ? range / step : 0.25)) * recency;

    if (barWeight <= 0) continue;

    const isBull = c.close >= c.open;
    const startIdx = Math.max(0, Math.min(bucketCount - 1, Math.floor((c.low - minPrice) / step)));
    const endIdx = Math.max(0, Math.min(bucketCount - 1, Math.floor((c.high - minPrice) / step)));

    const bodyLow = Math.min(c.open, c.close);
    const bodyHigh = Math.max(c.open, c.close);
    const bodyStart = Math.max(startIdx, Math.min(bucketCount - 1, Math.floor((bodyLow - minPrice) / step)));
    const bodyEnd = Math.max(startIdx, Math.min(bucketCount - 1, Math.floor((bodyHigh - minPrice) / step)));

    const spanCount = endIdx - startIdx + 1;
    const bodyCount = bodyEnd - bodyStart + 1;

    // 45 % über gesamte Docht-Spanne, 55 % auf den Kerzenkörper konzentriert
    const wickShare = (barWeight * 0.45) / spanCount;
    const bodyShare = (barWeight * 0.55) / bodyCount;

    for (let b = startIdx; b <= endIdx; b++) {
      weights[b]! += wickShare;
      if (isBull) buyWeights[b]! += wickShare;
    }
    for (let b = bodyStart; b <= bodyEnd; b++) {
      weights[b]! += bodyShare;
      if (isBull) buyWeights[b]! += bodyShare;
    }
  }

  let maxWeight = 0;
  let totalWeight = 0;
  let pocIdx = 0;
  for (let b = 0; b < bucketCount; b++) {
    const w = weights[b]!;
    totalWeight += w;
    if (w > maxWeight) {
      maxWeight = w;
      pocIdx = b;
    }
  }

  if (maxWeight <= 0 || totalWeight <= 0) return null;

  // Value Area (70 % der Gesamtdichte rund um den POC)
  const inValueArea = new Array<boolean>(bucketCount).fill(false);
  inValueArea[pocIdx] = true;
  let accumulated = weights[pocIdx]!;
  let lowPtr = pocIdx;
  let highPtr = pocIdx;

  while (accumulated < totalWeight * VALUE_AREA_TARGET && (lowPtr > 0 || highPtr < bucketCount - 1)) {
    const nextLowWeight = lowPtr > 0 ? weights[lowPtr - 1]! : -1;
    const nextHighWeight = highPtr < bucketCount - 1 ? weights[highPtr + 1]! : -1;
    if (nextHighWeight >= nextLowWeight && highPtr < bucketCount - 1) {
      highPtr++;
      inValueArea[highPtr] = true;
      accumulated += weights[highPtr]!;
    } else if (lowPtr > 0) {
      lowPtr--;
      inValueArea[lowPtr] = true;
      accumulated += weights[lowPtr]!;
    } else {
      break;
    }
  }

  const buckets: HeatmapBucket[] = [];
  for (let b = 0; b < bucketCount; b++) {
    const bottom = minPrice + b * step;
    const top = b === bucketCount - 1 ? maxPrice : minPrice + (b + 1) * step;
    const mid = (bottom + top) / 2;
    const w = weights[b]!;
    const bw = buyWeights[b]!;
    buckets.push({
      bottom,
      top,
      mid,
      weight: w,
      intensity: w / maxWeight,
      buyRatio: w > 0 ? bw / w : 0.5,
      isPoc: b === pocIdx,
      inValueArea: inValueArea[b]!,
    });
  }

  return {
    mode,
    fromTime: candles[0]!.time,
    toTime: candles[candles.length - 1]!.time,
    minPrice,
    maxPrice,
    pocPrice: buckets[pocIdx]!.mid,
    valPrice: buckets[lowPtr]!.bottom,
    vahPrice: buckets[highPtr]!.top,
    buckets,
  };
}

