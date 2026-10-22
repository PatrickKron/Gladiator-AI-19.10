# @gladiator/api

Express 5 + tRPC 11. Echte Auth: kurzlebiges JWT (Access) + rotierender Refresh-Token (nur Hash in `sessions`).

**Scope-Entscheidung (Patrick, 2026-07-02):** EIN User-Typ mit vollem Zugriff — KEINE Rollen, kein RBAC, keine Tenant-Isolation, keine Free/Pro/VIP-Tiers.

Regeln:
- `protectedProcedure` → `UNAUTHORIZED` (HTTP 401) ohne gültiges Token. KEIN Demo-User-Fallback (Alt-Fehler).
- `JWT_SECRET` ist Pflicht-Env ohne Fallback — fehlt es, bricht der Boot ab.
- Refresh-Rotation: jeder Refresh entwertet den alten Token; Wiederverwendung eines entwerteten Tokens revoked ALLE Sessions des Users (Reuse-Detection).
- Passwörter: bcryptjs (v1-Hashes bleiben gültig), min. 10 Zeichen.
- Sicherheit: helmet, CORS nur per `CORS_ORIGINS`-Whitelist, Rate-Limits (streng auf Auth-Routen).
- Auth-Ereignisse (register/login/logout/reuse) → `audit_log`.
- Registrierungs-Sperre: existiert ein User, lehnt `auth.register` ab (FORBIDDEN, „Registrierung geschlossen …"); nur `ALLOW_REGISTRATION=1` öffnet (Tests setzen es in `vitest.config.ts`).
- Steuer-Export `trading.exportTrades` (CSV, Builder in `src/export/trades-csv.ts`) und Protokoll `system.auditLog` (nur lesend, Keyset-Pagination).
- Später (Phase 5/6): Pine-Webhook-Receiver (HMAC), WebSocket/SSE-Gateway, Fach-Router.
- Markt-Screener: Router `screener.*`; Bedingungen/Auswertung/Vorlagen liegen in `@gladiator/indicators` (`src/screener/`), damit der Worker (Screen-Alarme) dieselbe Auswertung nutzt; Universum = `candleUniverse()` aus @gladiator/market-data (nur Symbole mit echten Kerzen).
- `market.symbolSearch` / `market.ensureCandles`: Asset-Suche über alle Binance-USDT-Spot-Paare (live, 1 h gemerkt) und Backfill auf Abruf — unbekanntes Paar ist ein Fehler, nie eine leere Historie.
- Gladiator-Chat (`src/assistant/`): Werkzeuge rufen dieselben Service-Funktionen wie die Seiten (`workshop/draft-service.ts`, `routers/screener.ts#runScreen`, `routers/strategies.ts#promoteVersion`). Alles, was scharf schaltet, kommt als Bestätigungs-Karte zurück und läuft erst über `assistant.confirm` — nie direkt aus einem Werkzeug. Jede Zahl im Chat stammt aus einem Werkzeug-Ergebnis.
