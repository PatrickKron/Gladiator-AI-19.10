CREATE TABLE "asset_favorites" (
	"user_id" uuid NOT NULL,
	"asset_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_favorites_user_id_asset_id_pk" PRIMARY KEY("user_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "price_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"condition" text NOT NULL,
	"price" numeric NOT NULL,
	"note" text,
	"active" boolean DEFAULT true NOT NULL,
	"triggered_at" timestamp with time zone,
	"triggered_price" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_notes" (
	"trade_id" uuid PRIMARY KEY NOT NULL,
	"note" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset_favorites" ADD CONSTRAINT "asset_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_favorites" ADD CONSTRAINT "asset_favorites_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_alerts" ADD CONSTRAINT "price_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "price_alerts_active_idx" ON "price_alerts" USING btree ("active","symbol");