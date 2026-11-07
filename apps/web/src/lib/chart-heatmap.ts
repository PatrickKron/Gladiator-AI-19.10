/**
 * 1) `compute2dHeatmap`: Originale 2D Zeit × Preis Liquidations- & Liquiditäts-Heatmap
 *    (wie CoinGlass / Bookmap / TradingLite). Berechnet aus den echten Kerzen für
 *    jede Zeitspalte und jedes Preisband die akkumulierte Stop-/Liquidations-Liquidität
 *    über und unter dem Kurs — und löscht ("sweept") ein Liquiditätsband exakt an der
 *    Kerze, an der der Preis durch das Band handelt!
 *    Funktioniert auf JEDEM Asset (Krypto, Aktien, ETFs, Forex, Rohstoffe).
 *
 * 2) `computeChartHeatmap`: Rechtsbündiges Volumen- & Liquiditäts-Profil (VPVR)
 *    inklusive Point of Control (POC) und Value Area (VAH / VAL, 70 %).
 *
 * Reine Funktionen ohne I/O, kein Zufall.
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

export type Heatmap2dCell = {
  fromTime: number;
  /** null = reicht bis zum aktuellen rechten Rand. */
  toTime: number | null;
  bottom: number;
  top: number;
  /** Normierte Wärme-Intensität 0..1 (Lila → Türkis → Grün → Gelb). */
  intensity: number;
};

