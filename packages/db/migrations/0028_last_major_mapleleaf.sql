CREATE TABLE "swap_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"token" text NOT NULL,
	"symbol" text NOT NULL,
	"kind" text NOT NULL,
	"trigger_price_usd" numeric,
	"trail_pct" numeric,
	"peak_price_usd" numeric,
	"sell_percent" numeric,
	"buy_amount" text,
	"slippage_bps" integer,
	"confirmed_live" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"trade_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"triggered_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "swap_orders_kind_check" CHECK ("swap_orders"."kind" IN ('take_profit', 'stop_loss', 'trailing_stop', 'limit_buy')),
	CONSTRAINT "swap_orders_status_check" CHECK ("swap_orders"."status" IN ('open', 'executing', 'filled', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "swap_orders" ADD CONSTRAINT "swap_orders_wallet_id_swap_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."swap_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "swap_orders_status_idx" ON "swap_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "swap_orders_wallet_idx" ON "swap_orders" USING btree ("wallet_id","created_at");