import type { BuffettStatus, CotStatus, CpiStatus, HedgeMode, MarketRegimeName } from './intelligence.js';

/**
 * Post-Trade Learning Agent („/goal Ergänzung" §4/§13.8).
 *
 * Bewertet ABGESCHLOSSENE Trades: Trefferqualität, Fehlerquellen, Score-
 * Validität, ableitbare Lehren. REIN und deterministisch — die Zahlen kommen
 * aus dem echten geschlossenen Trade (netto-PnL, R-Multiple), der Kontext aus
 * dem Signalobjekt zum Zeitpunkt der Entscheidung. Keine Erfindung: fehlt ein
 * Kontextfeld, wird die zugehörige Fehlerquelle schlicht nicht behauptet.
 *
 * Die Lehren fließen (durch den Aufrufer) in die Score-Kalibrierung/Historie
 * zurück, damit die Entscheidungsqualität messbar wird (PDF §15).
 */

export type HitQuality = 'excellent' | 'good' | 'acceptable' | 'poor' | 'loss';

export type ClosedTrade = {
  direction: 'long' | 'short';
  /** Netto-PnL nach Gebühren/Slippage/Funding. */
  netPnl: number;
  /** Ergebnis in R (Vielfaches des Anfangsrisikos); null wenn unbekannt. */
  rMultiple: number | null;
  /** 'paper' | 'live' (nur zur Kennzeichnung). */
  mode: string;
};

export type TradeContext = {
  /** Ursprünglicher Signal-Score 0..10 (null = unbekannt). */
  originalScore: number | null;
  cpiStatus?: CpiStatus;
  /** War die COT-Positionierung überlaufen IN Trade-Richtung? */
  cotWithTrade?: boolean;
  cotStatus?: CotStatus;
  buffettStatus?: BuffettStatus;
  hedgeMode?: HedgeMode;
  regime?: MarketRegimeName | null;
};

export type PostTradeReview = {
  hitQuality: HitQuality;
  /** 0..1 — war der ursprüngliche Score im Nachhinein gerechtfertigt? */
  scoreValidity: number;
  /** Stabile Fehlerquellen-Schlüssel (i18n-übersetzbar). */
  errorSources: string[];
  /** Stabile Lehren-Schlüssel. */
  lessons: string[];
};

export function classifyHitQuality(rMultiple: number | null, netPnl: number): HitQuality {
  if (rMultiple === null) return netPnl > 0 ? 'acceptable' : 'loss';
  if (rMultiple >= 2) return 'excellent';
  if (rMultiple >= 1) return 'good';
  if (rMultiple > 0) return 'acceptable';
  if (rMultiple > -1) return 'poor';
  return 'loss';
}

/**
 * Score-Validität: 1 − |normierter Score − Ergebnisqualität|. Ein hoher Score
 * bei Gewinn (oder niedriger Score bei Verlust) ist „valide"; ein hoher Score
 * bei Verlust deckt Überkonfidenz auf.
 */
export function scoreValidity(originalScore: number | null, rMultiple: number | null, netPnl: number): number {
  if (originalScore === null) return 0.5;
  const norm = Math.max(0, Math.min(1, originalScore / 10));
  // Ergebnisqualität 0..1 aus R (tanh-gesättigt) bzw. PnL-Vorzeichen.
  const outcome = rMultiple !== null ? (Math.tanh(rMultiple) + 1) / 2 : netPnl > 0 ? 0.65 : 0.35;
  return Math.max(0, Math.min(1, 1 - Math.abs(norm - outcome)));
}

export function evaluateTrade(trade: ClosedTrade, ctx: TradeContext): PostTradeReview {
  const hitQuality = classifyHitQuality(trade.rMultiple, trade.netPnl);
  const isLoss = hitQuality === 'loss' || hitQuality === 'poor';
  const isWin = hitQuality === 'excellent' || hitQuality === 'good';
  const errorSources: string[] = [];
  const lessons: string[] = [];

  if (isLoss) {
    if (ctx.cpiStatus === 'release_window' || ctx.cpiStatus === 'pre_event') {
      errorSources.push('traded_into_cpi_window');
      lessons.push('respect_cpi_window');
    }
    if (ctx.cotWithTrade) {
      errorSources.push('against_cot_extreme');
      lessons.push('weight_cot_contrarian');
    }
    if (ctx.buffettStatus === 'extreme' && trade.direction === 'long') {
      errorSources.push('long_into_overvaluation');
      lessons.push('reduce_size_high_valuation');
    }
    if ((ctx.regime === 'high_vol' || ctx.regime === 'crisis') && ctx.hedgeMode === 'no_hedge') {
      errorSources.push('no_hedge_in_volatile_regime');
      lessons.push('hedge_in_volatile_regime');
    }
    if (ctx.originalScore !== null && ctx.originalScore >= 7) {
      errorSources.push('score_overconfident');
      lessons.push('recalibrate_high_scores');
    }
    if (errorSources.length === 0) {
      // Verlust ohne erkennbaren systematischen Fehler = akzeptierter Risiko-Ausgang.
      errorSources.push('within_expected_variance');
      lessons.push('accept_stop_as_designed');
    }
  } else if (isWin) {
    lessons.push('setup_pattern_confirmed');
    if (ctx.hedgeMode && ctx.hedgeMode !== 'no_hedge') lessons.push('hedge_did_not_block_winner');
  } else {
    // acceptable
    lessons.push('marginal_result_review_rr');
  }

  return {
    hitQuality,
    scoreValidity: scoreValidity(ctx.originalScore, trade.rMultiple, trade.netPnl),
    errorSources,
    lessons,
  };
}

export type PostTradeAggregate = {
  count: number;
  wins: number;
  losses: number;
  winRate: number;
  avgRMultiple: number | null;
  avgScoreValidity: number;
  /** Häufigste Fehlerquellen (Schlüssel → Anzahl), absteigend. */
  topErrorSources: { key: string; count: number }[];
};

/** Aggregiert Reviews (+ zugehörige R-Multiples) zu Lern-Kennzahlen. */
export function aggregatePostTrade(reviews: { review: PostTradeReview; rMultiple: number | null }[]): PostTradeAggregate {
  const count = reviews.length;
  if (count === 0) {
    return { count: 0, wins: 0, losses: 0, winRate: 0, avgRMultiple: null, avgScoreValidity: 0, topErrorSources: [] };
  }
  let wins = 0;
  let losses = 0;
  let rSum = 0;
  let rCount = 0;
  let validitySum = 0;
  const errorCounts = new Map<string, number>();
  for (const { review, rMultiple } of reviews) {
    if (review.hitQuality === 'excellent' || review.hitQuality === 'good') wins += 1;
    if (review.hitQuality === 'loss' || review.hitQuality === 'poor') losses += 1;
    if (rMultiple !== null) {
      rSum += rMultiple;
      rCount += 1;
    }
    validitySum += review.scoreValidity;
    for (const e of review.errorSources) errorCounts.set(e, (errorCounts.get(e) ?? 0) + 1);
  }
  const topErrorSources = [...errorCounts.entries()]
    .map(([key, c]) => ({ key, count: c }))
    .sort((a, b) => b.count - a.count);
  return {
    count,
    wins,
    losses,
    winRate: wins / count,
    avgRMultiple: rCount > 0 ? rSum / rCount : null,
    avgScoreValidity: validitySum / count,
    topErrorSources,
  };
}
