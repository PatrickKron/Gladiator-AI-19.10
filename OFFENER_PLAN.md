# Gladiator AI v2 — Offener Plan (Übergabe, Stand 2026-10-19)

> **Jede neue Claude-Code-Sitzung liest zuerst:** `CLAUDE.md` → diese Datei → `WORKOVER.md` (Arbeitsprotokoll Sessions 1–9) → bei Bedarf `PROGRESS.md` (Phasen-Historie) und `GLADIATOR_V2_BLUEPRINT/` (verbindliche Spezifikation).
> Nach jedem erledigten Punkt: hier abhaken (`[x]` + Commit-Hash) und einen kurzen Abschnitt in `WORKOVER.md` ergänzen.

## Zugänge & Betrieb (was eine neue Sitzung wissen muss)

| Was | Wo |
|---|---|
| Code (Quelle) | GitHub `PatrickKron/Gladiator-AI-19.10`, Branch `main` (Remote `origin`) |
| Live-Server | Hetzner `95.216.10.238`, App unter `/opt/gladiator-v2/app`, systemd-Dienst `gladiator` (+ Worker-Dienst) |
| Deploy | `git push server main` (Remote `server` = `ssh://root@95.216.10.238/opt/gladiator-v2/app`) → post-receive-Hook → `scripts/ci.sh` → Neustart NUR bei grüner CI |
| App im Browser | `http://100.72.94.1:3010` (nur über Tailscale; öffentlicher Port bewusst NICHT gebunden) |
| DB / Redis | Container `gladiator-postgres` (127.0.0.1:5433), `gladiator-redis` (127.0.0.1:6380) — Ports 5432/6379 gehören CHAMÆLIEN: niemals anfassen |
| Secrets | NIE ins Repo. Pflicht-Secrets in `/opt/gladiator-v2/app/.env` (Server); Betriebs-Keys pflegt Patrick in der App unter Einstellungen → API-Keys (Vault, AES-256-GCM) |

**Wichtig für Cloud-Sitzungen (aus GitHub geklont):** Dort gibt es weder SSH-Zugang zu Hetzner noch Tailscale. Dann: Code ändern, lokal testen (`npm ci && npm run lint && npm run typecheck && npm test`), auf einem Branch nach GitHub pushen — das **Deploy** (`git pull origin main && git push server main`) macht danach eine lokale Sitzung auf Patricks PC. DB-Integrationstests skippen ohne `DATABASE_URL`; maßgeblich ist die Server-CI.

**Nicht verhandelbar:** kein Fake (keine erfundenen Daten), TDD, Paper-Default, kein Live-Order-Pfad ohne Patricks ausdrückliche Freigabe pro Börse, keine Auszahlungs-/Transfer-Codepfade, der alte v1-Telegram-Token `7544725601:…` bleibt gesperrt, v1-Ordner außerhalb dieses Repos nie verändern.

## Live-Zustand bei Übergabe (2026-10-19)

- Server gesund (`/health` ok, Worker-Heartbeat aktiv, Preis-Feeds verbunden).
- **Deploy-Stand:** Server läuft auf `92f1133` (Stand vor Session 9). GitHub `main` enthält zusätzlich PR #1 (Session 9: Navigation neu, Trading-/ML-Fixes, Position schließen/SL-TP ändern, Trailing-Stop am Monitor, Live-Chart, Migration 0019) — **noch NICHT deployt**. Server-Stand ist Vorgänger von GitHub-main → reiner Fast-Forward möglich.
- **Keine Betriebs-Keys hinterlegt** (`app_secrets` leer), **keine Börse verbunden** (`exchange_connections` leer).
- Signale: 306 erzeugt — 304 `expired`, 2 `filled`. 3 Strategie-Versionen im Status `paper`.

## Stand nach Session 10/11 (2026-10-19, Cloud, PR #2 gemergt · PR #3 offen)

- PR #3 (`claude/focused-darwin-51s9k3`, **nicht gemergt**, wartet auf Patrick): Wallet nur lesend, Daten-Assistent (FRED), Börsen aus dem Chat, PWA, Signal-Lebenszyklus 05 §9, VDB1/VDB2, Nacht-Optimierung, DSL-Erweiterungen. Details `WORKOVER.md` Session 11.
- **Live-Order-Verdrahtung blockiert** durch die Sicherheitsfilterung der Cloud-Umgebung (trotz Patricks Go) → nur per Berechtigungsregel in Claude-Code-Einstellungen oder gemeinsam lokal. `CcxtLiveVenue` + Binance-Demo-Trading fertig, nicht verdrahtet.

## 1 · Patrick-Schritte (blockieren am meisten — Claude kann sie nicht erledigen)

- [ ] **Auto-Deploy GitHub → Server einmalig installieren** (`deploy/install-github-sync.sh` auf dem Server + read-only Deploy-Key bei GitHub eintragen). Bis dahin deployt eine lokale Sitzung: `git pull origin main && git push server main`. Damit geht auch PR #1 live.

