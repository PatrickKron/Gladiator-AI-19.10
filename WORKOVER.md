# GLADIATOR AI v2 — FRONTEND WORKOVER (Tracking)

> Persistentes Tracking-Dokument. Jede Session liest diese Datei zuerst und arbeitet die offenen Punkte ab.
> Regeln: additiv, kein Fake, TDD, 598 Bestandstests dürfen nicht breaken, i18n 5-sprachig (DE/EN/IT/ES/FR), Full CI vor Push.

**Start:** 2026-07-08 · **Session 1:** Fable-5
**Repo:** `C:\Users\Patrick\Antigravity Gladiator AI versuch 1\gladiator-v2` · Deploy: `git push server main` · Live: http://100.72.94.1:3010

## ⚠ Vorgefundener Zustand (NICHT anfassen)
- Uncommittete lokale Änderungen aus früherer Session = begonnene Worker-Prozess-Trennung (ROLE=web/worker):
  `packages/api/src/{app,start}.ts`, `packages/jobs/src/{index,worker}.ts`, `packages/jobs/package.json`, `package-lock.json`, neu `deploy/gladiator-worker.service`.
  → Bleiben unangetastet, werden NICHT mitcommittet (gezieltes `git add` nur eigener Dateien!).

## Phase 0 — Bestandsaufnahme
- [x] git fetch/status — Branch synchron mit server/main, Commit 4130338
- [x] Codebase-Map Frontend (views/components/api.ts)
- [x] Codebase-Map Backend (tRPC-Router — via Explore-Agent, Shapes live per curl verifiziert)
- [x] Browser-Durchgang (lokaler Vite-Dev :5199 gegen Live-API via VITE_PROXY_TARGET)
- [x] Konkreten Umsetzungsplan eingetragen (unten)

## Umsetzungsplan (konkret, Reihenfolge = Arbeitsreihenfolge)
1. `apps/web/src/lib/regime.ts` NEU: `normalizeRegime(raw)` (pure, getestet) + REGIME_COLORS/ICONS zentral → RegimeBadge nutzt es (Fix P0.1). Backend-Shape: top-level `{regime, confidence, components:[{name,score,detail}]}`, leer = `{regime:null, reason}`.
2. Backend `rl.agents`: `modelBlob` aus List-Response strippen (Frontend nutzt es nicht, riesiger Payload — verifiziert via grep).
3. RlAgents.tsx: echtes Error-Handling (Fehler-State + Anzeige statt stummer catch), alert() → Inline-Meldungen, Episode-Hinweis (läuft synchron, dauert), Empty/Error getrennt (P0.2, P1.8).
4. MlModels.tsx + Performance.tsx: Error-State getrennt von Empty, reichere Empty States (Label-Fortschritt X/30, Pipeline-Erklärung) (P1.7).
5. Intelligence Hub: `views/Intelligenz.tsx` NEU mit Tabs (ML-Modelle / RL-Agenten / Performance) via bestehender `tab-hash`-Lib; MlModels/RlAgents/Performance bekommen `embedded`-Prop (PageHeader aus); Routen `#/ml`, `#/rl-agenten`, `#/performance` → Redirect auf `#/intelligenz?tab=…` (bestehendes Redirect-Pattern); Sidebar "Intelligenz" 7→5 Einträge; CommandPalette anpassen (P0.3).
6. Dashboard: NEU Panel "KI-Status" (volle Breite, 3 Spalten: Markt-Regime BTC 1h / ML-Modell+Label-Fortschritt / RL-Agenten+bester Sharpe, alles echt + graceful) + Favoriten-Empty-State mit Link zu Pakete/Sterne-Erklärung + WatchCard-Bug: `initialFavorite` wird für Fallback-Symbole (BTC/ETH/SOL) fälschlich immer true übergeben → Stern zeigt ★ obwohl kein Favorit (P0.4, P1.6).
7. i18n: alle neuen Keys in DE/EN/IT/ES/FR (catalog.test.ts erzwingt Parität).
8. vite.config.ts: Proxy-Target per env übersteuerbar (`VITE_PROXY_TARGET`) — für lokale Verifikation gegen Live-API.
9. Full CI + lokaler Browser-Durchgang (vite dev gegen Live-API) + Responsive-Check + Commit (NUR eigene Dateien!) + push + Live-Health.

