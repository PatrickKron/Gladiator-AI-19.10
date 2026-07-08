-- Demo-Trading (Session 5): manueller Demo-Modus mit virtuellem Guthaben.
-- demo_accounts (Balance/Reset), demo_orders (Partial Fills), demo_positions,
-- demo_trades (netto). STRIKT getrennt von orders/positions/executed_trades —
-- rein ADDITIV, alles idempotent (CREATE TABLE IF NOT EXISTS + DO-$$-FK-Guards).
CREATE TABLE IF NOT EXISTS "demo_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"start_balance" numeric DEFAULT '100000' NOT NULL,
	"balance" numeric DEFAULT '100000' NOT NULL,
	"reset_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reset_at" timestamp with time zone,
	CONSTRAINT "demo_accounts_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "demo_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"type" "order_type" NOT NULL,
	"side" "order_side" NOT NULL,
	"qty" numeric NOT NULL,
	"filled_qty" numeric DEFAULT '0' NOT NULL,
	"limit_price" numeric,
	"trigger_price" numeric,
	"avg_fill_price" numeric,
	"fee_paid" numeric DEFAULT '0' NOT NULL,
	"slippage_paid" numeric DEFAULT '0' NOT NULL,
	"reduce_only" boolean DEFAULT false NOT NULL,
	"status" "order_status" DEFAULT 'open' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "demo_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"direction" "direction" NOT NULL,
	"qty" numeric NOT NULL,
	"entry_price" numeric NOT NULL,
	"entry_fee" numeric DEFAULT '0' NOT NULL,
	"entry_slippage" numeric DEFAULT '0' NOT NULL,
	"stop_loss" numeric,
	"take_profit" numeric,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "demo_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"direction" "direction" NOT NULL,
	"entry_ts" timestamp with time zone NOT NULL,
	"exit_ts" timestamp with time zone NOT NULL,
	"entry_price" numeric NOT NULL,
	"exit_price" numeric NOT NULL,
	"qty" numeric NOT NULL,
	"gross_pnl" numeric NOT NULL,
	"fees" numeric DEFAULT '0' NOT NULL,
	"slippage" numeric DEFAULT '0' NOT NULL,
	"funding_paid" numeric DEFAULT '0' NOT NULL,
	"net_pnl" numeric NOT NULL,
	"r_multiple" numeric,
	"reason" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "demo_accounts" ADD CONSTRAINT "demo_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "demo_orders" ADD CONSTRAINT "demo_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "demo_orders" ADD CONSTRAINT "demo_orders_account_id_demo_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."demo_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "demo_positions" ADD CONSTRAINT "demo_positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "demo_positions" ADD CONSTRAINT "demo_positions_account_id_demo_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."demo_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "demo_trades" ADD CONSTRAINT "demo_trades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "demo_trades" ADD CONSTRAINT "demo_trades_account_id_demo_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."demo_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demo_orders_user_status_idx" ON "demo_orders" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demo_orders_symbol_idx" ON "demo_orders" USING btree ("symbol");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "demo_positions_unique_idx" ON "demo_positions" USING btree ("account_id","symbol","direction");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demo_trades_user_idx" ON "demo_trades" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demo_trades_exit_ts_idx" ON "demo_trades" USING btree ("exit_ts");