- [ ] **ANTHROPIC_API_KEY** in Einstellungen → API-Keys → schaltet Pine-Analyse, Workshop-Dialog, Text→Strategie, Makro-/Shadow-Agent, Signal-Erklärung frei.
- [ ] **Neuer Telegram-Bot** (BotFather) → `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` → Signal-/Preis-/Kill-Switch-Alarme + Morgen-Briefing aufs Handy.
- [ ] **Alt-Secrets aus v1 widerrufen** (Telegram-Token, OpenAI `sk-proj-…`, OKX-Keys), danach `backend-node/.env` im v1-Ordner löschen — einziger offener Punkt der Sicherheits-Checkliste (`SECURITY.md` #1).
- [ ] Optional: `HEALTHCHECKS_URL` (externer Dead-Man-Switch) · erste Börse unter Einstellungen → „Börse verbinden" (API-Key OHNE Withdraw-Recht).
- [ ] GitHub-Repo auf **privat** stellen (enthält Server-IP, Deploy-Skripte, Sicherheits-Doku — keine Secrets).

## 2 · Echtes Trading (der große Schritt)

- [ ] **Live-Order-Pfad** über den bestehenden CCXT-Router (`packages/exchange/src/connections.ts`, `pickConnectionForSymbol`): Live-Adapter → Testnet-E2E → grüne Reconciliation → Freigabe-Phrase `LIVE-FREIGABE <venue>` (`venue_approvals`) → Kleinst-Trade-Probe. **Erst nach Patricks ausdrücklicher Freigabe beginnen.** Voraussetzung: Punkt 1 (Börse verbunden).
- [x] Trailing-Stop am PositionMonitor + Position schließen/Teilschluss/SL-TP ändern (Session 9, PR #1).
- [x] **Trailing als Strategie-Exit** (Session 10, PR #2) in Backtest-Engine + DSL — dieselbe `trailStep`-Funktion aus `packages/exchange/src/trailing.ts` nutzen (sonst Backtest ≠ Live).
- [ ] **Default-Limits** (1 % Risiko + 20 % Exposure) blocken Stops < 5 % → hebelbewusste Exposure oder klarer Hinweis im Ticket.
- [x] Backtest-Stops gap-realistisch + Robustheits-Gate (jüngste 30 %) (Session 10, PR #2); Walk-Forward mit Trailing/Funding/Warmup (PR #3).
- [ ] **Orderbuch-Ansicht** (braucht Depth-Streaming, z. B. ccxt.pro `watchOrderBook`).
- [x] **Reentry-/Hebel-Upgrade-Engine + Auto-Kill** (Blueprint `05_` §9) — PR #3; Hebel-Upgrade nur als Vorschlag.
- [x] Wallet-Anschluss nur lesend (Hyperliquid/Paradex/Derive/Aftermath) — PR #3. Offen: eigenes Wallet, dYdX/Lighter.

## 3 · Signale, die auch genutzt werden

- [x] **304 von 306 Signalen sind unbearbeitet abgelaufen.** Ursache: Engine-Signale werden nur per Bestätigung durch Patrick oder durch seine Agenten ausgeführt (Mensch im Loop, gewollt); ohne Telegram-Benachrichtigung sieht er sie nicht, die Frist (15m 4 h · 1h 12 h · 4h 48 h · 1d 120 h) läuft ab. „Was wäre passiert" gebaut (Session 12): Signale › aufklappbares Panel, abgelaufene Signale mit derselben Backtest-Engine auf den echten Kerzen danach nachgerechnet, netto, hypothetisch markiert. Hebel für mehr genutzte Signale bleibt Punkt 1 (Telegram-Bot).
- [ ] **Strategie-Katalog:** Aktivierung braucht ≥ 250 echte Kerzen je Symbol/Timeframe — 15m-Historie für Scalp-Presets ggf. nachfüllen.

- [x] Nacht-Optimierung → Vorschlag (08 §5) und VDB1/VDB2-Erfahrungsvorschlag im Ticket (13) — PR #3.
- [x] Handy-Nutzung: PWA + `deploy/MOBILE.md` (`tailscale serve`, einmalig auf dem Server ausführen) — PR #3.

## 4 · Oberfläche — Wellen 3–5 des UI-Konzepts (erst nach Patricks Feedback)

> Session 9 hat die Navigation bereits neu geordnet (5 Bereiche: Heute · Markt · Handel & Vermögen · Agenten & Strategien · System, Seite „Marktlage“, Demo-Konto unter #/demo). Wellen darauf aufbauen, nicht dagegen.

- [ ] Welle 3: Traden vereinheitlichen (eine Seite mit Konto-Schalter, Einsteiger-Ticket).
- [ ] Welle 4: Markt-Bühne (Chart + Watchlist-Seitenleiste + Docks, Tastatur-Navigation).
- [ ] Welle 5: Strategien + Workshop zusammenführen, Vorlagen-Galerie, Hotkeys, Reset-Knopf.

## 5 · Aufräumen & Technik

- [ ] Positions-Monitor in eigene Queue (läuft hinter RL/ML-Jobs).
- [ ] CI gegen eigene Test-DB statt Live-DB.
- [ ] Auto-Login absichern (Rate-Limit, Host-Allowlist) + echtes Passwort.
- [ ] Chart: Zeichenwerkzeuge, Upgrade lightweight-charts v5, Jesse-artige Trade-Ansicht.

- [ ] `apps/web/src/views/Labor.tsx`: Binnentexte auf i18n (5 Sprachen, Paritätstest) und lokale Chart-Kopien auf `components/EquityChart.tsx` umstellen.
- [ ] Workshop-Antworten streamen (SSE statt Ein-Turn-Antwort).
- [x] Command-Palette/Navigation: Funktions-Registry `apps/web/src/lib/navigation.ts` (Session 9).
- [ ] MacroPanels-Footprint-Slot auf `getCotSnapshot` umstellen.
- [ ] On-Chain-Quelle (DNA-Quadrant) — bleibt ehrlich „nicht verbunden", bis es eine freie, zuverlässige Quelle gibt.

## Empfohlene Reihenfolge

1 (Auto-Deploy + Patricks Keys) → 3 (Signale kommen an und werden ausgewertet) → 2 (Live-Order-Pfad, nach Freigabe) → 4/5.
Patrick hat zusätzlich GitHub-Repos angekündigt, die helfen sollen — vor dem Einbau prüfen, welchem Punkt sie dienen (v. a. 2, Orderbuch, Welle 4).