export type Heatmap2dResult = {
  mode: 'volume' | 'liquidity';
  rowCount: number;
  minPrice: number;
  maxPrice: number;
  cells: Heatmap2dCell[];
  magnetAbove: { price: number; intensity: number } | null;
  magnetBelow: { price: number; intensity: number } | null;
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

/**
 * Berechnet eine originale 2D Zeit × Preis Liquidations- & Stop-Cluster-Heatmap
 * über den Kerzenverlauf (CoinGlass / Bookmap-Optik).
 *
 * - An jeder Kerze entstehen neue gehebelte Long-/Short-Liquidations- & Stop-Cluster
 *   auf realistischen Hebel-/ATR-Abständen über `high` (Short-Liquidationen) und
 *   unter `low` (Long-Liquidationen), gewichtet nach echtem Volumen (bzw. Aktivität/Spanne).
 * - Diese Liquiditäts-Bänder ziehen sich horizontal durch die Zeit und leuchten umso
 *   heller (Lila → Türkis → Grün → Gelb), je mehr Positionen sich auf demselben Preisniveau
 *   ansammeln.
 * - Sobald eine spätere Kerze mit `[low, high]` durch ein Preisband wischt (Liquidity Sweep /
 *   Liquidation), wird die dort liegende Liquidität abgeräumt!
 */
export function compute2dHeatmap(
  candles: readonly HeatmapCandle[],
  rowCount = 36,
): Heatmap2dResult | null {
  if (candles.length < 8 || rowCount < 12) return null;

  // Auf die jüngsten 180 Kerzen begrenzen, damit das 2D-Gitter scharf und flüssig bleibt
  const slice = candles.length > 180 ? candles.slice(candles.length - 180) : candles;
  const n = slice.length;

  let rawMin = Infinity;
  let rawMax = -Infinity;
  let totalRange = 0;
  let totalVol = 0;
  let positiveVolBars = 0;

  for (const c of slice) {
    if (!Number.isFinite(c.low) || !Number.isFinite(c.high) || !Number.isFinite(c.close)) continue;
    if (c.low < rawMin) rawMin = c.low;
    if (c.high > rawMax) rawMax = c.high;
    totalRange += Math.max(0, c.high - c.low);
    if ((c.volume ?? 0) > 0) {
      totalVol += c.volume!;
      positiveVolBars++;
    }
  }

  if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax) || rawMax <= rawMin) {
    return null;
  }

  const mode: 'volume' | 'liquidity' =
    positiveVolBars >= Math.max(3, Math.floor(n * 0.2)) ? 'volume' : 'liquidity';
  const avgRange = Math.max((rawMax - rawMin) * 0.025, totalRange / n);
  const avgVol = positiveVolBars > 0 ? totalVol / positiveVolBars : 1;

  // Preisgitter leicht über/unter die Extrema erweitern, damit auch äußere Liquidations-Pools sichtbar sind
  const minPrice = Math.max(rawMin * 0.5, rawMin - avgRange * 1.4);
  const maxPrice = rawMax + avgRange * 1.4;
  const step = (maxPrice - minPrice) / rowCount;
  if (step <= 0) return null;

  const pool = new Float64Array(rowCount);
  const matrix: Float64Array[] = new Array(n);

  function deposit(targetPrice: number, amount: number): void {
    const idx = Math.floor((targetPrice - minPrice) / step);
    if (idx < 0 || idx >= rowCount) return;
    pool[idx]! += amount * 0.56;
    if (idx > 0) pool[idx - 1]! += amount * 0.22;
    if (idx < rowCount - 1) pool[idx + 1]! += amount * 0.22;
  }

  // Hebel-/ATR-Abstände für Liquidations- und Stop-Loss-Cluster (100x, 50x, 25x, 10x Äquivalente)
  const tiers: readonly { mult: number; share: number }[] = [
    { mult: 0.65, share: 0.32 },
    { mult: 1.35, share: 0.42 },
    { mult: 2.25, share: 0.30 },
    { mult: 3.30, share: 0.18 },
  ];

  for (let i = 0; i < n; i++) {
    const c = slice[i]!;
    const barRange = Math.max(0, c.high - c.low);

    // 1) Sweep / Liquidation: Preis wischt durch bestehende Liquiditäts-Buckets
    const sweepLow = Math.max(0, Math.floor((c.low - minPrice) / step));
    const sweepHigh = Math.min(rowCount - 1, Math.floor((c.high - minPrice) / step));
    for (let r = 0; r < rowCount; r++) {
      if (r >= sweepLow && r <= sweepHigh) {
        // Liquidität in diesem Band wurde vom Kurs abgeholt / liquidiert
        pool[r] = pool[r]! * 0.12;
      } else {
        // Leichter zeitlicher Zerfall sehr alter Pools
        pool[r] = pool[r]! * 0.992;
      }
    }

    // 2) Neue gehebelte Positionen & Stop-Orders an dieser Kerze
    const relVol = mode === 'volume' ? (c.volume ?? 0) / Math.max(1e-9, avgVol) : barRange / Math.max(1e-9, avgRange);
    const weight = Math.max(0.35, Math.min(3.5, 0.45 + relVol * 0.95));

    // Bullische Kerzen hinterlassen etwas mehr Long-Liquidationen unter dem Tief,
    // bärische Kerzen mehr Short-Liquidationen über dem Hoch
    const isBull = c.close >= c.open;
    const longWeight = weight * (isBull ? 1.15 : 0.9);
    const shortWeight = weight * (!isBull ? 1.15 : 0.9);

    for (const t of tiers) {
      deposit(c.high + t.mult * avgRange, shortWeight * t.share);
      deposit(c.low - t.mult * avgRange, longWeight * t.share);
    }

    // Lokale Swing-Hochs/Tiefs ziehen zusätzliche Stop-Orders an
    if (i >= 2) {
      const p1 = slice[i - 1]!;
      const p2 = slice[i - 2]!;
      if (p1.high > p2.high && p1.high > c.high) {
        deposit(p1.high + 0.25 * avgRange, weight * 0.65);
      }
      if (p1.low < p2.low && p1.low < c.low) {
        deposit(p1.low - 0.25 * avgRange, weight * 0.65);
      }
    }

    matrix[i] = new Float64Array(pool);
  }

  // Normierung über das 96. Perzentil aller aktiven Zellen (verhindert Ausreißer-Blässe)
  const nonZero: number[] = [];
  for (let i = 0; i < n; i++) {
    const col = matrix[i]!;
    for (let r = 0; r < rowCount; r++) {
      const v = col[r]!;
      if (v > 0.05) nonZero.push(v);
    }
  }
  if (nonZero.length === 0) return null;
  nonZero.sort((a, b) => a - b);
  const normMax = Math.max(0.1, nonZero[Math.min(nonZero.length - 1, Math.floor(nonZero.length * 0.96))]!);

  // Horizontale Laufzeit-Komprimierung (verbindet benachbarte Zeitspalten ähnlicher Intensität)
  const cells: Heatmap2dCell[] = [];
  for (let r = 0; r < rowCount; r++) {
    const bottom = minPrice + r * step;
    const top = bottom + step;
    let runStart = -1;
    let runQuant = 0;
    let runSum = 0;
    let runLen = 0;

    for (let i = 0; i < n; i++) {
      const raw = Math.min(1, matrix[i]![r]! / normMax);
      const quant = raw >= 0.14 ? Math.round(raw * 10) / 10 : 0;

      if (quant === runQuant && runStart >= 0) {
        runSum += raw;
        runLen++;
      } else {
        if (runStart >= 0 && runQuant > 0) {
          cells.push({
            fromTime: slice[runStart]!.time,
            toTime: slice[i]!.time,
            bottom,
            top,
            intensity: Math.min(1, runSum / runLen),
          });
        }
        if (quant > 0) {
          runStart = i;
          runQuant = quant;
          runSum = raw;
          runLen = 1;
        } else {
          runStart = -1;
          runQuant = 0;
          runSum = 0;
          runLen = 0;
        }
      }
    }

    if (runStart >= 0 && runQuant > 0) {
      cells.push({
        fromTime: slice[runStart]!.time,
        toTime: null,
        bottom,
        top,
        intensity: Math.min(1, runSum / runLen),
      });
    }
  }

  // Stärkste unberührte Magnet-Zonen über und unter dem letzten Schlusskurs
  const lastClose = slice[n - 1]!.close;
  const lastCol = matrix[n - 1]!;
  let magnetAbove: { price: number; intensity: number } | null = null;
  let magnetBelow: { price: number; intensity: number } | null = null;

  for (let r = 0; r < rowCount; r++) {
    const mid = minPrice + (r + 0.5) * step;
    const intensity = Math.min(1, lastCol[r]! / normMax);
    if (intensity < 0.25) continue;
    if (mid > lastClose) {
      if (!magnetAbove || intensity > magnetAbove.intensity) {
        magnetAbove = { price: mid, intensity };
      }
    } else if (mid < lastClose) {
      if (!magnetBelow || intensity > magnetBelow.intensity) {
        magnetBelow = { price: mid, intensity };
      }
    }
  }

  return {
    mode,
    rowCount,
    minPrice,
    maxPrice,
    cells,
    magnetAbove,
    magnetBelow,
  };
}
