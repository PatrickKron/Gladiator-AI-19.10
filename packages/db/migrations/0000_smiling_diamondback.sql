CREATE TYPE "public"."article_category" AS ENUM('recap', 'breaking', 'analysis', 'crypto', 'forex');--> statement-breakpoint
CREATE TYPE "public"."asset_class" AS ENUM('crypto', 'stock', 'etf', 'forex', 'commodity', 'index');--> statement-breakpoint
CREATE TYPE "public"."channel_kind" AS ENUM('telegram', 'push', 'email');--> statement-breakpoint
CREATE TYPE "public"."direction" AS ENUM('long', 'short');--> statement-breakpoint
CREATE TYPE "public"."order_side" AS ENUM('buy', 'sell');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'open', 'partially_filled', 'filled', 'canceled', 'rejected', 'error');--> statement-breakpoint
CREATE TYPE "public"."order_type" AS ENUM('market', 'limit', 'stop_market', 'take_profit_market');--> statement-breakpoint
CREATE TYPE "public"."review_vote" AS ENUM('confirm', 'reject', 'caution');--> statement-breakpoint
CREATE TYPE "public"."risk_class" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'done', 'error');--> statement-breakpoint
CREATE TYPE "public"."setup_type" AS ENUM('scalp', 'swing', 'position');--> statement-breakpoint
CREATE TYPE "public"."signal_source" AS ENUM('engine', 'pine', 'instruction', 'manual');--> statement-breakpoint
CREATE TYPE "public"."signal_status" AS ENUM('new', 'confirmed', 'rejected', 'expired', 'filled', 'closed');--> statement-breakpoint
CREATE TYPE "public"."strategy_kind" AS ENUM('builtin', 'pine', 'dsl');--> statement-breakpoint
CREATE TYPE "public"."strategy_version_status" AS ENUM('draft', 'paper', 'live', 'retired');--> statement-breakpoint
CREATE TYPE "public"."tier" AS ENUM('free', 'pro', 'vip');--> statement-breakpoint
CREATE TYPE "public"."trade_mode" AS ENUM('paper', 'live');--> statement-breakpoint
CREATE TYPE "public"."trading_session" AS ENUM('asia', 'london', 'newyork', 'off');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'pro', 'vip', 'admin');--> statement-breakpoint
CREATE TYPE "public"."venue_type" AS ENUM('cex', 'dex');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"name" text,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"locale" text DEFAULT 'de' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_signed_in" timestamp with time zone,
	"legacy_v1_id" integer,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_legacy_v1_id_unique" UNIQUE("legacy_v1_id")
);
--> statement-breakpoint
CREATE TABLE "economic_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"title" text NOT NULL,
	"country" text,
	"currency" text,
	"importance" integer,
	"scheduled_at" timestamp with time zone NOT NULL,
	"actual" numeric,
	"forecast" numeric,
	"previous" numeric,
	"unit" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funding_rates" (
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"rate" numeric NOT NULL,
	CONSTRAINT "funding_rates_venue_symbol_ts_pk" PRIMARY KEY("venue","symbol","ts")
);
--> statement-breakpoint
CREATE TABLE "macro_series" (
	"series_id" text NOT NULL,
	"source" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"value" numeric NOT NULL,
	CONSTRAINT "macro_series_source_series_id_ts_pk" PRIMARY KEY("source","series_id","ts")
);
--> statement-breakpoint
CREATE TABLE "ohlcv" (
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"timeframe" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"open" numeric NOT NULL,
	"high" numeric NOT NULL,
	"low" numeric NOT NULL,
	"close" numeric NOT NULL,
	"volume" numeric NOT NULL,
	CONSTRAINT "ohlcv_venue_symbol_timeframe_ts_pk" PRIMARY KEY("venue","symbol","timeframe","ts")
);
--> statement-breakpoint
CREATE TABLE "open_interest" (
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"open_interest" numeric NOT NULL,
	CONSTRAINT "open_interest_venue_symbol_ts_pk" PRIMARY KEY("venue","symbol","ts")
);
--> statement-breakpoint
CREATE TABLE "signal_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"vote" "review_vote" NOT NULL,
	"confidence" numeric NOT NULL,
	"reason" text NOT NULL,
	"refs" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" "signal_source" NOT NULL,
	"strategy_id" uuid NOT NULL,
	"strategy_version_id" uuid,
	"symbol" text NOT NULL,
	"asset_class" "asset_class" NOT NULL,
	"venue_type" "venue_type" NOT NULL,
	"direction" "direction" NOT NULL,
	"setup_type" "setup_type" NOT NULL,
	"entry" numeric NOT NULL,
	"stop_loss" numeric NOT NULL,
	"take_profits" numeric[] NOT NULL,
	"leverage_suggested" numeric DEFAULT '1' NOT NULL,
	"score" numeric NOT NULL,
	"risk_class" "risk_class" NOT NULL,
	"confluence" text[] DEFAULT '{}' NOT NULL,
	"session" "trading_session" NOT NULL,
	"reentry" jsonb,
	"leverage_upgrade" jsonb,
	"status" "signal_status" DEFAULT 'new' NOT NULL,
	"tier" "tier" NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" "strategy_kind" NOT NULL,
	"description" text,
	"created_by" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategies_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "strategy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"params" jsonb NOT NULL,
	"status" "strategy_version_status" DEFAULT 'draft' NOT NULL,
	"promoted_by" uuid,
	"promoted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exchange_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"venue" text NOT NULL,
	"venue_type" "venue_type" NOT NULL,
	"label" text,
	"encrypted_payload" text NOT NULL,
	"can_withdraw" boolean DEFAULT false NOT NULL,
	"testnet" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "executed_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"signal_id" uuid,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"direction" "direction" NOT NULL,
	"entry_ts" timestamp with time zone NOT NULL,
	"exit_ts" timestamp with time zone,
	"entry_price" numeric NOT NULL,
	"exit_price" numeric,
	"qty" numeric NOT NULL,
	"leverage" numeric DEFAULT '1' NOT NULL,
	"gross_pnl" numeric,
	"maker_taker_fee" numeric DEFAULT '0' NOT NULL,
	"slippage" numeric DEFAULT '0' NOT NULL,
	"funding_paid" numeric DEFAULT '0' NOT NULL,
	"net_pnl" numeric,
	"r_multiple" numeric,
	"mode" "trade_mode" DEFAULT 'paper' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"signal_id" uuid,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"client_order_id" text NOT NULL,
	"exchange_order_id" text,
	"type" "order_type" NOT NULL,
	"side" "order_side" NOT NULL,
	"qty" numeric NOT NULL,
	"price" numeric,
	"reduce_only" boolean DEFAULT false NOT NULL,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"mode" "trade_mode" DEFAULT 'paper' NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"direction" "direction" NOT NULL,
	"qty" numeric NOT NULL,
	"entry_price" numeric NOT NULL,
	"leverage" numeric DEFAULT '1' NOT NULL,
	"liquidation_price" numeric,
	"unrealized_pnl" numeric,
	"mode" "trade_mode" DEFAULT 'paper' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trading_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"risk_pct_per_trade" numeric DEFAULT '1' NOT NULL,
	"max_leverage" numeric DEFAULT '10' NOT NULL,
	"max_open_positions" integer DEFAULT 5 NOT NULL,
	"max_exposure_pct_per_asset" numeric DEFAULT '20' NOT NULL,
	"daily_loss_limit_pct" numeric DEFAULT '3' NOT NULL,
	"weekly_loss_limit_pct" numeric DEFAULT '7' NOT NULL,
	"max_drawdown_pct" numeric DEFAULT '15' NOT NULL,
	"kill_switch_active" boolean DEFAULT false NOT NULL,
	"mode" "trade_mode" DEFAULT 'paper' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_settings_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "backtests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"timeframe" text NOT NULL,
	"from_ts" timestamp with time zone NOT NULL,
	"to_ts" timestamp with time zone NOT NULL,
	"config" jsonb NOT NULL,
	"fees_model" jsonb NOT NULL,
	"sharpe" numeric,
	"sortino" numeric,
	"max_drawdown" numeric,
	"win_rate" numeric,
	"profit_factor" numeric,
	"expectancy" numeric,
	"net_return" numeric,
	"trade_count" numeric,
	"metrics" jsonb,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "optimizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" uuid NOT NULL,
	"base_version_id" uuid,
	"method" text NOT NULL,
	"param_space" jsonb NOT NULL,
	"results" jsonb,
	"best_params" jsonb,
	"best_score" numeric,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "walkforward_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"config" jsonb NOT NULL,
	"windows" jsonb,
	"oos_metrics" jsonb,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"package_id" integer NOT NULL,
	"ticker" text NOT NULL,
	"name" text NOT NULL,
	"exchange" text,
	"asset_type" text NOT NULL,
	"trading_pair" text,
	"base_currency" text,
	"quote_currency" text,
	"total_signals" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_asset_id_unique" UNIQUE("asset_id")
);
--> statement-breakpoint
CREATE TABLE "channel_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"canceled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "channel_kind" NOT NULL,
	"name" text NOT NULL,
	"config" jsonb,
	"tier" "tier" DEFAULT 'free' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "magazine_articles" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"summary" text,
	"category" "article_category" NOT NULL,
	"image_url" text,
	"source_url" text,
	"is_published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "newsletter_subscribers" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"locale" text DEFAULT 'de' NOT NULL,
	"subscribed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unsubscribed_at" timestamp with time zone,
	CONSTRAINT "newsletter_subscribers_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "package_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"package_id" integer NOT NULL,
	"tier" "tier" DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"canceled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" serial PRIMARY KEY NOT NULL,
	"package_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"subcategory" text,
	"icon" text,
	"color" text,
	"asset_count" integer DEFAULT 0 NOT NULL,
	"total_signals" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packages_package_id_unique" UNIQUE("package_id")
);
--> statement-breakpoint
CREATE TABLE "pricing" (
	"id" serial PRIMARY KEY NOT NULL,
	"tier" "tier" NOT NULL,
	"name" text NOT NULL,
	"price_per_month" numeric,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"features" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"keys" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "study_clusters" (
	"cluster_key" text PRIMARY KEY NOT NULL,
	"optimal_leverage" numeric,
	"optimal_tp_schema_id" text,
	"optimal_risk_pct" numeric,
	"raps_score" numeric,
	"sharpe" numeric,
	"sortino" numeric,
	"calmar" numeric,
	"winrate" numeric,
	"profit_factor" numeric,
	"expectancy" numeric,
	"trade_count" integer DEFAULT 0 NOT NULL,
	"data_window_days" integer,
	"lambda_time_decay" numeric,
	"is_low_sample_size" boolean DEFAULT true NOT NULL,
	"changelog" jsonb,
	"causality_explanation" text,
	"embedding" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "study_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_key" text NOT NULL,
	"executed_trade_id" uuid,
	"direction" "direction" NOT NULL,
	"entry_ts" timestamp with time zone NOT NULL,
	"exit_ts" timestamp with time zone NOT NULL,
	"mfe_bps" numeric,
	"mae_bps" numeric,
	"r_multiple" numeric NOT NULL,
	"session" text,
	"market_structure" text,
	"fees" numeric DEFAULT '0' NOT NULL,
	"funding" numeric DEFAULT '0' NOT NULL,
	"slippage" numeric DEFAULT '0' NOT NULL,
	"net_pnl" numeric NOT NULL,
	"liquidation_flag" boolean DEFAULT false NOT NULL,
	"pnl_r_tp_a" numeric,
	"pnl_r_tp_b" numeric,
	"pnl_r_tp_c" numeric,
	"pnl_r_tp_d" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"details" jsonb,
	"ip" text
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_reviews" ADD CONSTRAINT "signal_reviews_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_promoted_by_users_id_fk" FOREIGN KEY ("promoted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_credentials" ADD CONSTRAINT "exchange_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executed_trades" ADD CONSTRAINT "executed_trades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executed_trades" ADD CONSTRAINT "executed_trades_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_settings" ADD CONSTRAINT "trading_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtests" ADD CONSTRAINT "backtests_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimizations" ADD CONSTRAINT "optimizations_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimizations" ADD CONSTRAINT "optimizations_base_version_id_strategy_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "walkforward_runs" ADD CONSTRAINT "walkforward_runs_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_subscriptions" ADD CONSTRAINT "channel_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_subscriptions" ADD CONSTRAINT "channel_subscriptions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_subscriptions" ADD CONSTRAINT "package_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_subscriptions" ADD CONSTRAINT "package_subscriptions_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_trades" ADD CONSTRAINT "study_trades_executed_trade_id_executed_trades_id_fk" FOREIGN KEY ("executed_trade_id") REFERENCES "public"."executed_trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "economic_events_scheduled_idx" ON "economic_events" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "economic_events_source_ext_idx" ON "economic_events" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "ohlcv_symbol_tf_ts_idx" ON "ohlcv" USING btree ("symbol","timeframe","ts");--> statement-breakpoint
CREATE INDEX "signal_reviews_signal_idx" ON "signal_reviews" USING btree ("signal_id");--> statement-breakpoint
CREATE INDEX "signals_symbol_created_idx" ON "signals" USING btree ("symbol","created_at");--> statement-breakpoint
CREATE INDEX "signals_strategy_idx" ON "signals" USING btree ("strategy_id");--> statement-breakpoint
CREATE INDEX "signals_status_idx" ON "signals" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_versions_unique_idx" ON "strategy_versions" USING btree ("strategy_id","version");--> statement-breakpoint
CREATE INDEX "exchange_credentials_user_idx" ON "exchange_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "executed_trades_user_idx" ON "executed_trades" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "executed_trades_symbol_idx" ON "executed_trades" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "executed_trades_entry_ts_idx" ON "executed_trades" USING btree ("entry_ts");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_client_order_id_idx" ON "orders" USING btree ("client_order_id");--> statement-breakpoint
CREATE INDEX "orders_user_idx" ON "orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "orders_signal_idx" ON "orders" USING btree ("signal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_unique_idx" ON "positions" USING btree ("user_id","venue","symbol","mode");--> statement-breakpoint
CREATE INDEX "backtests_version_idx" ON "backtests" USING btree ("strategy_version_id");--> statement-breakpoint
CREATE INDEX "optimizations_strategy_idx" ON "optimizations" USING btree ("strategy_id");--> statement-breakpoint
CREATE INDEX "walkforward_runs_version_idx" ON "walkforward_runs" USING btree ("strategy_version_id");--> statement-breakpoint
CREATE INDEX "assets_package_idx" ON "assets" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "channel_subscriptions_user_idx" ON "channel_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "package_subscriptions_user_idx" ON "package_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "study_trades_cluster_idx" ON "study_trades" USING btree ("cluster_key");--> statement-breakpoint
CREATE INDEX "study_trades_exit_idx" ON "study_trades" USING btree ("exit_ts");--> statement-breakpoint
CREATE INDEX "audit_log_ts_idx" ON "audit_log" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "audit_log_user_idx" ON "audit_log" USING btree ("user_id");