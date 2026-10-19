# Gladiator AI v2

KI-gestützte Trading-Agenten-Plattform — kompletter Neuaufbau nach der Spezifikation in `GLADIATOR_V2_BLUEPRINT/`.

**Status:** Lauffähige App im Paper-Betrieb (Server `95.216.10.238`, Tailnet). Verlauf und offene Punkte: `WORKOVER.md`.

## Betrieb (Hetzner-Server)

```bash
cd /opt/gladiator-v2/app
cp .env.example .env        # und echte Werte eintragen (nie committen)
docker compose up -d        # TimescaleDB :5433, Redis :6380 (nur localhost)
npm ci
npm run db:migrate
npm run db:seed             # braucht packages/db/seed/data/*.json (per scp, nicht im Repo)
npm run ci                  # Lint + Typecheck + Tests
```

## Deploy (GitHub → Server)

`main` auf GitHub wird vom Server automatisch übernommen (`deploy/github-sync.sh`, Timer alle 2 min):
Fast-Forward ins Server-Repo → bestehender post-receive-Hook → CI (`scripts/ci.sh`) → Neustart nur bei Grün.
Einmalige Einrichtung (als root): `bash /opt/gladiator-v2/app/deploy/install-github-sync.sh` — findet das
Server-Repo selbst (Hook mit `scripts/ci.sh`); bei privatem GitHub-Repo den ausgegebenen Key als **read-only**
Deploy-Key eintragen. Danach nur noch nach GitHub pushen.

## Navigation (Frontend)

Alle Seiten, Tabs, Beschreibungen und Suchbegriffe stehen in `apps/web/src/lib/navigation.ts`.
Sidebar, ⌘K-Suche, Brotkrumen, „Alle Funktionen“ und Weiterleitungen alter Links lesen daraus —
eine neue Seite wird dort eingetragen (plus View in `App.tsx`, typgeprüft) und ist überall auffindbar.

## Struktur

| Pfad | Inhalt |
|---|---|
| `packages/core` | Geteilte Typen + Zod-Schemas (kanonisches Signal-Modell) |
| `packages/db` | Drizzle-Schema (Postgres/Timescale), Migrationen, Seed |
| `packages/market-data` … `packages/jobs`, `packages/ml` | Marktdaten, Strategie-Engine, Börsen, Risk, Agenten, Backtest, API, Jobs, ML |
| `apps/web` | Frontend (React/Vite, Design-System „Blue Matrix Premium“) |
| `services/quant` | optionaler Python-Backtest-Service — Phase 3 |

## Regeln

Siehe `CLAUDE.md` (eiserne Regeln: kein Fake, Sicherheit zuerst, Paper-Default, TDD, eine Wahrheit, Mensch im Loop). Fortschritt und Abweichungen: `PROGRESS.md` im übergeordneten v1-Projektordner.
