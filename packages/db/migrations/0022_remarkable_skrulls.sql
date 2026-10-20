ALTER TABLE "demo_orders" ADD COLUMN "leverage" numeric DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "demo_positions" ADD COLUMN "leverage" numeric DEFAULT '1' NOT NULL;