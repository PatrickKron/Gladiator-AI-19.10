/**
 * Bet Sizing via Marcos López de Prado's method:
 * 1. Meta-model outputs probability p of signal success
 * 2. Compute z-score: z = (p - 0.5) / sqrt(p * (1-p) / n)
 *    where n is the sample size used for the probability estimate
 * 3. Map z to position size via normal CDF: size = 2 * CDF(z) - 1
 * 4. Discretize to 0.1 steps to avoid overtrading
 *
 * Output: bet size between 0.0 and 1.0 (fraction of max position).
 */

/**
 * Standard normal CDF approximation (Zelen & Severo, 1964).
 * Φ(x) = 1 - φ(x)(b₁t + b₂t² + b₃t³ + b₄t⁴ + b₅t⁵) for x ≥ 0,
 * where t = 1/(1 + 0.2316419·x) and φ(x) = (1/√(2π))·exp(-x²/2).
 * Max error: 1.1e-7. No external dependencies needed.
 */
export function normalCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;

  // For negative x: Φ(-x) = 1 - Φ(x)
  if (x < 0) return 1 - normalCdf(-x);

  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const p = 0.2316419;

  const t = 1.0 / (1.0 + p * x);
  const pdf = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  const poly = ((((b5 * t + b4) * t + b3) * t + b2) * t + b1) * t;

  return 1.0 - pdf * poly;
}

/**
 * Compute the z-score for the meta-label probability against the null
 * hypothesis H0: p = 0.5 (random coin flip / no skill).
 */
export function zScore(probability: number, sampleSize: number): number {
  if (sampleSize <= 0) return 0;
  const p0 = 0.5;
  const se = Math.sqrt(p0 * (1 - p0) / sampleSize);
  if (se === 0) return 0;
  return (probability - p0) / se;
}

export type BetSizeResult = {
  rawSize: number;
  discretizedSize: number;
  zScore: number;
  confidence: number;
};

/**
 * Convert meta-label probability to a bet size.
 *
 * @param probability - Meta-classifier's predicted probability of success (0 to 1)
 * @param sampleSize - Number of training samples used (affects z-score significance)
 * @param step - Discretization step (default 0.1)
 * @returns Bet size result with raw and discretized values
 */
export function computeBetSize(
  probability: number,
  sampleSize: number,
  step = 0.1,
): BetSizeResult {
  const clamped = Math.max(0, Math.min(1, probability));

  // Below 0.5: no edge → size 0
  if (clamped <= 0.5) {
    return { rawSize: 0, discretizedSize: 0, zScore: 0, confidence: clamped };
  }

  const z = zScore(clamped, sampleSize);

  // Raw size = 2 * CDF(z) - 1, mapped to [0, 1]
  const rawSize = Math.max(0, Math.min(1, 2 * normalCdf(z) - 1));

  // Discretize: round down to nearest step to be conservative
  const stepsDown = Math.floor(rawSize / step);
  // Fix floating point: round to step precision
  const precision = Math.round(1 / step);
  const rounded = Math.round(stepsDown * step * precision) / precision;

  return {
    rawSize,
    discretizedSize: rounded,
    zScore: z,
    confidence: clamped,
  };
}
