CREATE TABLE IF NOT EXISTS "funded_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "provider" text NOT NULL,
  "phase" text DEFAULT 'challenge_1' NOT NULL,
  "currency" text DEFAULT 'USD' NOT NULL,
  "start_balance" numeric NOT NULL,
  "current_equity" numeric NOT NULL,
  "high_water_mark" numeric NOT NULL,
  "daily_start_equity" numeric NOT NULL,
  "daily_loss_limit_pct" numeric DEFAULT '5' NOT NULL,
  "max_total_drawdown_pct" numeric DEFAULT '10' NOT NULL,
  "profit_target_pct" numeric,
  "payout_split_pct" numeric DEFAULT '80' NOT NULL,
  "trailing_drawdown" boolean DEFAULT false NOT NULL,
  "exchange_connection_id" uuid REFERENCES "exchange_connections"("id") ON DELETE set null,
  "notes" text,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "funded_accounts_user_idx" ON "funded_accounts" ("user_id");
