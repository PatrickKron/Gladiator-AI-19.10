CREATE TABLE "chart_drawings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"kind" text NOT NULL,
	"points" jsonb NOT NULL,
	"style" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chart_drawings_kind_check" CHECK ("chart_drawings"."kind" IN ('hline', 'trend', 'fib'))
);
--> statement-breakpoint
ALTER TABLE "chart_drawings" ADD CONSTRAINT "chart_drawings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chart_drawings_user_symbol_idx" ON "chart_drawings" USING btree ("user_id","symbol");