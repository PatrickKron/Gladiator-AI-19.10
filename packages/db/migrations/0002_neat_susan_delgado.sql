DROP TABLE "pricing" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "signals" DROP COLUMN "tier";--> statement-breakpoint
ALTER TABLE "channels" DROP COLUMN "tier";--> statement-breakpoint
ALTER TABLE "package_subscriptions" DROP COLUMN "tier";--> statement-breakpoint
DROP TYPE "public"."tier";--> statement-breakpoint
DROP TYPE "public"."user_role";