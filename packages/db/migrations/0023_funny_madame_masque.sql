DROP INDEX "demo_positions_unique_idx";--> statement-breakpoint
ALTER TABLE "demo_orders" ADD COLUMN "venue" text DEFAULT 'binance' NOT NULL;--> statement-breakpoint
ALTER TABLE "demo_positions" ADD COLUMN "venue" text DEFAULT 'binance' NOT NULL;--> statement-breakpoint
ALTER TABLE "demo_trades" ADD COLUMN "venue" text DEFAULT 'binance' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "demo_positions_unique_idx" ON "demo_positions" USING btree ("account_id","venue","symbol","direction");