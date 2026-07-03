/**
 * RAPS-Cluster-Kern (13_ §4–§6): Gitter-Simulation über Hebel × TP-Schema
 * auf Basis ECHTER Trade-Ergebnisse (Backtest oder geschlossene Trades).
 *
 * - Hebel-Kandidaten L ∈ {1,2,3,5,7,10}
 * - TP-Schemas A (50/30/20), B (60/30/10), C (100 % TP1), D (Runner) —
 *   die R-Ergebnisse je Schema liefert die Backtest-Engine pro Trade mit.
 * - μ_L: zeitgewichteter Mittelwert (λ-Decay: jüngere Trades zählen mehr).
 * - DD_L: max. Drawdown der kumulierten, gehebelten R-Sequenz.
 * - RAPS = μ_L / DD_L (primäres Zielmaß).
 * - Constraint: Liquidations-Quote — vereinfachtes Modell (dokumentiert):
 *   isolierte Margin = Notional/L ⇒ liquidiert, wenn MAE% × L ≥ 100 %.
 * - Low-Sample-Schutz: unter minTrades wird das Ergebnis als unsicher markiert.
 */

export type RapsTrade = {
  exitTs: Date;
  pnlRTpA: number;
  pnlRTpB: number;
  pnlRTpC: number;
  pnlRTpD: number;
  maePct: number;
};

export type TpSchemaId = 'A' | 'B' | 'C' | 'D';
export const LEVERAGE_CANDIDATES = [1, 2, 3, 5, 7, 10] as const;
export const TP_SCHEMA_IDS: TpSchemaId[] = ['A', 'B', 'C', 'D'];

export type RapsCell = {
  leverage: number;
  tpSchema: TpSchemaId;
  /** Zeitgewichteter mittlerer gehebelter R-Ertrag. */
  muWeighted: number;
  maxDrawdownR: number;
  rapsScore: number;
  liquidationRate: number;
  excluded: boolean;
};

export type RapsResult = {
  grid: RapsCell[];
  best: RapsCell | null;
  tradeCount: number;
  isLowSampleSize: boolean;
  lambdaTimeDecay: number;
};

export type RapsOptions = {
  now?: Date;
  /** Zerfallsrate pro Tag (0.02 ⇒ Halbwertszeit ≈ 35 Tage). */
  lambdaTimeDecay?: number;
  minTrades?: number;
  /** Max. tolerierte Liquidations-Quote im Gitter (Default 0 — kein Hebel, der liquidiert). */
  maxLiquidationRate?: number;
};

function schemaRof(t: RapsTrade, s: TpSchemaId): number {
  return s === 'A' ? t.pnlRTpA : s === 'B' ? t.pnlRTpB : s === 'C' ? t.pnlRTpC : t.pnlRTpD;
}

export function rapsGrid(trades: RapsTrade[], opts: RapsOptions = {}): RapsResult {
  const now = opts.now ?? trades[trades.length - 1]?.exitTs ?? new Date(0);
  const lambda = opts.lambdaTimeDecay ?? 0.02;
  const minTrades = opts.minTrades ?? 50;
  const maxLiq = opts.maxLiquidationRate ?? 0;

  const sorted = [...trades].sort((a, b) => a.exitTs.getTime() - b.exitTs.getTime());
  const weights = sorted.map((t) => {
    const ageDays = Math.max(0, (now.getTime() - t.exitTs.getTime()) / 86_400_000);
    return Math.exp(-lambda * ageDays);
  });
  const weightSum = weights.reduce((a, b) => a + b, 0);

  const grid: RapsCell[] = [];
  for (const leverage of LEVERAGE_CANDIDATES) {
    for (const tpSchema of TP_SCHEMA_IDS) {
      if (sorted.length === 0) {
        grid.push({ leverage, tpSchema, muWeighted: 0, maxDrawdownR: 0, rapsScore: 0, liquidationRate: 0, excluded: true });
        continue;
      }

      let liq = 0;
      let muNum = 0;
      let cum = 0;
      let peak = 0;
      let maxDd = 0;
      sorted.forEach((t, k) => {
        const liquidated = t.maePct * leverage >= 1;
        if (liquidated) liq++;
        // Liquidation: Verlust der isolierten Margin ⇒ −1R × L als Näherung des Totalverlusts
        const r = liquidated ? -1 * leverage : schemaRof(t, tpSchema) * leverage;
        muNum += weights[k]! * r;
        cum += r;
        peak = Math.max(peak, cum);
        maxDd = Math.max(maxDd, peak - cum);
      });

      const muWeighted = muNum / weightSum;
      const liquidationRate = liq / sorted.length;
      // DD-Floor, damit verlustfreie Serien nicht durch 0 teilen (dokumentierte Konvention)
      const rapsScore = muWeighted / Math.max(maxDd, 0.5);
      grid.push({
        leverage,
        tpSchema,
        muWeighted,
        maxDrawdownR: maxDd,
        rapsScore,
        liquidationRate,
        excluded: liquidationRate > maxLiq,
      });
    }
  }

  const eligible = grid.filter((g) => !g.excluded && trades.length > 0);
  const best = eligible.length > 0 ? eligible.reduce((a, b) => (b.rapsScore > a.rapsScore ? b : a)) : null;

  return {
    grid,
    best,
    tradeCount: trades.length,
    isLowSampleSize: trades.length < minTrades,
    lambdaTimeDecay: lambda,
  };
}

/** Deterministische, ehrliche Begründung (13_ §6 causality_explanation) — kein LLM-Text. */
export function explainRapsChoice(res: RapsResult, clusterKey: string): string {
  if (!res.best) return `${clusterKey}: keine belastbare Empfehlung (keine bzw. nur liquidierende Kombinationen).`;
  const b = res.best;
  const sample = res.isLowSampleSize ? ` ACHTUNG: nur ${res.tradeCount} Trades (< Mindeststichprobe) — unsicher.` : '';
  return (
    `${clusterKey}: Hebel ${b.leverage}× mit TP-Schema ${b.tpSchema} maximiert RAPS ` +
    `(${b.rapsScore.toFixed(3)} = zeitgew. μ ${b.muWeighted.toFixed(3)}R / DD ${b.maxDrawdownR.toFixed(2)}R) ` +
    `bei Liquidations-Quote ${(b.liquidationRate * 100).toFixed(1)} %.${sample}`
  );
}
