-- TimescaleDB aktivieren und Zeitreihen-Tabellen zu Hypertables machen (04_ §6).
CREATE EXTENSION IF NOT EXISTS timescaledb;
--> statement-breakpoint
SELECT create_hypertable('ohlcv', 'ts', if_not_exists => TRUE, migrate_data => TRUE);
--> statement-breakpoint
SELECT create_hypertable('funding_rates', 'ts', if_not_exists => TRUE, migrate_data => TRUE);
--> statement-breakpoint
SELECT create_hypertable('open_interest', 'ts', if_not_exists => TRUE, migrate_data => TRUE);
