ALTER TABLE "push_subscriptions" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "last_success_at" timestamp with time zone;