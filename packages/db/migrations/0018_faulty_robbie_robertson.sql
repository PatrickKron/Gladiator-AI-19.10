CREATE TYPE "public"."exchange_connection_mode" AS ENUM('read_only', 'trading');--> statement-breakpoint
CREATE TYPE "public"."exchange_connection_status" AS ENUM('active', 'error', 'revoked');--> statement-breakpoint
CREATE TABLE "exchange_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"exchange_id" text NOT NULL,
	"exchange_name" text NOT NULL,
	"label" text,
	"encrypted_payload" text NOT NULL,
	"key_last4" text NOT NULL,
	"mode" "exchange_connection_mode" DEFAULT 'read_only' NOT NULL,
	"status" "exchange_connection_status" DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_validated_at" timestamp with time zone,
	"markets_summary" jsonb,
	"max_leverage" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "account_value_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"demo_equity_usd" numeric,
	"paper_equity_usd" numeric,
	"real_equity_usd" numeric,
	"eur_usd_rate" numeric,
	"total_eur" numeric,
	"breakdown" jsonb
);
--> statement-breakpoint
ALTER TABLE "exchange_connections" ADD CONSTRAINT "exchange_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_value_snapshots" ADD CONSTRAINT "account_value_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exchange_connections_user_idx" ON "exchange_connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "exchange_connections_exchange_idx" ON "exchange_connections" USING btree ("exchange_id");--> statement-breakpoint
CREATE INDEX "account_value_snapshots_user_ts_idx" ON "account_value_snapshots" USING btree ("user_id","ts");