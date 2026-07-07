CREATE TABLE IF NOT EXISTS "market_regimes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" text NOT NULL,
	"timeframe" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"regime" text NOT NULL,
	"confidence" numeric NOT NULL,
	"components" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" integer,
	"version" integer NOT NULL,
	"metrics" jsonb NOT NULL,
	"comparison" jsonb,
	"promoted" boolean DEFAULT false NOT NULL,
	"promoted_at" timestamp with time zone,
	"promoted_by" text,
	"sample_count" integer,
	"train_size" integer,
	"test_size" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "performance_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid,
	"snapshot_type" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"equity_curve" jsonb,
	"metrics" jsonb NOT NULL,
	"regime_breakdown" jsonb,
	"benchmark_return" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_versions" ADD CONSTRAINT "model_versions_model_id_ml_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ml_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_snapshots" ADD CONSTRAINT "performance_snapshots_agent_id_rl_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."rl_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "market_regimes_symbol_tf_ts_idx" ON "market_regimes" USING btree ("symbol","timeframe","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "market_regimes_regime_idx" ON "market_regimes" USING btree ("regime");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_versions_model_idx" ON "model_versions" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_versions_promoted_idx" ON "model_versions" USING btree ("promoted");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "perf_snapshots_agent_idx" ON "performance_snapshots" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "perf_snapshots_type_period_idx" ON "performance_snapshots" USING btree ("snapshot_type","period_start");
