ALTER TABLE "screens" ADD COLUMN "venue" text DEFAULT 'binance' NOT NULL;--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN "alert" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN "last_matches" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN "last_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN "last_alert_at" timestamp with time zone;