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
- Später (Phase 5/6): Pine-Webhook-Receiver (HMAC), WebSocket/SSE-Gateway, Fach-Router.