## P0 — Sofort
- [x] 1. Regime-Badge: Wurzelursache `r.regime` (String) statt `r` (Objekt) → NEU `lib/regime.ts` `normalizeRegime()` (pure, 7 Tests) + RegimeBadge umgestellt. Browser-verifiziert: Badge zeigt "◆ Seitwärts" am Signal; bei `regime:null`/Fehler versteckt es sich.
- [x] 2. Agenten-Erstellung E2E: Backend via curl ✓, Formular via Browser ✓ ("Workover-UI-Test" erscheint sofort). Stummes catch{} → echte Fehleranzeige. **ZUSATZ: `rl.retireAgent`-Mutation + „Stilllegen"-Button** — vorher konnte kein Agent je gestoppt werden (jeder angelegte frisst 30-min-Episoden für immer; runRlEpisodes nimmt nur paper/sandbox).
- [x] 3. Sidebar: Intelligenz-Gruppe 7→5. NEU `views/Intelligenz.tsx` (Hub mit Tabs ML/RL/Performance, tab-hash-Pattern wie AssetDetail); die 3 Views bekamen `embedded`-Prop; Alt-Routen `#/ml`, `#/rl-agenten`, `#/performance` redirecten auf `#/intelligenz?tab=…`. Browser-verifiziert inkl. Redirect.
- [x] 4. Favoriten: System funktioniert (Toggle-E2E: Stern → Watchlist zeigt nur Favorit ★ → Briefing zeigt echtes BTC-Live-Briefing → entfernt, Ursprungszustand wiederhergestellt). Empty-State jetzt mit Links → Pakete/Assets. **Bug gefixt:** WatchCard übergab `initialFavorite` immer true → Fallback-Symbole (BTC/ETH/SOL) zeigten fälschlich ★.
- [x] 5. Signal-Cards: RegimeBadge gefixt (1.), MlBadge versteckt sich korrekt bei fehlender Prediction (verifiziert), Kopfzeile flex-wrap für Mobile.

## P1 — User Experience
- [x] 6. Dashboard NEU "KI-Status"-Panel: Markt-Regime (BTC 1h, live: ◆ Seitwärts 90 %), ML-Stand (aktives Modell ODER Label-Fortschritt x/30), RL-Agenten (Anzahl, Live-Count, bester Sharpe), Link → Hub. Jede Spalte lädt unabhängig und fällt einzeln graceful zurück.
- [x] 7. Empty States: ML-Tab Fortschrittsbalken 0/30 + Pipeline-Erklärung; rl.noAgentsHint; perf.noDataHint; Agent ohne Episoden → noPerformanceHint.
- [x] 8. Error Handling: loadError-State + ErrorBox in RlAgents/MlModels/Performance (Fehler ≠ leerer Zustand), alert() → Inline-Meldungen, Episode-Button mit ehrlichem Server-Last-Hinweis (~10–30 s).

## P2 — Polish
- [x] 9. i18n: alle neuen Keys (nav.intelligence, hub.*, dashboard.ai*, ml.loadError/labelProgress*, rl.loadError/retire*/episodeHint/…, perf.loadError/noDataHint) in DE/EN/IT/ES/FR; catalog.test erzwingt Parität — grün. `{{n}}` statt `{{count}}` (i18next-Plural-Falle bewusst umgangen).
- [x] 10. Loading States: Loading-Komponente überall, KI-Status-Panel mit Lade-Puls je Spalte.
- [x] 11. Responsive Mobile 375px: Overflow gefunden+gefixt (SignalCard-Kopf, Topbar, RL-Agentenkarten → flex-wrap). Dashboard/Hub(3 Tabs)/Signale scrollWidth=375 verifiziert.

