# Gladiator AI v2 — Arbeitsanweisung für Claude Code (Repo-Root)

## Quelle der Wahrheit
`GLADIATOR_V2_BLUEPRINT/` (in diesem Repo mitgeführt, Kopie der Spezifikation) ist verbindlich. Bei Konflikt oder Lücke: nachfragen, nicht raten.

## Betrieb
Dieses Repo läuft kanonisch auf dem Hetzner-Server `95.216.10.238` unter `/opt/gladiator-v2/app`. Lokale Kopie (Windows, `Antigravity Gladiator AI versuch 1/gladiator-v2/`) ist die Arbeitskopie; Deploy per `git push server main`. Infra: `docker compose` (TimescaleDB auf 127.0.0.1:5433, Redis auf 127.0.0.1:6380 — bewusst nicht 5432/6379, dort läuft der CHAMÆLIEN-Stack; dessen Container/Ports niemals anfassen).

## Eiserne Regeln
1. **KEIN Fake.** Keine `Math.random()`-Daten, kein Mock/Demo/Platzhalter in Laufpfaden (Mock nur in Tests). Nicht-verbundene Quellen sichtbar als „nicht verbunden" markieren.
2. **Sicherheit zuerst:** echte Auth (JWT + rotierender Refresh); keine Klartext-Secret-Fallbacks (fehlendes Pflicht-Secret → Boot-Abbruch); Risk-Engine als hartes Gate vor jeder Order; keine Auszahlungen/Transfers durch den Agenten.
   **Scope-Entscheidung (Patrick, 2026-07-02, überschreibt Blueprint 10_ §3 / 01_ §4):** EIN User-Typ mit vollem Zugriff — KEINE Rollen, kein RBAC, keine Tenant-Isolation, keine Free/Pro/VIP-Tiers.
3. **Paper-Default.** Live nur nach expliziter Freigabe pro Börse.
4. **Backtests netto** (Gebühren/Slippage/Funding, look-ahead-frei, Survivorship-geprüft).
5. **TDD:** erst Tests, dann Code — v. a. Risk-Engine, Strategien, Order-Lifecycle, Auth.
6. **Eine Wahrheit:** ein Backend, ein Signal-Modell (`@gladiator/core`), eine Strategie-Engine.
7. **Mensch im Loop:** Live-Eskalationen/Limit-Erhöhungen/Strategie-Promotionen bestätigt Patrick.
8. **Immer nur EINE Phase** aus `GLADIATOR_V2_BLUEPRINT/11_BUILD_PLAN_CLAUDE_CODE.md`, dann Abnahme.
9. **Nichts Funktionierendes beschädigen** — weder v1 (lokal) noch die anderen Dienste auf dem Server.

## Sonderregel UI
`apps/web` wird erst in Phase 6 gebaut, NACHDEM Patrick neue Referenzbilder geliefert und das daraus abgeleitete Design-System abgenommen hat. Aus `09_UI_REDESIGN.md` gilt nur die funktionale Struktur.

## Stack & Struktur
TypeScript · Express + tRPC 11 · Drizzle + PostgreSQL/TimescaleDB · ccxt(pro) · Hyperliquid/dYdX-SDKs · BullMQ + Redis · React + Vite + Tailwind · optional Python-Quant-Service.
`packages/{core,db,market-data,strategy-engine,exchange,risk,agents,backtest,api,jobs}`, `apps/web`, `services/quant`. Jedes Paket hat eine eigene kurze `CLAUDE.md`.

## Konventionen
- npm workspaces; Node ≥ 22; ESM (`"type": "module"`); strict TypeScript (`tsconfig.base.json`).
- Preise/Mengen als `numeric` (nie float-Cents-Mix), Zeit als `timestamptz`.
- Tests: Vitest (`npm test` im Root); DB-Tests brauchen `DATABASE_URL` (auf dem Server via `scripts/ci.sh`).
- Seed-Daten (`packages/db/seed/data/`) enthalten echte User-Daten → gitignored, liegen nur auf dem Server.

## Definition of Done je Phase
Abnahmekriterien B0a–B7 im Bauplan; Mock-Checkliste aus `03_MOCKUP_BEFREIUNG.md` = 0 Treffer im Laufpfad. Nach jeder Phase `PROGRESS.md` (im v1-Ordner bei Patrick) aktualisieren.
