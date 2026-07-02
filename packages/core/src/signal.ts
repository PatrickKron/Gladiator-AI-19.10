import { z } from 'zod';

/**
 * Kanonisches Signal-Datenmodell — die EINE Wahrheit für alle Signal-Quellen.
 * Spezifikation: GLADIATOR_V2_BLUEPRINT/04_ZIELARCHITEKTUR.md §5.
 */

export const signalSourceSchema = z.enum(['engine', 'pine', 'instruction', 'manual']);
export const assetClassSchema = z.enum(['crypto', 'stock', 'etf', 'forex', 'commodity', 'index']);
export const venueTypeSchema = z.enum(['cex', 'dex']);
export const directionSchema = z.enum(['long', 'short']);
export const setupTypeSchema = z.enum(['scalp', 'swing', 'position']);
export const riskClassSchema = z.enum(['low', 'medium', 'high']);
export const tradingSessionSchema = z.enum(['asia', 'london', 'newyork', 'off']);
export const signalStatusSchema = z.enum(['new', 'confirmed', 'rejected', 'expired', 'filled', 'closed']);
// Hinweis: kein tier-Feld — keine Free/Pro/VIP-Stufen (Entscheidung 2026-07-02).

export const agentVerdictSchema = z.object({
  agent: z.string().min(1),
  vote: z.enum(['confirm', 'reject', 'caution']),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  refs: z.array(z.string()).default([]),
});

export const reentrySchema = z.object({
  enabled: z.boolean(),
  minPullbackPct: z.number(),
  maxPullbackPct: z.number(),
});

export const leverageUpgradeSchema = z.object({
  triggerPct: z.number().positive(),
  maxLeverage: z.number().positive(),
});

export const signalSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
    source: signalSourceSchema,
    strategyId: z.string().min(1),
    strategyVersionId: z.string().uuid().optional(),
    symbol: z.string().min(1),
    assetClass: assetClassSchema,
    venueType: venueTypeSchema,
    direction: directionSchema,
    setupType: setupTypeSchema,
    entry: z.number().positive(),
    stopLoss: z.number().positive(),
    takeProfits: z.array(z.number().positive()).min(1),
    leverageSuggested: z.number().min(1),
    score: z.number().min(0).max(10),
    riskClass: riskClassSchema,
    confluence: z.array(z.string()),
    session: tradingSessionSchema,
    reentry: reentrySchema.optional(),
    leverageUpgrade: leverageUpgradeSchema.optional(),
    agentReview: z.array(agentVerdictSchema).optional(),
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