## Abschluss
- [x] Full CI: lint ✓ · typecheck ✓ · Tests 605 passed (598 Bestand + 7 neue regime.test) ✓ · build:web ✓
- [x] Commit e319a45 (nur eigene 19 Dateien; Worker-Trennungs-Dateien unangetastet) + push server main — Server-CI GRUEN, Dienst neu gestartet
- [x] Live: /health ok (db up, Feeds connected) · Bundle index-cYn4_QxP.js = lokaler Build · modelBlob aus rl.agents-Response verschwunden · beide Test-Agenten via rl.retireAgent stillgelegt (alle 3 Agenten jetzt retired → keine 30-min-Episoden-Last mehr)

## Befunde (Phase 0)
1. **P0.1 Wurzelursache:** `ml.regime` liefert Regime-Daten TOP-LEVEL (`{regime:"sideways", confidence:0.898, components:[{name,score,detail}], ts, cached}`). `RegimeBadge.tsx:36` macht aber `setData(r.regime)` → nimmt den STRING → `data.regime`=undefined, `data.confidence`=NaN. Fix: `setData(r)` + null-Guard + Komponenten-Shape (`score`/`detail` statt `value`). i18n-Keys (regime.bull/bear/…) existieren in allen 5 Sprachen.
2. **P0.2:** Backend `rl.createAgent` funktioniert (E2E via curl getestet: Agent "Workover-E2E-Test" angelegt, erscheint in rl.agents). Formular-Problem = stummes `catch {}` — Fehler unsichtbar. Zudem: `rl.agents` liefert `modelBlob` (komplette PPO-Gewichte!) mit → riesiger Payload, Frontend nutzt es nicht.
3. **P0.4:** `product.favorites` ist live LEER (Patrick hat nichts markiert) — Empty State korrekt. Favoriten-Endpoints existieren (toggleFavorite, toggleFavoriteBySymbol, favoriteSymbols). E2E-Toggle-Test steht aus.
4. Live-Zustand ML/RL: modelMetrics=[], labelStats total=0, portfolioWeights=[], perfDashboard metrics=null → alle neuen Seiten zeigen aktuell Empty States (vorhanden, aber karg).
5. Fehler-Pattern überall in MlModels/RlAgents/Performance: `catch → setX([])` — API-Fehler unsichtbar als "leer" getarnt. Kein ErrorBox-Einsatz.
6. RlAgents nutzt `alert()`/`window.confirm()` — bricht Designsprache.
7. `rl.runEpisode` blockiert lt. Memory den Webserver ~20 s/Episode (Worker-Trennung offen) — UI sollte das ehrlich sagen, Button vorsichtig behandeln.

## Offen für Folge-Sessions (Session 2)
- Trailing-Stop: gemeinsam in Engine + PositionMonitor einführen (dann DSL-Exit-Feld ergänzen) — Backtest-only wäre Fake, darum in v1 weggelassen.
- Labor.tsx: lokale EquityChart/MultiEquityChart/MetricCard-Kopien auf components/EquityChart.tsx umstellen (bewusst nicht in dieser Session — chirurgisch bleiben).
- Workshop: Chat-Antworten sind ein Turn (kein Streaming — Vanilla-tRPC ohne Subscription-Link); bei Bedarf SSE-Endpoint.
- dslPreview/Workshop-Analyse teilen sich das Tagesbudget (LLM_DAILY_BUDGET_USD, Default 5 USD/Tag, In-Memory je Prozess).

## Offen für Folge-Sessions (Session 1)
- Worker-Prozess-Trennung (ROLE=web/worker) fertigstellen+committen — Dateien liegen uncommitted im Tree (fremde Session); mein einziger Eingriff dort: worker.ts IORedis-Import auf `import { Redis }` gefixt (Typfehler blockierte typecheck).
- `#/rl-agenten` etc. sind redirects; falls je ein Deep-Link mit Query auf Alt-Routen existiert, geht nur der Tab-Teil verloren (unkritisch).
- Wenn erste Labels/Modelle/Snapshots entstehen: KI-Status-Panel + Hub zeigen sie automatisch — kein weiterer Umbau nötig.
- Screenshot via preview_screenshot timeoutet (MatrixRain-Canvas?) — Verifikation lief über DOM-Snapshots/evals.

---

# SESSION 2 — Strategie-Workshop (Pine → KI-Dialog → Agent → Backtest → Version → Paper-Deploy)

