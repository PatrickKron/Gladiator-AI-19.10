export type TradingSession = 'asia' | 'london' | 'overlap' | 'newyork' | 'off';
export type RiskClass = 'low' | 'medium' | 'high';

export type ConfluenceFlags = {
  /** Trendrichtung passt (EMA-Trend). Pflicht für Entry. */
  trendAligned: boolean;
  /** BOS/CHoCH bestätigt. Pflicht für Entry. */
  structureBreak: boolean;
  /** Gültiger Retest an Bruchlevel/EMA-Pullback. Pflicht für Entry. */
  validRetest: boolean;
  /** RSI im Zielband. Pflicht für Entry. */
  rsiInBand: boolean;
  /** Volumen > Volumen-MA. Pflicht für Entry. */
  volumeConfirmed: boolean;
  /** Unverbrauchte FVG/Imbalance als Ziel vorhanden. */
  fvgTarget: boolean;
  /** London/NY aktiv. */
  sessionActive: boolean;
  /** RR ≥ 2 (bis zum letzten TP). */
  rrAtLeast2: boolean;
  /** Höhere Timeframe: bestätigt / neutral / dagegen. */
  higherTf: 'aligned' | 'neutral' | 'opposed';
  /** Gegen-Liquidität nahe (z. B. Swing-Level dicht über Long-Entry). */
  counterConfluence: boolean;
};

/**
 * Echtes Confluence-Scoring 0–10 nach 05_ §6 — exakt die Blueprint-Gewichte.
 * KEIN hartkodierter Score (Alt-Fehler 7.8). Gewichte werden später durch
 * Backtesting kalibrierbar (strategy_versions.params).
 */
export function computeScore(f: ConfluenceFlags): { score: number; confluence: string[] } {
  let score = 0;
  const confluence: string[] = [];

  if (f.trendAligned) {
    score += 1.5;
    confluence.push('Trend (EMA)');
  }
  if (f.structureBreak) {
    score += 1.5;
    confluence.push('Struktur-Bruch');
  }
  if (f.validRetest) {
    score += 2.0;
    confluence.push('Retest@EMA/Level');
  }
  if (f.rsiInBand) {
    score += 1.0;
    confluence.push('RSI-Band');
  }
  if (f.volumeConfirmed) {
    score += 1.0;
    confluence.push('Volumen');
  }
  if (f.fvgTarget) {
    score += 1.0;
    confluence.push('FVG-Ziel');
  }
  if (f.sessionActive) {
    score += 0.5;
    confluence.push('Session aktiv');
  }
  if (f.rrAtLeast2) {
    score += 1.0;
    confluence.push('RR ≥ 2');
  }
  if (f.higherTf === 'aligned') {
    score += 1.0;
    confluence.push('Higher-TF bestätigt');
  } else if (f.higherTf === 'opposed') {
    score -= 1.0;
    confluence.push('Higher-TF dagegen');
  }
  if (f.counterConfluence) {
    score -= 1.0;
    confluence.push('Gegen-Liquidität nahe');
  }

  return { score: Math.min(10, Math.round(score * 10) / 10), confluence };
}

/** Risk-Klasse nach 05_ §6. */
export function riskClassOf(score: number): RiskClass {
  if (score >= 8) return 'low';
  if (score >= 6) return 'medium';
  return 'high';
}
