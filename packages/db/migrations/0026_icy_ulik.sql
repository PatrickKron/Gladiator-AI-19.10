CREATE TABLE "swap_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"token" text NOT NULL,
	"symbol" text NOT NULL,
	"decimals" integer NOT NULL,
	"amount_atomic" numeric DEFAULT '0' NOT NULL,
	"cost_usd" numeric DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "swap_balances_nonneg" CHECK ("swap_balances"."amount_atomic" >= 0)
);
--> statement-breakpoint
CREATE TABLE "swap_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"side" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"aggregator" text NOT NULL,
	"in_token" text NOT NULL,
	"in_symbol" text NOT NULL,
	"in_atomic" numeric NOT NULL,
	"in_decimals" integer NOT NULL,
	"out_token" text NOT NULL,
	"out_symbol" text NOT NULL,
	"out_atomic" numeric NOT NULL,
	"out_decimals" integer NOT NULL,
	"value_usd" numeric,
	"fee_usd" numeric,
	"realized_pnl_usd" numeric,
	"price_impact_pct" numeric,
	"slippage_bps" integer NOT NULL,
	"route" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tx_hash" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "swap_trades_side_check" CHECK ("swap_trades"."side" IN ('buy', 'sell')),
	CONSTRAINT "swap_trades_status_check" CHECK ("swap_trades"."status" IN ('filled', 'pending', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "swap_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chain" text NOT NULL,
	"label" text NOT NULL,
	"mode" text DEFAULT 'paper' NOT NULL,
	"address" text NOT NULL,
	"encrypted_key" text,
	"live_approved_at" timestamp with time zone,
	"max_trade_usd" numeric NOT NULL,
	"max_slippage_bps" integer NOT NULL,
	"max_price_impact_pct" numeric NOT NULL,
	"min_liquidity_usd" numeric NOT NULL,
	"slippage_bps" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "swap_wallets_mode_check" CHECK ("swap_wallets"."mode" IN ('paper', 'live')),
	CONSTRAINT "swap_wallets_live_key_check" CHECK ("swap_wallets"."mode" = 'live' OR "swap_wallets"."encrypted_key" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "swap_balances" ADD CONSTRAINT "swap_balances_wallet_id_swap_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."swap_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swap_trades" ADD CONSTRAINT "swap_trades_wallet_id_swap_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."swap_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swap_wallets" ADD CONSTRAINT "swap_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "swap_balances_wallet_token_uq" ON "swap_balances" USING btree ("wallet_id","token");--> statement-breakpoint
CREATE INDEX "swap_trades_wallet_created_idx" ON "swap_trades" USING btree ("wallet_id","created_at");--> statement-breakpoint
CREATE INDEX "swap_wallets_user_idx" ON "swap_wallets" USING btree ("user_id");