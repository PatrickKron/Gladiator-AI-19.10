import type { AgentVerdict } from './types.js';

/**
 * KI-Intelligence-Agenten („/goal Ergänzung zu Gladiator AI"):
 *   - Institutional & Valuation Agent (§4): COT-Positionierung + Buffett-Bewertung.
 *   - Hedge Agent (§10): entscheidet DETERMINISTISCH zwischen 6 Hedge-Modi.
 *
 * Alle Funktionen sind REIN (kein LLM, kein Zufall, kein Fake) und voll
 * getestet. Die Datengrundlage (CPI/COT/Buffett/Regime/Shadow) reicht der
 * Aufrufer (jobs/review) aus den echten market-data-Quellen herein; fehlt eine
 * Quelle, ist ihr Status neutral/not_applicable und der Agent sagt das ehrlich.
 *
 * Harte Grenze (Eiserne Regel #2 / PDF §14): diese Agenten BEWERTEN und
 * EMPFEHLEN. Positionsgröße, Verlustgrenzen und Kill-Switch bleiben allein
 * bei der deterministischen Risk-Engine.
 */

// Lokale Literal-Typen — strukturell identisch zu @gladiator/core (bewusst
// keine Paket-Abhängigkeit agents→core, um den Dependency-Graph flach zu halten).
export type MarketRegimeName = 'bull' | 'bear' | 'sideways' | 'high_vol' | 'crisis';
export type CpiStatus = 'none' | 'pre_event' | 'release_window' | 'post_event' | 'confirmed_reaction';
export type CotStatus = 'not_applicable' | 'neutral' | 'crowded_long' | 'crowded_short' | 'contrarian_alert';
export type BuffettStatus = 'not_applicable' | 'neutral' | 'elevated' | 'extreme';
export type HedgeMode = 'no_hedge' | 'reduce' | 'partial_hedge' | 'full_hedge' | 'flat' | 'flip_warning';
export type PositionSizeMode = 'normal' | 'reduced' | 'defensive' | 'none';
export type RiskClassExtended = 'low' | 'medium' | 'high' | 'extreme';
export type FinalDecision = 'signal' | 'wait' | 'hedge' | 'no_trade';

export type IntelligenceContext = {
  direction: 'long' | 'short';
  /** Basis-Risikoklasse des Signals (low|medium|high). */
  baseRiskClass: 'low' | 'medium' | 'high';
  regime: MarketRegimeName | null;
  cpiStatus: CpiStatus;
  cotStatus: CotStatus;
  /** Vorzeichen zeigt die Crowd-Richtung (netto Non-Commercial / OI). */
  cotNetRatio: number;
  buffettStatus: BuffettStatus;
  /** ShadowGPT-Manipulationswarnung ('' = keine). */
  shadowWarning: string;
  /** Aktives No-Trade-Fenster (High-Impact-Event). */
  noTradeActive: boolean;
};

// ── Institutional & Valuation Agent (COT + Buffett) ─────────────────────────

/**
 * Verarbeitet institutionelle Positionierung (COT) und Bewertung (Buffett) zu
 * einem transparenten Urteil. COT ist ein struktureller Bestätigungs-/Warnfilter,
 * Buffett ein langfristiger Bewertungsfilter — beide dürfen abschwächen, nie
 * allein ein Signal auslösen (PDF §6/§7/§14).
 */