**Start:** 2026-07-08 · **Session 2:** Fable-5 · Worker-Trennungs-Dateien weiterhin unangetastet (gezieltes git add!).

## Auftrag
Interaktiver Strategie-Workshop: (1) Pine-Script-Eingabe + KI-Analyse (Indikatoren/Entry/Exit/Typ/Parameter), (2) Chat-Dialog zur Umsetzungsplanung, (3) eigene Agent-Konfiguration (Asset/TF/Regeln/Risk, alles editierbar), (4) Backtest-Integration inkl. Parameter-Set-Vergleich, (5) Versionierung + Paper-Deploy.

## Architektur-Entscheidungen (nach Bestandsaufnahme)
1. **Strategie-Repräsentation = InstructionDsl, additiv erweitert** — gleiche Engine, gleiche Wahrheit wie Strategien/Labor/dsl-scan. Neu: Bedingungen `maCross` (EMA/SMA golden/death), `priceVs` (EMA/SMA above/below), `macd` (cross/histogram), `bollinger` (close vs. Band), `stochastic` (K-Level + Cross), `adx` (gt/lt), `supertrend` (direction), RSI bekommt optionales `period`. Timeframe-Enum 4→10 (= SUPPORTED_TIMEFRAMES). Alles Superset — bestehende gespeicherte DSLs bleiben gültig; dsl-scan läuft unverändert (nutzt dsl.timeframe).
2. **Kein Trailing-Stop in v1 (bewusst, kein Fake):** Live-Ausführung (PositionMonitor) kann nur statische SL/TP + Break-Even — ein nur im Backtest simuliertes Trailing wäre eine unehrliche Backtest↔Paper-Divergenz. UI sagt das ehrlich. → Folge-Session: Trailing in PositionMonitor UND Engine gemeinsam.
3. **LLM-Wiederverwendung:** `envAnthropicProvider()` + `guardedComplete()` + `CostGuard` (Key kommt AES-256-GCM-entschlüsselt aus app_secrets → process.env, Modell claude-opus-4-8). Pine-Analyse liefert Zod-validiertes Struktur-JSON; Chat-Turns liefern Text + optionalen DSL-Vorschlag (```json-Fence → parseInstructionDsl). Ohne Key: PRECONDITION_FAILED mit Klartext. LLM schaltet NIE scharf.
4. **DB additiv (Migration 0015):** `workshop_sessions` (pine_source, analysis, draft_dsl, instructions, strategy_id-Link), `workshop_messages` (Dialog), `workshop_backtests` (Draft-Läufe: dsl+metrics+equity+trades für Parameter-Vergleich). Bestehende Tabellen unangetastet.
5. **Backtest zweistufig:** Draft-Backtests laufen inline (getOhlcv → runBacktest mit evaluateDslAt) → workshop_backtests (VDB-Studientabellen bleiben sauber). Nach „Als Version speichern" (strategies kind=dsl + strategy_versions status=draft) läuft der offizielle Labor-Backtest (runLabBacktest → backtests) → **Deploy = bestehendes strategies.promote-Gate** (Validitäts-Gate, Mensch im Loop) → paper → dsl-scan erzeugt Signale.
6. **Frontend:** neue View `Workshop` (#/strategie-workshop, Sidebar groupIntel), Chat-Komponente neu (.glass/.field), Config-Editor mit ALLEN DSL-Feldern editierbar, EquityChart/MultiEquityChart-Muster aus Labor für Kurve + Vergleich. i18n-Namespace `sw.*` (workshop.* ist von Werkstatt belegt!), `{{n}}`-Konvention.
7. **DSL_SYSTEM_PROMPT in strategies.ts** wird auf die erweiterte DSL nachgezogen (eine Schema-Doku-Konstante, geteilt).

## Arbeitsreihenfolge
- [x] 1. strategy-engine: DSL-Erweiterung — 7 neue Bedingungstypen (maCross/priceVs/macd/bollinger/stochastic/adx/supertrend), RSI-period, TF 4→10, when.all max 10, `crossedWithin`-Helfer, `dsl-doc.ts` (DSL_SCHEMA_DOC/DSL_LIMITS_DOC als eine Prompt-Wahrheit). 31 dsl-Tests (13 Bestand + 18 neu). RSI-period bewusst `.optional()` statt `.default()` (Ausgabetyp-Kompatibilität für Bestands-Literale).
- [x] 2. db: schema/workshop.ts (workshop_sessions/-messages/-backtests) + Migration 0015. ⚠ drizzle-generate emittierte auch die 0014-Tabellen erneut (0014 ist hand-geschrieben ohne Snapshot) → 0015-SQL hand-bereinigt auf NUR Workshop-Tabellen, alles idempotent (IF NOT EXISTS + DO-$$-Guards); 0015-Snapshot behält die 0014-Tabellen, damit künftige generates sauber sind.
- [x] 3. api: workshop/llm.ts (Analyse+Chat: pure Prompt/Parse-Helfer, 15 Tests mit Fake-Provider) + routers/workshop.ts (list/get/create/update/remove/analyze/chat/applyProposal/updateDraft/runBacktest/backtests/backtestTrades/saveVersion/versions/restoreVersion) + workshop.test.ts (DB-Integration, läuft auf Server-CI). strategies.ts DSL_SYSTEM_PROMPT auf DSL_SCHEMA_DOC umgestellt (dslPreview kennt die neuen Bedingungen). Deploy-Weg bewusst über BESTEHENDE Pfade: saveVersion→draft, lab.runBacktest(strategyId)→backtests, strategies.promote→Gate→paper→dsl-scan.
- [x] 4. web: views/Workshop.tsx (#/strategie-workshop, Sidebar groupIntel `nav.strategyWorkshop` — nav.workshop war Werkstatt!) — Pine-Textarea+Analyse-Ansicht, Chat (neu, kein Bestand), Config-Editor ALLE Felder (Form+JSON-Modus), Backtest mit Symbol/TF-Override + Parameter-Set-Vergleich (MultiEquityChart), Versionen+Gate-Deploy. components/EquityChart.tsx als geteilter Baustein (Labor-Kopien bewusst NICHT angefasst — additiv; Zusammenführung siehe Offen).
- [x] 5. i18n ×5: Namespace `sw.*` (~100 Keys) + nav.strategyWorkshop in DE/EN/IT/ES/FR, {{n}}-Konvention, catalog-Paritätstest grün.
- [x] 6. Full CI lokal grün (lint ✓ typecheck ✓ 638 Tests ✓ build:web ✓) — zusätzlich mit weggestashten fremden Worker-Dateien verifiziert (committeter Stand = grün). Browser-Verify erfolgt NACH dem Push (workshop-Router existiert erst nach Deploy auf der Live-API).

## Log
- 2026-07-08: Session 2 (Strategie-Workshop) — Bestandsaufnahme via 2 Explore-Agenten + eigene Kernfile-Reads, Plan fixiert, DSL-Erweiterung + Schema 0015 + workshop-Router + LLM-Schicht + View + i18n gebaut. Full CI grün (auch auf committetem Stand ohne fremde Worker-Dateien). Commit + push → Server-CI deployt (Migration läuft dort), danach Browser-Live-Verifikation.
- 2026-07-08: Session 1 gestartet. git fetch ok. Worker-Trennungs-Änderungen unangetastet vorgefunden. Struktur: apps/web (Views: Dashboard, Signals, RlAgents, MlModels, Performance, Labor, Strategien, Werkstatt, Agenten, …), packages/{api,ml,agents,…}.
- 2026-07-08: Kernfiles gelesen (App, api, Shell, RegimeBadge, MlBadge, SignalCard, Dashboard, RlAgents, MlModels, Performance, FavStar, ui, i18n/de). Live-API inspiziert (Shapes verifiziert). Test-Agent "Workover-E2E-Test" (paper) in Prod-DB angelegt — nach Browser-Verify wieder entfernen falls Delete-Endpoint existiert, sonst behalten (harmlos, paper).
- 2026-07-08: Session 1 ABGESCHLOSSEN. Alle P0/P1/P2-Punkte umgesetzt+verifiziert. Commit e319a45 deployed, Live-Checks gruen.
