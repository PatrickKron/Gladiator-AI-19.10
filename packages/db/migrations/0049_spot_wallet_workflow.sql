CREATE TABLE IF NOT EXISTS "wallet_address_book" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "label" text NOT NULL,
  "network" text NOT NULL,
  "address" text NOT NULL,
  "memo" text,
  "is_whitelisted" boolean DEFAULT false NOT NULL,
  "approved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "wallet_address_book_user_idx" ON "wallet_address_book" ("user_id");

CREATE TABLE IF NOT EXISTS "spot_workflows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "path" text DEFAULT 'guided_cex' NOT NULL,
  "mode" text DEFAULT 'paper' NOT NULL,
  "exchange_connection_id" uuid REFERENCES "exchange_connections"("id") ON DELETE set null,
  "exchange_name" text NOT NULL,
  "symbol" text NOT NULL,
  "base_asset" text NOT NULL,
  "quote_asset" text NOT NULL,
  "quote_amount" numeric NOT NULL,
  "filled_base_qty" numeric,
  "avg_fill_price" numeric,
  "fee_paid" numeric,
  "exchange_order_id" text,
  "destination_wallet_id" uuid REFERENCES "wallet_address_book"("id") ON DELETE set null,
  "destination_address" text,
  "destination_network" text,
  "withdraw_tx_id" text,
  "withdraw_fee" numeric,
  "baseline_onchain_balance" numeric,
  "confirmed_onchain_balance" numeric,
  "stage" text DEFAULT 'bought' NOT NULL,
  "status_note" text,
  "raw" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "spot_workflows_user_idx" ON "spot_workflows" ("user_id", "created_at");