export function reviewInstitutional(ctx: IntelligenceContext): AgentVerdict {
  const notes: string[] = [];
  let vote: AgentVerdict['vote'] = 'confirm';

  // COT: überlaufene Positionierung IN Trade-Richtung → Warnung (Kontraindikator).
  const crowdWithTrade =
    (ctx.direction === 'long' && (ctx.cotStatus === 'crowded_long' || (ctx.cotStatus === 'contrarian_alert' && ctx.cotNetRatio > 0))) ||
    (ctx.direction === 'short' && (ctx.cotStatus === 'crowded_short' || (ctx.cotStatus === 'contrarian_alert' && ctx.cotNetRatio < 0)));
  const crowdAgainstTrade =
    (ctx.direction === 'long' && (ctx.cotStatus === 'crowded_short' || (ctx.cotStatus === 'contrarian_alert' && ctx.cotNetRatio < 0))) ||
    (ctx.direction === 'short' && (ctx.cotStatus === 'crowded_long' || (ctx.cotStatus === 'contrarian_alert' && ctx.cotNetRatio > 0)));

  if (ctx.cotStatus === 'not_applicable') {
    notes.push('COT nicht anwendbar (kein passender Futures-Report).');
  } else if (crowdWithTrade) {
    vote = ctx.cotStatus === 'contrarian_alert' ? 'reject' : 'caution';
    notes.push('COT überlaufen in Trade-Richtung — Kontraindikator, Risikoabschlag.');
  } else if (crowdAgainstTrade) {
    notes.push('COT konträr positioniert — strukturell im Rücken des Trades.');
  } else {
    notes.push('COT neutral.');
  }

  // Buffett: hohe Bewertung → Longs konservativer.
  if (ctx.buffettStatus === 'extreme') {
    if (ctx.direction === 'long') vote = vote === 'reject' ? 'reject' : 'caution';
    notes.push('Buffett-Indikator EXTREM (Bewertungsrisiko langfristig hoch).');
  } else if (ctx.buffettStatus === 'elevated') {
    if (ctx.direction === 'long' && vote === 'confirm') vote = 'caution';
    notes.push('Buffett-Indikator erhöht.');
  } else if (ctx.buffettStatus !== 'not_applicable') {
    notes.push('Bewertung im Rahmen.');
  }

  const confidence = vote === 'reject' ? 0.7 : vote === 'caution' ? 0.55 : 0.6;
  return {
    agent: 'institutional',
    vote,
    confidence,
    reason: notes.join(' '),
    refs: { cotStatus: ctx.cotStatus, cotNetRatio: ctx.cotNetRatio, buffettStatus: ctx.buffettStatus },
  };
}

// ── Hedge Agent (6 Modi) ─────────────────────────────────────────────────────

export type HedgeDecision = {
  mode: HedgeMode;
  reason: string;
  /** Ausgelöste Risiko-Flags (stabile Schlüssel, transparent im UI). */
  triggers: string[];
};

/**
 * Entscheidet den Hedge-Modus deterministisch nach der Prioritätsordnung des
 * PDF §10 (most protective first). Ein Hedge ist nur sinnvoll, wenn er ein
 * KONKRETES Risiko reduziert; sonst no_hedge.
 */
export function decideHedge(ctx: IntelligenceContext): HedgeDecision {
  const triggers: string[] = [];
  const crowdWithTrade =
    (ctx.direction === 'long' && (ctx.cotStatus === 'crowded_long' || (ctx.cotStatus === 'contrarian_alert' && ctx.cotNetRatio > 0))) ||
    (ctx.direction === 'short' && (ctx.cotStatus === 'crowded_short' || (ctx.cotStatus === 'contrarian_alert' && ctx.cotNetRatio < 0)));
  const shadow = ctx.shadowWarning.trim().length > 0;

  // Risiko-Flags sammeln (auch wenn ein früherer Modus greift — für die Begründung).
  if (ctx.regime === 'crisis') triggers.push('regime_crisis');
  if (ctx.regime === 'high_vol') triggers.push('regime_high_vol');
  if (ctx.cpiStatus === 'release_window') triggers.push('cpi_release_window');
  if (ctx.cpiStatus === 'pre_event') triggers.push('cpi_pre_event');
  if (ctx.noTradeActive) triggers.push('no_trade_window');
  if (shadow) triggers.push('shadow_warning');
  if (ctx.buffettStatus === 'extreme') triggers.push('buffett_extreme');
  if (ctx.buffettStatus === 'elevated') triggers.push('buffett_elevated');
  if (ctx.cotStatus === 'contrarian_alert' && crowdWithTrade) triggers.push('cot_contrarian_alert');
  if (crowdWithTrade && ctx.cotStatus !== 'contrarian_alert') triggers.push('cot_crowded_with_trade');
  if (ctx.baseRiskClass === 'high') triggers.push('risk_high');

  const decide = (mode: HedgeMode, reason: string): HedgeDecision => ({ mode, reason, triggers });

  // 4. FLAT — bester Schutz bei akutem Event/Krise.
  if (ctx.regime === 'crisis') return decide('flat', 'Krisen-Regime — flat ist der beste Schutz.');
  if (ctx.cpiStatus === 'release_window') return decide('flat', 'CPI-Release-Fenster — keine blinde Reaktion, flat/abwarten.');
  if (ctx.noTradeActive) return decide('flat', 'Aktives No-Trade-Fenster (High-Impact-Event).');

  // 5. FLIP WARNING — Crowd am Extrem IN Trade-Richtung, These reversal-gefährdet.
  if (ctx.cotStatus === 'contrarian_alert' && crowdWithTrade) {
    return decide('flip_warning', 'COT-Kontra-Alarm: Positionierung extrem in Trade-Richtung — These reversal-gefährdet, erst Bestätigung abwarten.');
  }

  // 3. FULL HEDGE — mehrere schwere Risiken gleichzeitig (fortgeschritten, selten).
  const severe = [shadow, ctx.cpiStatus === 'pre_event', ctx.regime === 'high_vol', ctx.buffettStatus === 'extreme', ctx.baseRiskClass === 'high'].filter(Boolean).length;
  if (severe >= 3) return decide('full_hedge', 'Mehrere schwere Risiken gleichzeitig — kurzfristige Neutralisierung sinnvoll.');

  // 2. PARTIAL HEDGE — konkretes Einzelrisiko (CPI-Vorlauf, Manipulation, Bewertung extrem).
  if (ctx.cpiStatus === 'pre_event') return decide('partial_hedge', 'CPI-Vorlauf — Teilabsicherung/Reduce statt aggressivem Hebeltrade.');
  if (shadow) return decide('partial_hedge', `Manipulationsrisiko: ${ctx.shadowWarning}`);
  if (ctx.buffettStatus === 'extreme' && ctx.direction === 'long') return decide('partial_hedge', 'Bewertung extrem — Long teilabsichern.');

  // 1. REDUCE — erhöhtes, aber nicht akutes Risiko.
  if (ctx.regime === 'high_vol') return decide('reduce', 'Hohe Volatilität — Positionsgröße reduzieren.');
  if (crowdWithTrade) return decide('reduce', 'COT überlaufen in Trade-Richtung — Positionsgröße reduzieren.');
  if (ctx.buffettStatus === 'elevated' && ctx.direction === 'long') return decide('reduce', 'Bewertung erhöht — Long-Größe reduzieren.');
  if (ctx.baseRiskClass === 'high') return decide('reduce', 'Hohe Risikoklasse — Positionsgröße reduzieren.');

  // 0. NO HEDGE — Stop-Loss und Positionsgröße reichen.
  return decide('no_hedge', 'Kein konkretes Zusatzrisiko — Stop-Loss und Positionsgröße genügen.');
}

