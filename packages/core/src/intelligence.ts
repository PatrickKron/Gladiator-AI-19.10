import { z } from 'zod';

/**
 * KI-Trading-Intelligence-Layer — additive Ergänzung zum kanonischen Signal
 * (siehe „/goal Ergänzung zu Gladiator AI", §11 Standardisiertes Signalobjekt).
 *
 * WICHTIG (Eiserne Regel #6 „Eine Wahrheit"): Dies ERSETZT das kanonische
 * `signalSchema` NICHT. Es beschreibt die zusätzliche, erklärbare Analyse-
 * Schicht, die der Agenten-Schwarm aus Makro (CPI), institutioneller
 * Positionierung (COT), Bewertung (Buffett), Liquiditäts-/Manipulationsrisiken
 * und Post-Trade-Learning ableitet. Alle Felder sind optional — ohne
 * verbundene Datenquelle bleibt die Schicht schlicht leer (ehrlich „nicht
 * verbunden" statt Fake).
 *
 * BTC/USDT ist nur der Referenzmarkt; die Struktur ist multi-asset-fähig.
 */

/** Regime-Namen der echten Market-Regime-Engine (@gladiator/ml). */
export const marketRegimeSchema = z.enum(['bull', 'bear', 'sideways', 'high_vol', 'crisis']);

/** Erweiterte Risikoklasse — additiv um `extreme` erweitert (PDF §11). */
export const riskClassExtendedSchema = z.enum(['low', 'medium', 'high', 'extreme']);

/** Positionsgrößen-Modus (PDF §11). */
export const positionSizeModeSchema = z.enum(['normal', 'reduced', 'defensive', 'none']);

/** Hedge-Modi 0..5 (PDF §10 Hedging- und No-Trade-Logik). */
export const hedgeModeSchema = z.enum(['no_hedge', 'reduce', 'partial_hedge', 'full_hedge', 'flat', 'flip_warning']);

/** CPI-Event-Regime (PDF §5). */
export const cpiStatusSchema = z.enum(['none', 'pre_event', 'release_window', 'post_event', 'confirmed_reaction']);

/** COT-Positionierungs-Status (PDF §6). */
export const cotStatusSchema = z.enum(['not_applicable', 'neutral', 'crowded_long', 'crowded_short', 'contrarian_alert']);

/** Warren-Buffett-Bewertungs-Status (PDF §7). */
export const buffettStatusSchema = z.enum(['not_applicable', 'neutral', 'elevated', 'extreme']);

/** Finale Entscheidungs-Kategorie des Meta-Orchestrators (PDF §11). */
export const finalDecisionSchema = z.enum(['signal', 'wait', 'hedge', 'no_trade']);

/**
 * Score-Komponenten (PDF §11) — jeweils 0..1, transparent aufgeschlüsselt.
 * Kein Wert wird erfunden: fehlt eine Datenquelle, bleibt die Komponente 0
 * und die Schicht markiert die Quelle als nicht verbunden.
 */
export const scoreComponentsSchema = z.object({
  technical: z.number().min(0).max(1),
  macroCpi: z.number().min(0).max(1),
  liquidityShadow: z.number().min(0).max(1),
  cotPositioning: z.number().min(0).max(1),
  valuationBuffett: z.number().min(0).max(1),
  riskReward: z.number().min(0).max(1),
});

/**
 * Standardisiertes Signal-Intelligence-Objekt (PDF §11) — app-kompatibel,
 * additiv am kanonischen Signal (`signalSchema.intelligence`).
 */
export const signalIntelligenceSchema = z.object({
  /** true = BTC/USDT ist Referenz-Beispielmarkt (PDF Kernsatz). */
  assetIsExample: z.boolean().default(false),
  marketRegime: marketRegimeSchema.nullable().default(null),
  scoreComponents: scoreComponentsSchema.optional(),
  riskClass: riskClassExtendedSchema.optional(),
  positionSizeMode: positionSizeModeSchema.optional(),
  hedgeMode: hedgeModeSchema.optional(),
  cpiStatus: cpiStatusSchema.default('none'),
  cotStatus: cotStatusSchema.default('not_applicable'),
  buffettStatus: buffettStatusSchema.default('not_applicable'),
  /** ShadowGPT-Manipulationswarnung (leer = keine). */
  shadowWarning: z.string().default(''),
  /** Project-Oracle-Makro-Zusammenfassung (leer = nicht verbunden). */
  oracleMacroSummary: z.string().default(''),
  /** Devil's-Advocate-Gegenargument (leer = keins). */
  devilsAdvocate: z.string().default(''),
  finalDecision: finalDecisionSchema.optional(),
  /** Menschenlesbare Begründung (i18n-frei; kann leer bleiben). */
  explanationForUser: z.string().default(''),
  /** ISO-8601 Gültigkeit; null = ohne Ablauf. */
  validUntil: z.string().datetime({ offset: true }).nullable().default(null),
  /** Nachkontrolle erforderlich (Post-Trade-Learning-Agent). */
  postTradeReviewRequired: z.boolean().default(true),
});

export type MarketRegimeName = z.infer<typeof marketRegimeSchema>;
export type RiskClassExtended = z.infer<typeof riskClassExtendedSchema>;
export type PositionSizeMode = z.infer<typeof positionSizeModeSchema>;
export type HedgeMode = z.infer<typeof hedgeModeSchema>;
export type CpiStatus = z.infer<typeof cpiStatusSchema>;
export type CotStatus = z.infer<typeof cotStatusSchema>;
export type BuffettStatus = z.infer<typeof buffettStatusSchema>;
export type FinalDecision = z.infer<typeof finalDecisionSchema>;
export type ScoreComponents = z.infer<typeof scoreComponentsSchema>;
export type SignalIntelligence = z.infer<typeof signalIntelligenceSchema>;
