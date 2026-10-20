CREATE TABLE "watched_wallet_swaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watched_id" uuid NOT NULL,
	"signature" text NOT NULL,
	"side" text NOT NULL,
	"token" text NOT NULL,
	"token_atomic" numeric NOT NULL,
	"token_decimals" integer NOT NULL,
	"sol_lamports" numeric,
	"counter_token" text,
	"tx_time" timestamp with time zone,
	"copy_status" text DEFAULT 'none' NOT NULL,
	"copy_trade_id" uuid,
	"copy_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watched_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chain" text DEFAULT 'solana' NOT NULL,
	"address" text NOT NULL,
	"label" text NOT NULL,
	"last_signature" text,
	"copy_mode" text DEFAULT 'off' NOT NULL,
	"copy_wallet_id" uuid,
	"copy_amount" text,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watched_wallets_copy_check" CHECK ("watched_wallets"."copy_mode" IN ('off', 'paper'))
);
--> statement-breakpoint
ALTER TABLE "watched_wallet_swaps" ADD CONSTRAINT "watched_wallet_swaps_watched_id_watched_wallets_id_fk" FOREIGN KEY ("watched_id") REFERENCES "public"."watched_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watched_wallets" ADD CONSTRAINT "watched_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watched_wallets" ADD CONSTRAINT "watched_wallets_copy_wallet_id_swap_wallets_id_fk" FOREIGN KEY ("copy_wallet_id") REFERENCES "public"."swap_wallets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "watched_wallet_swaps_sig_uq" ON "watched_wallet_swaps" USING btree ("watched_id","signature");--> statement-breakpoint
CREATE INDEX "watched_wallet_swaps_created_idx" ON "watched_wallet_swaps" USING btree ("watched_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "watched_wallets_user_addr_uq" ON "watched_wallets" USING btree ("user_id","chain","address");