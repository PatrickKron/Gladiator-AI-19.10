CREATE TABLE "rl_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"episode_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"state" jsonb NOT NULL,
	"action" text NOT NULL,
	"reward" numeric,
	"value_estimate" numeric,
	"probability" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rl_agent_performance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"period" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"return_pct" numeric,
	"sharpe_ratio" numeric,
	"max_drawdown" numeric,
	"win_rate" numeric,
	"total_trades" integer,
	"weight" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rl_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"strategy_type" text NOT NULL,
	"status" text DEFAULT 'paper' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk_budget" numeric DEFAULT '0.1' NOT NULL,
	"model_blob" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rl_episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"timeframe" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"total_reward" numeric,
	"sharpe_ratio" numeric,
	"max_drawdown" numeric,
	"total_trades" integer DEFAULT 0 NOT NULL,
	"win_rate" numeric,
	"config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rl_actions" ADD CONSTRAINT "rl_actions_episode_id_rl_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."rl_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rl_actions" ADD CONSTRAINT "rl_actions_agent_id_rl_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."rl_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rl_agent_performance" ADD CONSTRAINT "rl_agent_performance_agent_id_rl_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."rl_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rl_episodes" ADD CONSTRAINT "rl_episodes_agent_id_rl_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."rl_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rl_actions_episode_idx" ON "rl_actions" USING btree ("episode_id");--> statement-breakpoint
CREATE INDEX "rl_actions_agent_idx" ON "rl_actions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "rl_actions_ts_idx" ON "rl_actions" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "rl_perf_agent_idx" ON "rl_agent_performance" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "rl_perf_period_idx" ON "rl_agent_performance" USING btree ("period","period_start");--> statement-breakpoint
CREATE INDEX "rl_agents_status_idx" ON "rl_agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "rl_agents_strategy_idx" ON "rl_agents" USING btree ("strategy_type");--> statement-breakpoint
CREATE INDEX "rl_episodes_agent_idx" ON "rl_episodes" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "rl_episodes_symbol_tf_idx" ON "rl_episodes" USING btree ("symbol","timeframe");