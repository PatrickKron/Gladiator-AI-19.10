# Hinweis für KI-Agenten (Antigravity, Claude Code u. a.)

Verbindliche Arbeitsanweisung: **`CLAUDE.md`** (Repo-Root). Einstieg für die Fortsetzung auf Patricks Rechner: **`UEBERGABE_ANTIGRAVITY.md`**, danach `OFFENER_PLAN.md`.

Kurzfassung der wichtigsten Regeln: kein Fake (nur echte Daten oder ehrlich „nicht verbunden“), TDD, Paper-Default, Risk-Engine als hartes Gate, keine Auszahlungen/Transfers, nichts Funktionierendes beschädigen. Änderungen nur über einen Branch und einen Pull Request nach GitHub `main` — der Server übernimmt `main` automatisch (nie direkt auf den Server pushen).

## Weitermachen mit einem anderen Modell (z. B. Gemini 4 Hydrogen im Antigravity-Agenten)

Stand 2026-11-26: Wellen 1–27 (bis PR #131, `f02af4d`) sind auf `main` gemergt und live auf dem Hetzner-Server (`95.216.10.238`) ausgerollt; Welle 28 (`feat/welle-28-self-custody-vermoegen-und-worker`: Self-Custody-Wallets in `#/vermoegen`, autonomer On-Chain-Eingangswächter, Solana-SPL/Multi-RPC & Spot-Börsenvergleich) ist in Arbeit.

So arbeiten, egal welches Modell:
1. Lesen: `CLAUDE.md` → `UEBERGABE_ANTIGRAVITY.md` → `OFFENER_PLAN.md` → das Ende von `WORKOVER.md`.
2. Jede Welle auf einem eigenen Branch `feat/welle-<n>-<thema>`, Tests zuerst (`npm run lint && npm run typecheck && npm test`), dann committen und pushen.
3. Nie direkt auf `main` pushen, nie `--force`, nie `git reset --hard`. `main` ändert sich nur über einen Pull Request, weil der Server `main` automatisch ausrollt.
4. Nach jedem Punkt: in `OFFENER_PLAN.md` abhaken (`[x]` + Commit-Hash) und kurz in `WORKOVER.md` festhalten, damit das nächste Modell nahtlos weitermacht.
5. Keine Secrets ins Repo, `.env` nicht auslesen oder ändern.
