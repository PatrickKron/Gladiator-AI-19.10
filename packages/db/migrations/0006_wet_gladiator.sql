CREATE TABLE "news_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"summary" text,
	"published_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "news_items_url_unique" UNIQUE("url")
);
--> statement-breakpoint
CREATE INDEX "news_items_published_idx" ON "news_items" USING btree ("published_at");