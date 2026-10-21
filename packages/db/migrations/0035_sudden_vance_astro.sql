ALTER TABLE "swap_orders" DROP CONSTRAINT "swap_orders_kind_check";--> statement-breakpoint
ALTER TABLE "swap_orders" ADD COLUMN "watch_address" text;--> statement-breakpoint
ALTER TABLE "swap_orders" ADD COLUMN "watch_balance" numeric;--> statement-breakpoint
ALTER TABLE "swap_orders" ADD CONSTRAINT "swap_orders_kind_check" CHECK ("swap_orders"."kind" IN ('take_profit', 'stop_loss', 'trailing_stop', 'limit_buy', 'dca', 'alert_above', 'alert_below', 'rug_guard', 'dev_sell'));