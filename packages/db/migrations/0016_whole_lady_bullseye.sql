-- KI-Trading-Intelligence-Layer ("/goal Ergänzung zu Gladiator AI"):
-- cot_reports (COT/§6), valuation_indicators (Buffett/§7),
-- signal_intelligence (erweitertes Signalobjekt/§11), post_trade_reviews (§4).
-- Rein ADDITIV. Alles idempotent (CREATE TABLE IF NOT EXISTS + DO-$$-FK-Guards).
CREATE TABLE IF NOT EXISTS "cot_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_code" text NOT NULL,
	"market_name" text NOT NULL,
	"label" text NOT NULL,
	"report_date" timestamp with time zone NOT NULL,
	"open_interest" numeric NOT NULL,
	"noncomm_long" numeric NOT NULL,
	"noncomm_short" numeric NOT NULL,
	"comm_long" numeric NOT NULL,
	"comm_short" numeric NOT NULL,
	"source" text DEFAULT 'cftc' NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "post_trade_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"executed_trade_id" uuid NOT NULL,
	"signal_id" uuid,
	"hit_quality" text NOT NULL,
	"score_validity" numeric NOT NULL,
	"error_sources" jsonb NOT NULL,
	"lessons" jsonb NOT NULL,
	"r_multiple" numeric,
	"net_pnl" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signal_intelligence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"asset_is_example" boolean DEFAULT false NOT NULL,
	"market_regime" text,
	"score_components" jsonb,
	"risk_class" text,
	"position_size_mode" text,
	"hedge_mode" text,
	"cpi_status" text DEFAULT 'none' NOT NULL,
	"cot_status" text DEFAULT 'not_applicable' NOT NULL,
	"buffett_status" text DEFAULT 'not_applicable' NOT NULL,
	"shadow_warning" text DEFAULT '' NOT NULL,
	"oracle_macro_summary" text DEFAULT '' NOT NULL,
	"devils_advocate" text DEFAULT '' NOT NULL,
	"final_decision" text,
	"explanation_for_user" text DEFAULT '' NOT NULL,
	"valid_until" timestamp with time zone,
	"post_trade_review_required" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "valuation_indicators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"indicator" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"value" numeric NOT NULL,
	"numerator" numeric,
	"denominator" numeric,
	"source" text DEFAULT 'fred-public' NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "post_trade_reviews" ADD CONSTRAINT "post_trade_reviews_executed_trade_id_executed_trades_id_fk" FOREIGN KEY ("executed_trade_id") REFERENCES "public"."executed_trades"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "post_trade_reviews" ADD CONSTRAINT "post_trade_reviews_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "signal_intelligence" ADD CONSTRAINT "signal_intelligence_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cot_reports_market_date_idx" ON "cot_reports" USING btree ("market_code","report_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cot_reports_label_idx" ON "cot_reports" USING btree ("label","report_date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "post_trade_reviews_trade_idx" ON "post_trade_reviews" USING btree ("executed_trade_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "post_trade_reviews_created_idx" ON "post_trade_reviews" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "signal_intelligence_signal_idx" ON "signal_intelligence" USING btree ("signal_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "valuation_indicators_ind_ts_idx" ON "valuation_indicators" USING btree ("indicator","ts");
