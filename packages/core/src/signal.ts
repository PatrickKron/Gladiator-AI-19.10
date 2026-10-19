import { z } from 'zod';
import { signalIntelligenceSchema } from './intelligence.js';

/**
 * Kanonisches Signal-Datenmodell — die EINE Wahrheit für alle Signal-Quellen.
 * Spezifikation: GLADIATOR_V2_BLUEPRINT/04_ZIELARCHITEKTUR.md §5.
 */

export const signalSourceSchema = z.enum(['engine', 'pine', 'instruction', 'manual', 'sub_agent']);
export const assetClassSchema = z.enum(['crypto', 'stock', 'etf', 'forex', 'commodity', 'index']);
export const venueTypeSchema = z.enum(['cex', 'dex']);
export const directionSchema = z.enum(['long', 'short']);
export const setupTypeSchema = z.enum(['scalp', 'swing', 'position']);
export const riskClassSchema = z.enum(['low', 'medium', 'high']);
export const tradingSessionSchema = z.enum(['asia', 'london', 'overlap', 'newyork', 'off']);
export const signalStatusSchema = z.enum(['new', 'confirmed', 'rejected', 'expired', 'filled', 'closed']);
// Hinweis: kein tier-Feld — keine Free/Pro/VIP-Stufen (Entscheidung 2026-07-02).

export const agentVerdictSchema = z.object({
  agent: z.string().min(1),
  vote: z.enum(['confirm', 'reject', 'caution']),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  refs: z.array(z.string()).default([]),
});

/**
 * Reentry-Plan (05_ §9) — EIN flaches Format (Alt-Bug: flach vs. verschachtelt).
 * Zusatzfelder optional: Preis-Zone, Limit/Generation der „zweiten Chance"
 * und die Herkunft (parent/root) eines Reentry-Signals.
 */
export const reentrySchema = z.object({
  enabled: z.boolean(),
  minPullbackPct: z.number(),
  maxPullbackPct: z.number(),
  zoneLow: z.number().positive().optional(),
  zoneHigh: z.number().positive().optional(),
  maxReentries: z.number().int().min(0).optional(),
  generation: z.number().int().min(0).optional(),
  parentSignalId: z.string().min(1).optional(),
  rootSignalId: z.string().min(1).optional(),
});

/** Sichtbarer Hebel-Vorschlag — wird NIE automatisch angewendet (Mensch im Loop). */
export const leverageUpgradeSuggestionSchema = z.object({
  suggested: z.number().positive(),
  from: z.number().positive(),
  movePct: z.number(),
  reason: z.string(),
  at: z.string().datetime({ offset: true }),
  positionId: z.string().min(1),
  price: z.number().positive(),
});

export const leverageUpgradeSchema = z.object({
  triggerPct: z.number().positive(),
  maxLeverage: z.number().positive(),
  /** Hebel-Faktor je Setup-Typ (05_ §9: scalp ×2, swing ×1,5, position ×5). */
  multiplier: z.number().positive().optional(),
  suggestion: leverageUpgradeSuggestionSchema.optional(),
});

export const signalSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
    source: signalSourceSchema,
    strategyId: z.string().min(1),
    strategyVersionId: z.string().uuid().optional(),
    symbol: z.string().min(1),
    /** Multi-TF-Ergänzung zum 04_-Modell: auf welcher Timeframe das Setup entstand. */
    timeframe: z.enum(['15m', '1h', '4h', '1d']),
    assetClass: assetClassSchema,
    venueType: venueTypeSchema,
    direction: directionSchema,
    setupType: setupTypeSchema,
    entry: z.number().positive(),
    stopLoss: z.number().positive(),
    takeProfits: z.array(z.number().positive()).min(1),
    /** Optionaler Trailing-Stop-Abstand in % (Strategie-Exit; Backtest und Live nutzen dieselbe Logik). */
    trailPct: z.number().min(0.1).max(50).optional(),
    leverageSuggested: z.number().min(1),
    score: z.number().min(0).max(10),
    riskClass: riskClassSchema,
    confluence: z.array(z.string()),
    session: tradingSessionSchema,
    reentry: reentrySchema.optional(),
    leverageUpgrade: leverageUpgradeSchema.optional(),
    agentReview: z.array(agentVerdictSchema).optional(),
    /**
     * Additive KI-Trading-Intelligence-Schicht (CPI/COT/Buffett/Hedge/…).
     * Optional — ohne verbundene Datenquellen bleibt sie undefiniert.
     * Siehe intelligence.ts / „/goal Ergänzung zu Gladiator AI" §11.
     */
    intelligence: signalIntelligenceSchema.optional(),
    status: signalStatusSchema,
  })
  .superRefine((s, ctx) => {
    // SL muss auf der richtigen Seite des Entry liegen; TPs in Trade-Richtung.
    if (s.direction === 'long') {
      if (s.stopLoss >= s.entry) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stopLoss'], message: 'Long: stopLoss muss unter entry liegen' });
      }
      if (s.takeProfits.some((tp) => tp <= s.entry)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['takeProfits'], message: 'Long: alle takeProfits müssen über entry liegen' });
      }
    } else {
      if (s.stopLoss <= s.entry) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stopLoss'], message: 'Short: stopLoss muss über entry liegen' });
      }
      if (s.takeProfits.some((tp) => tp >= s.entry)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['takeProfits'], message: 'Short: alle takeProfits müssen unter entry liegen' });
      }
    }
  });

export type Signal = z.infer<typeof signalSchema>;
export type AgentVerdict = z.infer<typeof agentVerdictSchema>;
export type SignalSource = z.infer<typeof signalSourceSchema>;
export type AssetClass = z.infer<typeof assetClassSchema>;
export type VenueType = z.infer<typeof venueTypeSchema>;
export type Direction = z.infer<typeof directionSchema>;
export type SetupType = z.infer<typeof setupTypeSchema>;
export type RiskClass = z.infer<typeof riskClassSchema>;
export type TradingSession = z.infer<typeof tradingSessionSchema>;
export type SignalStatus = z.infer<typeof signalStatusSchema>;
