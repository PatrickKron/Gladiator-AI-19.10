# @gladiator/db

Drizzle-Schema für PostgreSQL + TimescaleDB, Migrationen und Seed. Spezifikation: `GLADIATOR_V2_BLUEPRINT/04_ZIELARCHITEKTUR.md` §6 (+ `13_` VDB1/VDB2).

Regeln:
- Preise/Mengen als `numeric`, Zeit als `timestamptz`. Kein Float-/Cents-Mischmasch (Alt-Fehler).
- `executed_trades` MUSS Netto-Kostenfelder tragen (`maker_taker_fee`, `slippage`, `funding_paid`, `net_pnl`) — Auswertung rechnet immer netto.
- `ohlcv`, `funding_rates`, `open_interest` sind Timescale-Hypertables (Custom-Migration).
- Schema-Änderungen NUR über `npm run generate` (drizzle-kit) → neue Migration; nie bestehende Migrationen editieren.
- Seed lädt NUR echte v1-Daten (users/packages/assets/magazine) aus `seed/data/` (gitignored, liegt auf dem Server). Keine erfundenen Daten.
- `audit_log` ist append-only: App-Code darf nie UPDATE/DELETE darauf ausführen.
- Asset-Register (0043): `assets.candle_venue` ('binance' | 'yahoo' | 'twelvedata') + `assets.data_symbol` (exaktes Kerzen-Symbol), Unique-Index auf beide; vom Nutzer hinzugefügte Märkte liegen im Paket `user-markets` („Eigene Märkte“, @gladiator/jobs). `price_alerts.venue` (null = Altbestand → Binance). Wochenkerzen heißen überall `1w` (Datenfix '1wk' → '1w' in 0043).
