ALTER TABLE "assets" ADD COLUMN "candle_venue" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "data_symbol" text;--> statement-breakpoint
ALTER TABLE "price_alerts" ADD COLUMN "venue" text;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_candle_source_uidx" ON "assets" USING btree ("candle_venue","data_symbol");--> statement-breakpoint
-- Datenfix (Asset-Register 2026-10-25): market.ingestStockYahoo schrieb Wochenkerzen als '1wk' statt des kanonischen '1w' (SUPPORTED_TIMEFRAMES) — umhängen, Doppelte verwerfen.
INSERT INTO "ohlcv" ("venue", "symbol", "timeframe", "ts", "open", "high", "low", "close", "volume")
SELECT "venue", "symbol", '1w', "ts", "open", "high", "low", "close", "volume" FROM "ohlcv" WHERE "timeframe" = '1wk'
ON CONFLICT DO NOTHING;--> statement-breakpoint
DELETE FROM "ohlcv" WHERE "timeframe" = '1wk';
