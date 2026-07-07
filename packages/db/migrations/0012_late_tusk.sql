CREATE TABLE "ml_features" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"timeframe" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"features" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ml_labels" (
	"id" serial PRIMARY KEY NOT NULL,
	"signal_id" text,
	"symbol" text NOT NULL,
	"timeframe" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"signal_type" text NOT NULL,
	"signal_direction" text NOT NULL,
	"outcome" integer NOT NULL,
	"return_pct" numeric,
	"holding_bars" integer,
	"features" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ml_models" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"model_type" text DEFAULT 'random_forest' NOT NULL,
	"symbol" text,
	"timeframe" text,
	"hyperparams" jsonb,
	"metrics" jsonb,
	"model_blob" text,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ml_predictions" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_id" integer,
	"signal_id" text,
	"symbol" text NOT NULL,
	"timeframe" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"probability" numeric NOT NULL,
	"bet_size" numeric NOT NULL,
	"truth_core_pass" boolean DEFAULT false NOT NULL,
	"truth_core_reasons" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ml_labels" ADD CONSTRAINT "ml_labels_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_predictions" ADD CONSTRAINT "ml_predictions_model_id_ml_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ml_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ml_features_unique_idx" ON "ml_features" USING btree ("symbol","timeframe","ts");--> statement-breakpoint
CREATE INDEX "ml_features_symbol_tf_idx" ON "ml_features" USING btree ("symbol","timeframe");--> statement-breakpoint
CREATE INDEX "ml_labels_signal_idx" ON "ml_labels" USING btree ("signal_id");--> statement-breakpoint
CREATE INDEX "ml_labels_symbol_tf_idx" ON "ml_labels" USING btree ("symbol","timeframe");--> statement-breakpoint
CREATE INDEX "ml_models_active_idx" ON "ml_models" USING btree ("symbol","timeframe","is_active");--> statement-breakpoint
CREATE INDEX "ml_predictions_signal_idx" ON "ml_predictions" USING btree ("signal_id");--> statement-breakpoint
CREATE INDEX "ml_predictions_symbol_ts_idx" ON "ml_predictions" USING btree ("symbol","ts");