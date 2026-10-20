ALTER TABLE "swap_orders" DROP CONSTRAINT "swap_orders_kind_check";--> statement-breakpoint
ALTER TABLE "swap_orders" ADD COLUMN "interval_minutes" integer;--> statement-breakpoint
ALTER TABLE "swap_orders" ADD COLUMN "runs_total" integer;--> statement-breakpoint
ALTER TABLE "swap_orders" ADD COLUMN "runs_done" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "swap_orders" ADD COLUMN "next_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "swap_orders" ADD COLUMN "max_price_usd" numeric;--> statement-breakpoint
ALTER TABLE "swap_orders" ADD CONSTRAINT "swap_orders_dca_check" CHECK ("swap_orders"."kind" <> 'dca' OR ("swap_orders"."interval_minutes" > 0 AND "swap_orders"."runs_total" > 0 AND "swap_orders"."next_run_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "swap_orders" ADD CONSTRAINT "swap_orders_kind_check" CHECK ("swap_orders"."kind" IN ('take_profit', 'stop_loss', 'trailing_stop', 'limit_buy', 'dca'));