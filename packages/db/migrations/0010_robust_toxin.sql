CREATE TYPE "public"."sub_agent_status" AS ENUM('active', 'paused', 'archived');--> statement-breakpoint
ALTER TYPE "public"."signal_source" ADD VALUE 'sub_agent';--> statement-breakpoint
CREATE TABLE "sub_agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sub_agent_id" uuid NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"symbols_evaluated" integer DEFAULT 0 NOT NULL,
	"signals_created" integer DEFAULT 0 NOT NULL,
	"positions_closed" integer DEFAULT 0 NOT NULL,
	"note" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "sub_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"thesis" text,
	"data_sources" jsonb NOT NULL,
	"entry_rules" jsonb NOT NULL,
	"exit_rules" jsonb NOT NULL,
	"risk_params" jsonb NOT NULL,
	"config" jsonb NOT NULL,
	"symbols" text[] DEFAULT '{}' NOT NULL,
	"status" "sub_agent_status" DEFAULT 'paused' NOT NULL,
	"mode" "trade_mode" DEFAULT 'paper' NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "sub_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "executed_trades" ADD COLUMN "sub_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "sub_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "sub_agent_runs" ADD CONSTRAINT "sub_agent_runs_sub_agent_id_sub_agents_id_fk" FOREIGN KEY ("sub_agent_id") REFERENCES "public"."sub_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_agents" ADD CONSTRAINT "sub_agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sub_agent_runs_agent_idx" ON "sub_agent_runs" USING btree ("sub_agent_id","ran_at");--> statement-breakpoint
CREATE INDEX "sub_agents_user_idx" ON "sub_agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sub_agents_status_idx" ON "sub_agents" USING btree ("status");--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_sub_agent_id_sub_agents_id_fk" FOREIGN KEY ("sub_agent_id") REFERENCES "public"."sub_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executed_trades" ADD CONSTRAINT "executed_trades_sub_agent_id_sub_agents_id_fk" FOREIGN KEY ("sub_agent_id") REFERENCES "public"."sub_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_sub_agent_id_sub_agents_id_fk" FOREIGN KEY ("sub_agent_id") REFERENCES "public"."sub_agents"("id") ON DELETE set null ON UPDATE no action;