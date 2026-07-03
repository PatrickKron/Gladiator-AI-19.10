ALTER TYPE "public"."trading_session" ADD VALUE 'overlap' BEFORE 'newyork';--> statement-breakpoint
CREATE TABLE "risk_gates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'block' NOT NULL,
	"direction" "direction",
	"ema_regime" text,
	"session" "trading_session",
	"market_phase" text,
	"symbol" text,
	"timeframe" text,
	"evidence" jsonb NOT NULL,
	"reason" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'lab-calibration' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_by" uuid
);
--> statement-breakpoint
ALTER TABLE "risk_gates" ADD CONSTRAINT "risk_gates_disabled_by_users_id_fk" FOREIGN KEY ("disabled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "risk_gates_active_idx" ON "risk_gates" USING btree ("is_active");