-- Strategie-Workshop (Session 2): workshop_sessions / workshop_messages / workshop_backtests.
-- HINWEIS: drizzle-kit hatte zusätzlich market_regimes/model_versions/performance_snapshots
-- emittiert, weil die hand-geschriebene 0014 keinen Snapshot hat — diese Tabellen existieren
-- aber bereits durch 0014 (IF NOT EXISTS) und wurden hier entfernt. Der 0015-Snapshot
-- enthält sie, damit künftige generates sie nicht erneut emittieren.
-- Alles idempotent (Regel: additiv, CREATE TABLE IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS "workshop_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"pine_source" text,
	"analysis" jsonb,
	"draft_dsl" jsonb,
	"instructions" text,
	"strategy_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workshop_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"proposed_dsl" jsonb,
	"cost_usd" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workshop_backtests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"label" text,
	"dsl" jsonb NOT NULL,
	"symbol" text NOT NULL,
	"timeframe" text NOT NULL,
	"from_ts" timestamp with time zone NOT NULL,
	"to_ts" timestamp with time zone NOT NULL,
	"risk_pct_per_trade" numeric DEFAULT '1' NOT NULL,
	"cost_model" jsonb NOT NULL,
	"candles" integer,
	"metrics" jsonb,
	"equity_curve" jsonb,
	"trades" jsonb,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "workshop_sessions" ADD CONSTRAINT "workshop_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "workshop_sessions" ADD CONSTRAINT "workshop_sessions_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "workshop_messages" ADD CONSTRAINT "workshop_messages_session_id_workshop_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workshop_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "workshop_backtests" ADD CONSTRAINT "workshop_backtests_session_id_workshop_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workshop_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workshop_sessions_user_idx" ON "workshop_sessions" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workshop_messages_session_idx" ON "workshop_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workshop_backtests_session_idx" ON "workshop_backtests" USING btree ("session_id","created_at");
