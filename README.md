# Gladiator AI v2

KI-gestützte Trading-Agenten-Plattform — kompletter Neuaufbau nach der Spezifikation in `GLADIATOR_V2_BLUEPRINT/`.

**Status:** Phase 0a (Fundament). Es existiert noch keine lauffähige App — nur Monorepo-Gerüst, DB-Schema und Seed.

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

## Struktur

| Pfad | Inhalt |
|---|---|
| `packages/core` | Geteilte Typen + Zod-Schemas (kanonisches Signal-Modell) |
| `packages/db` | Drizzle-Schema (Postgres/Timescale), Migrationen, Seed |
| `packages/market-data` … `packages/jobs` | Skelette, werden in Phasen 1–5 gebaut |
| `apps/web` | Frontend — erst Phase 6, nach Design-Abnahme |
| `services/quant` | optionaler Python-Backtest-Service — Phase 3 |

## Regeln

Siehe `CLAUDE.md` (eiserne Regeln: kein Fake, Sicherheit zuerst, Paper-Default, TDD, eine Wahrheit, Mensch im Loop). Fortschritt und Abweichungen: `PROGRESS.md` im übergeordneten v1-Projektordner.
