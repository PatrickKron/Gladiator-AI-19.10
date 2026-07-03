# Sicherheits-Checkliste (10_ §7) — Status Phase 7, 2026-07-03

Verbindliche Abnahme-Checkliste aus `GLADIATOR_V2_BLUEPRINT/10_SICHERHEIT_UND_SECRETS.md` §7,
mit EHRLICHEM Status. ⚠-Punkte sind offen und blockieren die Live-Freigabe.

| # | Punkt | Status | Beleg |
|---|---|---|---|
| 1 | Alle Alt-Secrets rotiert/gelöscht | ⚠ **OFFEN — nur Patrick** | Telegram-Token `7544725601:…`, OpenAI `sk-proj-…`, OKX-Keys aus v1 sind kompromittiert (10_ §1). Rotation kann nur Patrick durchführen. Schutzmaßnahme bis dahin: der Alt-Telegram-Token wird vom Code **aktiv verweigert** (`telegramConfigured()`, `deploy/notify.sh` — per Test erzwungen). |
| 2 | Keine Klartext-Fallbacks; Boot bricht ohne Pflicht-Secrets ab | ✅ | `requireEnv()` für DATABASE_URL/JWT_SECRET/ENCRYPTION_KEY/REDIS_URL in `packages/api/src/start.ts`; Boot-Abbruch per Test belegt (Phase 0b/0c). |
| 3 | Echte Auth; kein MOCK_AUTH, kein Demo-User | ✅ | JWT 15 min + rotierender Refresh (SHA-256-Hash in `sessions`), Reuse-Detection revoked alle Sessions; 12 Auth-Tests. **RBAC/Tenant-Scoping entfällt per Scope-Entscheidung** (Patrick 2026-07-02: EIN User-Typ) — dokumentierte, bewusste Abweichung vom Blueprint. |
| 4 | tRPC/REST tragen Auth-Header; 401 ohne Token | ✅ | `protectedProcedure` → UNAUTHORIZED; HTTP-Ebene getestet. Bewusste Ausnahmen: `/health` (Monitoring) und `/api/stream/prices` (nur öffentliche Binance-Ticks, dokumentiert). |
| 5 | CORS-Whitelist, helmet, Rate-Limit aktiv | ✅ | helmet (CSP ohne upgrade-insecure-requests — HTTP-only im Tailscale-WireGuard-Netz, dokumentiert), CORS same-origin + `CORS_ORIGINS`-Whitelist, Rate-Limits: global 600/min, Auth 20/min, Pine-Webhook 30/min (Raw-Body 64 kb Limit). |
| 6 | Börsen-/Wallet-Keys verschlüsselt; nur Trade-Rechte, kein Withdraw | ✅ | Vault AES-256-GCM (`packages/exchange/src/vault.ts`, 8 Tests); Binance-Keys legt nur Patrick an (nur-Trade-Empfehlung dokumentiert); Hyperliquid ausschließlich Agent-Wallet (nativ ohne Auszahlungsrecht); **kein Adapter besitzt einen Withdraw-Codepfad** (Interface-Design). |
| 7 | Risk-Engine blockt nachweislich Orders über Limit (Tests) | ✅ | 32 Risk-Tests: Kill-Switch, SAFE-001 (3/7/15 %), SAFE-002 (5 Verluste → Pause), **SAFE-003 (VIX > 40)**, No-Trade-Fenster, Hebel-Cap, Positionen, Exposure, Sizing, Margin, adaptive Gates. CI-Beleg aus Phase 4b: echtes Gate blockte den Test. |
| 8 | Audit-Log vollständig; Webhooks signiert | ✅ | Append-only `audit_log` (Auth, Orders, Risk-Checks, Settings, Kill-Switch, Gates, Freigaben, Pine-Eingänge); Pine-Webhook: HMAC-SHA256 oder Body-Secret, timing-safe, nur bekannte strategyId, nie blind ausgeführt. |
| 9 | Disclaimer im UI | ✅ | Shell-Footer auf jeder Seite (5 Sprachen): keine Anlageberatung, Paper-Modus, Handel auf eigenes Risiko. |

## Zusätzliche Härtung (Phase 7)

- **Kill-Switch-Telegram-Warnung** bei jedem Schalten (auditiert).
- **Live-Freigabe pro Börse** (`venue_approvals`): nur mit exakter Bestätigungsphrase
  `LIVE-FREIGABE <venue>`, auditiert, jederzeit widerrufbar. Eine Freigabe schaltet
  NICHTS automatisch live — ein Live-Order-Pfad existiert bewusst nicht; sie ist die
  dokumentierte Voraussetzung für einen künftigen Live-Adapter.
- **Monitoring:** `/health` prüft DB + Worker-Heartbeat (degraded > 5 min); lokaler
  systemd-Watchdog (minütlich) mit Telegram-Alarm + Entwarnung, Anti-Spam 30 min.
- **Dead-Man's-Switch:** Worker pingt minütlich `HEALTHCHECKS_URL` (externer Dienst,
  z. B. healthchecks.io — legt Patrick an). Ehrlich: ohne externe URL kann ein
  Total-Ausfall des Servers nicht gemeldet werden — der lokale Watchdog deckt nur
  Prozess-/DB-Ausfälle ab.
- **Backups:** täglicher pg_dump (custom format, Rotation 14) + **wöchentlicher
  automatischer Restore-Test** in eine Wegwerf-DB mit echten Zeilenzahl-Checks;
  Fehler alarmieren via Telegram.

## Offene Punkte vor Live (Blocker)

1. **Alt-Secrets rotieren** (Patrick): Telegram-BotFather revoke + neu, OpenAI revoke, OKX löschen.
2. **Neue Betriebs-Secrets setzen** (Patrick, Server-.env): `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` (neu!), optional `HEALTHCHECKS_URL`, `ANTHROPIC_API_KEY`, `FRED_API_KEY`.
3. **Live-Order-Pfad existiert nicht** — bewusst. Vor einem echten Go-Live: Live-Adapter bauen, Testnet-E2E mit Patricks Keys, grüne Reconciliation, konservative Limits, Freigabe pro Börse (Phrase), Kleinst-Trade-Probe.