/** Hedge-Entscheidung als transparentes AgentVerdict für den Schwarm. */
export function reviewHedge(decision: HedgeDecision): AgentVerdict {
  // Hedge-Empfehlung ist Vorsicht, kein hartes reject (das Risk-Gate bleibt separat).
  const vote: AgentVerdict['vote'] =
    decision.mode === 'flat' ? 'reject' : decision.mode === 'no_hedge' ? 'confirm' : 'caution';
  const confidence = decision.mode === 'flat' ? 0.8 : decision.mode === 'no_hedge' ? 0.6 : 0.65;
  return {
    agent: 'hedge',
    vote,
    confidence,
    reason: `Hedge-Modus ${decision.mode}: ${decision.reason}`,
    refs: { mode: decision.mode, triggers: decision.triggers },
  };
}

// ── Ableitungen für das erweiterte Signalobjekt (PDF §11) ────────────────────

/** Positionsgrößen-Modus aus Hedge-Modus + Risikoklasse. */
export function positionSizeModeFor(mode: HedgeMode, riskClass: RiskClassExtended): PositionSizeMode {
  if (mode === 'flat') return 'none';
  if (mode === 'full_hedge') return 'defensive';
  if (mode === 'partial_hedge' || mode === 'reduce') return 'reduced';
  if (mode === 'flip_warning') return 'none';
  if (riskClass === 'extreme') return 'defensive';
  if (riskClass === 'high') return 'reduced';
  return 'normal';
}

/** Finale Entscheidungskategorie des Meta-Orchestrators. */
export function finalDecisionFor(mode: HedgeMode, portfolioVote: AgentVerdict['vote']): FinalDecision {
  if (mode === 'flat') return 'no_trade';
  if (mode === 'flip_warning') return 'wait';
  if (mode === 'full_hedge' || mode === 'partial_hedge') return 'hedge';
  if (portfolioVote === 'reject') return 'no_trade';
  if (portfolioVote === 'caution') return 'wait';
  return 'signal';
}

/** Eskaliert die Basis-Risikoklasse anhand der Intelligence-Flags (bis `extreme`). */
export function escalateRiskClass(base: 'low' | 'medium' | 'high', ctx: IntelligenceContext): RiskClassExtended {
  const order: RiskClassExtended[] = ['low', 'medium', 'high', 'extreme'];
  let idx = order.indexOf(base);
  if (ctx.regime === 'crisis') idx = order.length - 1;
  if (ctx.regime === 'high_vol') idx += 1;
  if (ctx.cpiStatus === 'release_window') idx += 1;
  if (ctx.buffettStatus === 'extreme') idx += 1;
  if (ctx.cotStatus === 'contrarian_alert') idx += 1;
  if (ctx.shadowWarning.trim().length > 0) idx += 1;
  return order[Math.max(0, Math.min(order.length - 1, idx))]!;
}
