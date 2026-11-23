CREATE TABLE IF NOT EXISTS "signal_studies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "signal_id" uuid NOT NULL REFERENCES "signals"("id") ON DELETE cascade,
  "strategy_id" uuid NOT NULL REFERENCES "strategies"("id") ON DELETE cascade,
  "strategy_slug" text NOT NULL,
  "symbol" text NOT NULL,
  "venue" text DEFAULT 'binance' NOT NULL,
  "timeframe" text NOT NULL,
  "direction" text NOT NULL,
  "setup_type" text NOT NULL,
  "signal_status" text NOT NULL,
  "usage_group" text NOT NULL,
  "variant" text NOT NULL,
  "study_status" text NOT NULL,
  "r_multiple" numeric,
  "mfe_r" numeric,
  "mae_r" numeric,
  "exit_reason" text,
  "bars_held" integer,
  "session" text NOT NULL,
  "market_phase" text NOT NULL,
  "ema_regime" text NOT NULL,
  "score" numeric NOT NULL,
  "event_category" text DEFAULT 'none' NOT NULL,
  "event_title" text,
  "event_delta_min" integer,
  "signal_created_at" timestamp with time zone NOT NULL,
  "exit_ts" timestamp with time zone,
  "evaluated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "signal_studies_signal_variant_uidx" ON "signal_studies" ("signal_id", "variant");
CREATE INDEX IF NOT EXISTS "signal_studies_created_idx" ON "signal_studies" ("signal_created_at");
CREATE INDEX IF NOT EXISTS "signal_studies_usage_variant_idx" ON "signal_studies" ("usage_group", "variant");
CREATE INDEX IF NOT EXISTS "signal_studies_session_event_idx" ON "signal_studies" ("session", "event_category");
