ALTER TABLE "signals" ADD COLUMN "ema_regime" text DEFAULT 'above' NOT NULL;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "market_phase" text DEFAULT 'bull' NOT NULL;