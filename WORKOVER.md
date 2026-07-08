# GLADIATOR AI v2 — FRONTEND WORKOVER (Tracking)

> Persistentes Tracking-Dokument. Jede Session liest diese Datei zuerst und arbeitet die offenen Punkte ab.
> Regeln: additiv, kein Fake, TDD, 598 Bestandstests dürfen nicht breaken, i18n 5-sprachig (DE/EN/IT/ES/FR), Full CI vor Push.

**Start:** 2026-07-08 · **Session 1:** Fable-5
**Repo:** `C:\Users\Patrick\Antigravity Gladiator AI versuch 1\gladiator-v2` · Deploy: `git push server main` · Live: http://100.72.94.1:3010

## ⚠ Vorgefundener Zustand (NICHT anfassen)
- Uncommittete lokale Änderungen aus früherer Session = begonnene Worker-Prozess-Trennung (ROLE=web/worker):
  `packages/api/src/{app,start}.ts`, `packages/jobs/src/{index,worker}.ts`, `packages/jobs/package.json`, `package-lock.json`, neu `deploy/gladiator-worker.service`.
  → Bleiben unangetastet, werden NICHT mitcommittet (gezieltes `git add` nur eigener Dateien!).
  → **ERLEDIGT in Session 4 (2026-07-08):** kritisch geprüft, fertiggestellt, committet (3057a23) und live installiert — siehe Session-4-Abschnitt unten.

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

## Abschluss Session 2
- [x] Commit 313db8e (25 eigene Dateien; Worker-Trennung unangetastet) + push server main — Server-CI GRUEN: Migration 0015 auf Live-DB angewendet, workshop.test.ts (9 DB-Integrationstests) + llm.test.ts (15) auf dem Server grün, Dienst neu gestartet.
- [x] Live-Browser-Verifikation (Vite :5199 → Live-API, frischer Logout→Login als admin@): Sidebar+Route ✓ · Sitzung angelegt ✓ · Pine eingefügt+gespeichert ✓ · **Analyse ohne Key → ehrliche 412-Meldung inline** („ANTHROPIC_API_KEY fehlt — Profil → API-Keys") ✓ · Entwurf-Editor speichern+Validierung ✓ · Bedingungs-Typwechsel auf ADX (NEUE DSL-Bedingung live ausgewertet) ✓ · **2 echte Backtests** (BTC/USDT@1h, 180 T: 78 Trades/−13,5 % vs. mit ADX-Filter 69 Trades/−11,9 % — echte Netto-Zahlen) ✓ · Vergleichstabelle + 2-Kurven-Overlay ✓ · Version 1 (draft) gespeichert ✓ · Gate ehrlich: „kein offizieller Backtest" + „→ Paper" disabled ✓ · Mobile 375px kein Overflow ✓ · Konsole sauber ✓ · /health ok.
- ⚠ **Patrick-Action: ANTHROPIC_API_KEY fehlt auf dem Gladiator-Server** (Profil → API-Keys einfügen) — erst dann laufen Pine-Analyse + Workshop-Dialog live (Logik per Fake-Provider-Tests abgedeckt; Key-Test-Endpoint existiert in secrets.test).
- Demo-Artefakte bewusst belassen: Workshop-Sitzung „RSI-Dip Workshop-Verifikation" (2 Backtests, Version 1) + Strategie `workshop-strategie` (Status draft, inert — dsl-scan scannt nur paper).
- preview_screenshot timeoutet weiterhin (MatrixRain, bekannt) — Verifikation via DOM-Snapshots.

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

# SESSION 3 — KI-Trading-Intelligence-Layer (Goal-Ergänzungs-PDF: CPI/FRED + COT/CFTC + Buffett + Signalobjekt)

**Start:** 2026-07-08 · **Session 3:** Fable-5 · Quelle: `Goal_Ergaenzung_zu_Gladiator_AI.pdf` (finales One-Source-of-Truth-Dokument) · Worker-Trennungs-Dateien weiterhin unangetastet (gezieltes git add!).

## Auftrag (aus dem PDF)
Ergänzende KI-Trading-Intelligence-Layer: technische Marktstruktur + Makro (CPI als Event-Regime, §5) + COT-Positionierung (CFTC, §6) + Bewertungsfilter (Warren-Buffett-Indikator, §7) + Risk-First (§9) + Hedging-/No-Trade-Logik als sichtbare Entscheidungskategorie (§10) + standardisiertes Signalobjekt (§11). BTC/USDT nur Beispielmarkt (markiert!), Logik multi-asset-übertragbar. No-Trade ist gültiges Ergebnis. LLM darf erklären, harte Regeln deterministisch (§14).

## Bestandsaufnahme — was das PDF fordert vs. was existiert
| PDF-Baustein | Status im Code |
|---|---|
| Multi-Agenten-System (§4) | ✅ existiert: `agents/src/swarm.ts` (technik/risk/devil deterministisch + makro/shadow LLM, data-gated) → `signal_reviews` → SignalCard |
| Market Regime Agent | ✅ `ml/src/regime.ts` (bull/bear/sideways/high_vol/crisis) + 15-min-Cache + Job |
| CPI-Kalender + No-Trade-Fenster | ✅ ForexFactory-Feed → `economic_events` (echte Termine+Forecast), `event-impact.ts` (cat cpi), `risk/no-trade.ts` (±30min) |
| CPI-Event-Statusmaschine (§5: pre_event/release_window/post_event/confirmed_reaction) | ❌ NEU |
| CPI-Ist-Werte (actual vs. forecast) | ❌ NEU → FRED CPIAUCSL/CPILFESL (`economic_events.actual` war immer leer) |
| COT/CFTC (§6) | ❌ NEU (0 Code-Treffer; UI-Slot „COT folgt" in MacroPanels existiert) |
| Buffett-Indikator (§7) | ❌ NEU (⚠ Wilshire wurde Juni 2024 aus FRED entfernt → Fed-Z.1 `NCBEILQ027S`/`GDP`, beide leben) |
| Risk Engine hart (§9/§14) | ✅ `packages/risk` (Sizing, Gates, Kill-Switch) — bleibt unangetastet, KI schaltet NIE scharf |
| Hedge-Mode-Klassifikation (§10) | ❌ NEU (nur Empfehlung/Anzeige; Ausführung erst nach Paper-Phase lt. §13.9) |
| Standardisiertes Signalobjekt (§11) | ❌ NEU als `intelligence_assessments` (score_components, risk_class, hedge_mode, final_decision, …) |
| Post-Trade-Learning (§13.8) | ✅ weitgehend: self-improve-Pipeline, truth-core, ml-auto-label, perf-snapshots |

## Architektur-Entscheidungen
1. **Datenadapter in `packages/market-data`**: NEU `cftc.ts` (Socrata publicreporting.cftc.gov, Dataset 6dca-aqww Legacy Futures Only, KEIN Key nötig — live verifiziert, letzter Report 2026-06-30). Markt-Mapping verifiziert: BTC=133741, ETH=146021, Gold=088691, Silber=084691, WTI=067651, E-mini S&P=13874A, Nasdaq Mini=209742, EUR FX=099741. FRED-Erweiterung in `macro.ts`: `syncFredSeries` zusätzlich CPIAUCSL, CPILFESL, GDP, NCBEILQ027S (Key-gated wie bisher; Key aus app_secrets-Vault ODER env — `FRED_API_KEY` ist bereits whitelisted; live ist KEIN Key gesetzt → ehrliche NotConnected-Zustände, Patrick-Action unten).
2. **DB additiv (Migration 0016)**: NEU `cot_reports` (unique market_code+report_date) + `intelligence_assessments` (Signalobjekt §11 + inputs-Audit-JSONB). FRED-Beobachtungen gehen in BESTEHENDE `macro_series`. Drizzle-generate diffed gegen 0015-Snapshot (kennt 0014-Tabellen) → sauber; alles IF NOT EXISTS.
3. **Deterministische Engine, LLM nur Erklärung (§14)**: pure, TDD-getestete Module — `market-data/src/cot-metrics.ts` (Netto-Positionierung Non-Commercials, Perzentil über Historie → neutral/crowded_long/crowded_short/contrarian_alert), `market-data/src/buffett.ts` (Ratio + z-Score über Gesamthistorie → neutral/elevated/extreme), `agents/src/cpi-status.ts` (Phasenmaschine aus echten `economic_events`-Terminen + FRED-Actuals), `agents/src/intelligence.ts` (Aggregator → Signalobjekt: score_components, risk_class, position_size_mode, hedge_mode, final_decision; no_trade ist gültig). **explanation = strukturierte Reason-Codes**, Frontend übersetzt (i18n ×5 sauber statt LLM-Deutsch); optionale LLM-Freitext-Erklärung via guardedComplete (412 ohne Key, Tagesbudget geteilt).
4. **Swarm additiv erweitert**: neuer deterministischer Agent `institutional` (COT+Buffett, data-gated wie makro/shadow) in `swarm.ts` → erscheint automatisch in SwarmReviews auf SignalCards (AGENT_KEY + i18n ergänzen).
5. **Jobs**: `cot-sync` (12h, upsert; COT erscheint freitags 21:30 MEZ für Dienstag) in bestehende SCHEDULES; `macro-sync` (30min) deckt FRED-Serien mit ab. Kein neuer Assessment-Job — on-demand mit 15-min-DB-Cache (Muster ml.regime).
6. **tRPC NEU `intel`-Router**: `cotOverview`, `cpiStatus`, `buffett`, `assess({symbol})`, `history`. Ehrliche PRECONDITION_FAILED/NotConnected ohne Key/Daten.
7. **Frontend**: Intelligenz-Hub 4. Tab „Entscheidung" (`#/intelligenz?tab=intel`): CPI-Event-Status-Karte (Phase, Countdown, actual vs. forecast), Buffett-Gauge (SVG-Ring wie GRS), COT-Tabelle (Netto, WoW, Perzentil, Status-Pill), Assessment-Karte je Asset (BTC default, sichtbar als „Beispielmarkt" markiert, §12) mit Score-Komponenten-Balken, risk_class, hedge_mode, final_decision, Devil's-Advocate/Reasons. MacroPanels-Footprint: COT-Zeile echt befüllen (Slot „COT folgt"). i18n-Namespace `intel.*` ×5, {{n}}-Konvention.

## ⚠⚠ PARALLELE SESSION AKTIV (14:46+, live beobachtet)
Eine zweite Session implementiert GLEICHZEITIG am selben Tree (Dateien entstehen minütlich): `packages/core/src/intelligence.ts(+test)` (Zod-Signalobjekt §11), `packages/market-data/src/{cot,cpi,buffett}.ts(+tests)`, Änderungen an `core/{index,signal}.ts`. **Arbeitsteilung dieser Session (Claude Code), um Kollisionen zu vermeiden:**
- **Parallel-Session gehört (Hände weg):** packages/core, packages/market-data (cot/cpi/buffett), packages/db-Schema für `cot_reports` (ihr cot.ts referenziert es bereits), Jobs-Wiring.
- **Diese Session übernimmt:** apps/web (Hub-Tab „Entscheidung", MacroPanels-COT, SignalCard institutional) + i18n `intel.*` ×5 — gebaut gegen den Typ-Vertrag aus `core/intelligence.ts`. tRPC-Router `intel` NUR falls bei Reconcile-Zeitpunkt noch keiner existiert.
- Vor Full CI: Reconcile mit dem dann aktuellen Tree (git status, mtimes), NUR eigene Dateien committen.
- **🐛 BEFUND für Parallel-Session (live verifiziert 15:0x):** `buffett.ts` nutzt `WILL5000INDFC` als Zähler — Wilshire-Serien wurden Juni 2024 KOMPLETT aus FRED entfernt; fredgraph.csv liefert dafür nur noch eine HTML-Fehlerseite → parseFredCsv=[] → syncBuffett skipped → Indikator dauerhaft „nicht verbunden". Lebende, verifizierte Alternative: `NCBEILQ027S` (Corporate Equities, Mio. USD, quartalsweise bis Q1/2026) bzw. `BOGZ1LM893064105Q`; Ratio vs. GDP (Mrd.) → Faktor 1000 beachten (NCBEILQ027S/1000/GDP ≈ 2,29 ≈ GuruFocus 2,31 ✓). Perzentil-Klassifikation bleibt unverändert gültig. Wird beim Reconcile gefixt, falls bis dahin nicht geschehen.

## Arbeitsreihenfolge (angepasst an Parallel-Session)
- [x] 1.–4. Backend-Adapter → Parallel-Session lieferte: `market-data/{cot,cpi,buffett}.ts(+Tests)`, `core/intelligence.ts` (Zod §11) + `signals.intelligence`-Feld, `db/schema/intelligence.ts` (cot_reports, valuation_indicators, signal_intelligence, post_trade_reviews) + Migration 0016 (idempotent geprüft), `agents/{intelligence,post-trade}.ts` (institutional+hedge-Agent, decideHedge, finalDecision, Post-Trade-Learning), swarm-Integration, review.ts-Anreicherung (onConflictDoUpdate=idempotent geprüft), `api/routers/intelligence.ts` (cpiStatus/cotSnapshot/buffettStatus/signalIntelligence/postTradeReviews/sync*/runPostTradeLearning)
- [x] 5. web (diese Session): Hub-Tab „Entscheidung" (#/intelligenz?tab=intel, `views/Entscheidung.tsx`): CPI-Phasen-Karte, Buffett-Perzentil-Gauge, COT-Tabelle (6 Märkte), Hedge-Modi-Legende + No-Trade-Grundsatz, „Jetzt synchronisieren" (3 Quellen einzeln, ehrliche Teilfehler); i18n `intel.*` (~80 Keys) ×5, Paritätstest grün
- [x] 6. web (diese Session): SignalCard AGENT_KEY `institutional`+`hedge` + i18n ×5; NEU `IntelligenceSection` auf jeder SignalCard (lazy §11-Objekt: final_decision/hedge_mode/CPI/COT/Buffett-Pills, Score-Komponenten-Balken, Shadow-Warnung, Devil's Advocate, Erklärung; „noch nicht angereichert" ehrlich)
- [x] 7. api (diese Session): `intelligenceRouter` in routers/index.ts registriert (eigener intel.ts-Wrapper zugunsten des vollständigeren Parallel-Routers GELÖSCHT — Konvergenz statt Kollision)
- [x] **Reconcile-Fixes (diese Session):** (a) buffett.ts Zähler WILL5000INDFC→NCBEILQ027S + Faktor 1000 (Wilshire seit Juni 2024 tot — live verifiziert, Ratio ≈ 2,29 ✓); (b) syncBuffett schrieb nur 1 Punkt/Lauf → jetzt volle 20-Jahres-Quartalshistorie (deriveBuffettStatus braucht ≥8 Punkte fürs Perzentil, sonst 2 Jahre not_applicable); (c) Scheduler-Wiring fehlte komplett → `syncIntelligenceSources()` huckepack in `syncMacroSeries` (30-min-Job, 6-h-Drossel, je Quelle ehrlich isolierte Fehler) — bewusst OHNE worker.ts anzufassen (gehört der Worker-Trennung)
- [x] 8. Full CI lokal: lint ✓ · typecheck ✓ · **722 Tests passed** (62 DB-Tests → Server-CI) ✓ · build:web ✓ · Browser-Verify pre-deploy (Vite :5199): Tab rendert, Fehler-States ehrlich („No procedure found" gegen alte Live-API), SignalCard-Toggle ok, Konsole sauber

## ⚠ Patrick-Action
- KEINE! Live-Test ergab: fredgraph.csv (bestehender key-loser FRED-Weg) liefert auch CPIAUCSL/CPILFESL/GDP/NCBEILQ027S mit aktuellen Daten (Buffett-Ratio ≈ 229 % verifiziert ≈ GuruFocus 231 %). CFTC/Socrata braucht ebenfalls keinen Key. Der komplette Layer läuft ohne neuen API-Key. (`FRED_API_KEY` bleibt optional für die bestehende DFF-Zusatzserie.)

## Abschluss Session 3
- [x] Commit 64b2485 (36 Dateien, +10.482 Zeilen; Worker-Trennungs-Set weiterhin ausgeklammert: app.ts/start.ts/jobs-index/worker.ts/jobs-package.json/package-lock/gladiator-worker.service) + push server main — **Server-CI GRUEN**, Migration 0016 auf Live-DB, Dienst neu gestartet.
- [x] Live-Boot-Sync verifiziert: `[macro-sync] … CPI:333.979 COT:— BUFFETT:2.181 Fehler=0` — Live-DB: **6 COT-Märkte × 60 Wochen (Stand 30.06.2026), CPI 26 Monatspunkte, Buffett 79 Quartalspunkte (2006→Q1/2026)**.
- [x] Browser-Live-Verifikation (Vite :5199 → Live-API, frischer Logout→Login als admin@): Tab „Entscheidung" zeigt ECHTE Daten — CPI-Phase „Vor dem Event" (echtes Event 09.07. 03:30!), Inflation 4,2 % YoY, Buffett „Extrem"/Perzentil 96, COT-Tabelle (Gold 52,5 % Netto/OI crowded long, BTC-CME Perzentil 100, EUR Perzentil 3) ✓ · Sync-Button idempotent („CPI: 26 Punkte · COT: 0 neue · Buffett aktualisiert") ✓ · SignalCard-Intelligence ehrlich „noch keine Anreicherung" (Signal war pre-deploy; neue Signale reichert der Review-Job an, signal_intelligence-Upsert idempotent) ✓ · Mobile 375px kein Overflow ✓ · Konsole sauber ✓ · /health ok.
- Hinweis fürs COT-Design (bewusst so belassen, Parallel-Session-Entscheid): Status ist PERZENTIL-relativ zur eigenen Historie, nicht vorzeichenbasiert — E-mini S&P kann mit netto −37k „crowded long" sein, wenn −1,9 % Netto/OI im 98. Perzentil der eigenen 60-Wochen-Historie liegt.
- Offen für Folge-Sessions: MacroPanels-Footprint-Slot („COT folgt") auf getCotSnapshot umstellen; CommandPalette kennt nur Assets (kein Eintrag für den Hub-Tab); Post-Trade-Learning-UI (Router-Endpoint postTradeReviews existiert, keine View); optionale LLM-Freitext-Erklärung im Signalobjekt (explanationForUser wird bislang deterministisch/leer befüllt).

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

---

# SESSION 4 — Offene-Punkte-Abschluss (Audit local_a5101309 → „alles fertig, nur noch API-Key")

**Start:** 2026-07-08 · **Session 4:** Fable-5 · Commit 3057a23 + Doku. Auftrag: alle 7 offenen Audit-Punkte fixen, danach ist Patricks EINZIGE offene Aktion der ANTHROPIC_API_KEY.

## Umgesetzt (alle 7 Punkte)
1. **🐛 P0 Stack-Trace-Leak:** `sanitizeErrorShape` als errorFormatter in `api/src/trpc.ts` — Stacks + rohe INTERNAL-Messages nur noch in explizitem development/test (fail-safe: fehlendes NODE_ENV = Produktion, unabhängig von Server-Env). `data.code` bleibt (Frontend-Auth-Retry!). Volle Traces gehen stattdessen via `onError` in journald. 5 Tests (pure + HTTP-401-E2E ohne DB). Live verifiziert: 401/400-Antworten enthalten weder `stack` noch `/opt/`-Pfade. Zusätzlich `NODE_ENV=production` als systemd-Drop-in auf beiden Diensten gesetzt.
2. **⚙ Worker-Trennung (ROLE=web/worker) FERTIG:** fremde uncommittete Dateien kritisch geprüft (sauber: Redis-Heartbeat prozessübergreifend für /health, Rollen-Gates in start.ts, ioredis nur lesend in der Web-Rolle) und committet. **Wurzelfix obendrauf:** `rl.runEpisode` legte nur eine VERWAISTE rl_episodes-Zeile an, die NIE ausgeführt wurde (Fake-Button!) → jetzt `enqueueRlEpisodeRun(agentId)` (lazy BullMQ-Queue aus der API) + `runRlEpisodes(db,{agentId})`-Filter + Worker-Case liest job.data; NOT_FOUND/412 statt Schein-Erfolg; episodeHint-Texte ×5 ehrlich („rechnet im Hintergrund-Worker"). **Server-Installation:** gladiator-worker.service installiert+enabled, `role.conf` (ROLE=web) für gladiator.service, post-receive-Hook restartet jetzt BEIDE Dienste. Live: Web-Log zeigt „[ROLE=web — Jobs im gladiator-worker-Dienst]", Worker-Log zeigt Scan/Macro/News-Jobs, /health `workerAgeSec` kommt über Redis (=3s ✓). E2E: Test-Agent → runEpisode → `{enqueued:true}` → Job lief im Worker → Agent stillgelegt.
3. **📊 MacroPanels-COT:** „COT folgt"-Platzhalter ersetzt durch echtes COT-Panel (intelligence.cotSnapshot: Markt, Netto/OI, Perzentil, Status-Pill, Report-Datum; Farben/Keys identisch mit Tab „Entscheidung"). footprintLive-Text ×5 bereinigt. Browser-verifiziert mit ECHTEN Livedaten (Gold +52,5 % crowded long, BTC-CME P100, Report 30.06.2026). ⚠ Gefundener+gefixter Mobile-Bug: nowrap-Tabelle weitete als Grid-Item ALLE Panels auf 412px → `min-w-0` aufs Panel, 375px wieder overflow-frei.
4. **⌘K CommandPalette:** Views + Hub-Tabs navigierbar (20 Einträge: alle Sidebar-Routen + Entscheidung/ML/RL/Performance/Post-Trade als Deep-Links `#/intelligenz?tab=…`). `rankAssets` wiederverwendet (Label=ticker=name) — keine zweite Such-Logik. Badge „Ansicht" ×5, Placeholder ×5 aktualisiert. Browser-verifiziert: „entscheid" → Eintrag → navigiert korrekt in den Hub-Tab.
5. **🧠 Post-Trade-Learning-View:** NEU `views/PostTrade.tsx` als 5. Hub-Tab `posttrade` (HUB_TABS+SUBTITLE+embedded-Muster). Aggregat-Kacheln (Reviews/Win-Rate/Verlierer/Ø R/Ø Score-Validität), Top-Fehlerquellen-Chips, Review-Tabelle (Trade mit Symbol/Richtung/Modus via NEU leftJoin executed_trades im postTradeReviews-Endpoint, Trefferqualitäts-Pill, Validität, R, PnL, übersetzte Fehlerquellen-/Lehren-Chips, Datum), „Analyse starten"→runPostTradeLearning. i18n `posttrade.*` (~45 Keys) ×5 inkl. aller stabilen Backend-Schlüssel (err_*/lesson_*). Live-E2E: Button → „0 Trades geprüft · 0 neue Reviews" (ehrlich — noch keine geschlossenen Trades).
6. **💬 explanationForUser LLM-Anbindung:** NEU `jobs/src/explanation.ts` — `explainForUser(provider,guard,facts,locale)`: MIT Key LLM-Kurzfassung (guardedComplete, 400 Tokens, Sprache aus `users.locale`, DE-Fallback) VOR den deterministischen Reason-Codes; ohne Key/Budget/bei API-Fehlern still deterministisch (nie ein Fehler, §14: LLM erklärt nur). review.ts nutzt es beim signal_intelligence-Upsert. 9 Tests mit Fake-Provider (inkl. Budget-erschöpft, leere Antwort, exaktes Alt-Format als Regression-Guard). Greift automatisch, sobald Patrick den Key einträgt.
7. **📈 Labor.tsx-Konsolidierung:** lokale Kopien (fmt/MetricCard/COMPARE_COLORS/EquityChart/MultiEquityChart, ~110 Zeilen) entfernt → geteilte `components/EquityChart.tsx` (emptyText als Prop). StrategyRun bleibt strukturell kompatibel zu ComparableRun.

## CI + Deploy
- Lokal: lint ✓ · typecheck ✓ · **736 Tests** (722 Bestand + 14 neu) ✓ · build:web ✓ · Browser-Verify gegen Live-API (Vite :5199, launch.json `gladiator-web`): Palette, Post-Trade-Tab, COT-Panel, Mobile 375px, Konsole sauber.
- Commit 3057a23 → push server main → **Server-CI GRUEN (798/798 Tests, inkl. DB)**, beide Dienste laufen.
- preview_screenshot timeoutet weiterhin (MatrixRain, bekannt) — Verifikation via DOM-Snapshots/evals.

## Serverseitige Änderungen (außerhalb des Repos, dokumentiert)
- `/etc/systemd/system/gladiator-worker.service` (aus deploy/), enabled.
- `/etc/systemd/system/gladiator.service.d/role.conf`: `ROLE=web` + `NODE_ENV=production`.
- `/etc/systemd/system/gladiator-worker.service.d/env.conf`: `NODE_ENV=production`.
- post-receive-Hook: restartet nach grüner CI jetzt auch `gladiator-worker.service`.

## ⚠ Patrick-Action (die EINZIGE)
- **ANTHROPIC_API_KEY eintragen** (Profil → API-Keys): schaltet Pine-Analyse, Workshop-Dialog, LLM-Agenten (Makro/Shadow) und die neue mehrsprachige Signal-Erklärung frei. Alles andere läuft bereits ohne Key.

## Notizen für Folge-Sessions
- Test-Agent „Worker-E2E-Test" wurde nach der E2E-Verifikation stillgelegt (retired, harmlos in der DB).
- Post-Trade-Reviews entstehen erst mit geschlossenen Trades — UI/Aggregate zeigen sie dann automatisch; der 30-min-RL-Takt + Review-Job laufen jetzt im Worker-Prozess (Web friert nicht mehr ein).
- Rest-Idee aus Session 2 weiterhin offen (bewusst): Trailing-Stop gemeinsam in Engine+PositionMonitor; Workshop-Streaming (SSE).

---

# SESSION 6 — „Alles echt"-Sweep: Preise für ALLE 221 Assets, Demo auffindbar, Agenten-Einstieg, Auto-Sync sichtbar, ML-Label-Bug

**Start:** 2026-07-08 · **Session 6:** Fable-5 · Auftrag Patrick: (1) Demo-Modus unauffindbar, (2) keine Preise für Assets in Paketen, (3) COT/CPI/Buffett „nicht automatisch", (4) Agenten-Erstellung „funktioniert nicht", (5) alles Leere/Fake → echte Daten, APIs reverse-engineeren.

## Wurzelursachen (alle live verifiziert)
1. **Yahoo Finance blockt die Hetzner-IP HART (HTTP 429 für ALLES, auch ^VIX)** — deshalb zeigten Pakete außer Krypto keine Kurse: `getStockQuotes` lief still in `null`. Stooq + CNBC ebenfalls tot vom Server. **Funktionierende keyless-Quellen gefunden + verifiziert: TradingView-Scanner (Batch-POST, alle Klassen) + CBOE-Delayed-Quotes (VVIX/GVZ) + Binance-REST (Krypto).**
2. Live-Feed hartkodiert auf BTC/ETH/SOL (`start.ts`) → 25 weitere Krypto ohne Live-Tick.
3. `#/agenten` war NUR-Lese-Übersicht der 6 Schwarm-Agenten — kein Erstellen-Button (Erstellen lebt in Werkstatt/RL-Tab); Werkstatt-Agenten starten still `paused`.
4. COT/CPI/Buffett syncen LÄNGST automatisch (macro-sync 30 min, 6-h-Drossel; Logs zeigen CPI+Buffett-Werte) — nur unsichtbar; „COT:—" im Log war Kosmetik (latest=null).
5. 🐛 `ml-auto-label` warf bei JEDEM Lauf 18× SyntaxError: `take_profits` (numeric[]) kommt aus Raw-SQL als PG-Array-Literal `{…}`, wurde mit JSON.parse geparst → ML-Labels entstanden NIE (0/30, Pipeline stand).
6. ForexFactory-nextweek-Feed ersatzlos tot (404, alle Varianten getestet) → stündlicher 404-Log.

## Umgesetzt
1. **Quote-Layer NEU** `market-data/asset-quotes.ts` + `tv-symbol-map.ts`: Mapping für ALLE 221 Assets GENERIERT + gegen die echten APIs verifiziert (Skript von Server-IP; Namensabgleich Katalog↔TV-description; Composite-Key `TYPE:TICKER`, weil ZS = Zscaler UND Sojabohnen!). Quellen je Klasse: 28 Krypto→Binance `/ticker/24hr` (1 Batch-Call), 189→TradingView `scanner.tradingview.com/global/scan` (Batch-POST, Cache 60 s), VVIX/GVZ→`cdn.cboe.com` Delayed-Quotes. Jede Quelle isoliert (Promise.allSettled), ohne Quelle ehrlich null. 14 neue Tests (Parser mit echten Antwort-Fixtures, Quellen-Auflösung, ZS-Kollision).
2. **tRPC `market.assetQuotes`** ({packageId}|{assetIds}) + **Pakete.tsx**: EIN Call je Paket, alle Klassen, echte Quell-Währung (EUR/JPY/HKD/USX…); Case-Bug `'crypto'`≠`'CRYPTO'` damit obsolet. **Dashboard**: Nicht-Krypto-Favoriten bekommen eigene Quote-Kacheln (60-s-Poll, „Börsen-Quote ggf. 15 min verzögert").
3. **Live-Feed**: Symbole beim Boot aus dem Katalog (alle CRYPTO mit tradingPair = 28), Fallback Kern-3.
4. **Demo auffindbar**: Sidebar-Eintrag „Demo-Trading" (`#/demo` → schaltet Demo-Modus ein + landet auf Trading), CommandPalette-Eintrag.
5. **Agenten-Seite**: NEU Panel „Meine Agenten" ZUERST — CTAs „Trading-Agent erstellen (Werkstatt)" + „RL-Agent erstellen", Liste eigener Werkstatt-Agenten (Status/Trades/PnL) + aktiver RL-Agenten. **Werkstatt**: Nach dem Anlegen deutlicher Hinweis „startet PAUSIERT — in der Liste aktivieren"; stummer Disabled-Button bei fehlendem Namen erklärt sich jetzt.
6. **Auto-Sync sichtbar**: NEU `intelligence.dataStatus` (Datenstand COT/CPI/Buffett) + Zeile im Entscheidung-Tab „⟳ Synchronisiert automatisch alle 6 h · COT: Stand … · CPI: … · Buffett: …". Worker-Log zeigt für COT jetzt `n neu` statt „—".
7. **ml-auto-label-Fix**: `parsePgNumericArray` (pure, 5 Tests) statt JSON.parse — Labels können jetzt entstehen, ML-Pipeline läuft an.
8. **Kalender**: toten nextweek-Feed entfernt (Doku im Code); thisweek (76 Events) bleibt, Folgewoche läuft bei Wochenstart automatisch ein.
9. i18n: ~15 neue Keys ×5 (nav.demo, dashboard.quote*, agents.my*/create*, workshop.nameRequiredHint/createdPausedNotice, intel.autoSyncNote/dataAsOf/noDataYet) + packages.livePrice-Text aktualisiert; Paritätstest grün.

## CI + Verifikation
- Lokal: lint ✓ · typecheck ✓ · **784 Tests passed** (765 Bestand + 19 neue) ✓ · build:web ✓ · Browser pre-deploy (Vite :5199 → Live-API): Sidebar „Demo-Trading" ✓ · #/demo → Demo-Konto ✓ · Agenten-Seite zeigt echten RL-Agenten + CTAs ✓ · Werkstatt-Hinweise ✓ · Pakete ehrlich „kein Live-Kurs" (Endpoint live erst nach Deploy) ✓ · Konsole sauber ✓.
- Deploy + Live-E2E: siehe Abschluss unten.

---

# SESSION 5 — Demo-Währung / manueller Demo-Trading-Modus (Häkchen → 100k virtuell, realistische Ausführung)

**Start:** 2026-07-08 · **Session 5:** Fable-5 · Auftrag Patrick: offensichtlicher Demo-Schalter, virtuelles Startguthaben 100.000 USD, hochrealistische Simulation (Fees, Spread, Slippage, Market/Limit/SL/TP, Partial Fills) gegen ECHTE Live-Kurse, separates Demo-Portfolio (Equity-Kurve, Win-Rate, Sharpe, Historie), Reset-Button. Additiv, TDD, i18n ×5, Demo darf NIE echte Orders auslösen.

## Bestandsaufnahme (2 Explore-Agenten + Kernfile-Reads)
- Das bestehende System ist das **Agenten-Paper-Konto** (signalgetrieben): `PAPER_START_EQUITY=10_000` (Konstante!), `executeConfirmedSignal` → Risk-Gate → PaperVenue-Fill zum Ticker-Preis, Kosten (Taker 0,04 % + Funding) erst beim Close, Slippage='0'. **Kein manuelles Order-Ticket, kein placeOrder-Endpoint, kein Reset, kein Limit-Fill-Pfad** (orderTypeEnum kennt 'limit', VenueOrderRequest nicht).
- Kein Orderbuch-Zugriff im Code (nur fetchTicker); LivePriceFeed cached nur last/changePct.
- `positions_unique_idx` enthält `mode` — aber tradeModeEnum=['paper','live'] und alle Agenten-Flows filtern mode='paper'.
- Wiederverwendbar: `computeMetrics` (Sharpe/Sortino/MaxDD, backtest/metrics.ts), `MarketRules`+`stepFromPrecision`, EquityChart/MetricCard (shared), tab-hash, SCHEDULES-Pattern (`position-monitor` 60 s), DB-Testmuster (`describe.skipIf(!hasDb)`).

## Architektur-Entscheidungen
1. **Strikt separate `demo_*`-Tabellen** (Migration 0017, IF NOT EXISTS + DO-$$-Guards) statt tradeModeEnum-Erweiterung: `demo_accounts` (userId unique, startBalance 100000, balance, resetCount), `demo_orders` (limitPrice/triggerPrice/filledQty/avgFillPrice/feePaid, reuse bestehender order-Enums — additiv), `demo_positions` (unique accountId+symbol+direction, avg-in, SL/TP-Level), `demo_trades` (netto: grossPnl−fees−slippage−funding, reason). Bestehende Tabellen/Enums UNANGETASTET → Agenten-Queries können Demo-Daten physisch nicht sehen.
2. **Realität = echtes Orderbuch, nicht Modell:** neues `packages/exchange/src/demo/` — `fill-engine.ts` (PURE, TDD): Market-Fill „läuft durchs Buch" (Spread+Slippage aus ECHTER Binance-Tiefe, deterministisch, kein Math.random), Limit-Order füllt sofort-taker soweit das Buch die Limit-Grenze kreuzt, Rest ruht und füllt später als Maker partiell gegen sichtbare Tiefe (partially_filled), SL/TP-Trigger gegen Best-Bid/Ask → Market-Fill. `book-source.ts`: ccxt binance `fetchOrderBook` (public, keyless) hinter Interface `DemoBookSource` (Tests injizieren deterministische Bücher). Fees Maker 0,10 % / Taker 0,15 % (Patricks Binance-Beispiel), Funding wie Bestand 0,01 %/8 h.
3. **Konto-Modell wie Bestand (futures-artig, 1×):** long+short, Fees bei jedem Fill sofort von der Balance, Notional als Margin reserviert (available = balance − offene Notional − ruhende Entry-Order-Notional), Equity = balance + uPnL. R-Multiple nur wenn SL beim Entry gesetzt (sonst ehrlich null).
4. **Engine schreibt DB in `exchange/demo/engine.ts`** (Präzedenz executor.ts): placeDemoOrder/cancel/closeNow/monitorDemoTick — EINE Wahrheit für Router UND Worker-Job. Der Demo-Pfad importiert/berührt `venue.placeOrder` NIRGENDS; DB-Test beweist: orders/positions/executed_trades bleiben leer.
5. **tRPC-Router `demo`** (neu, dünn): account, preview (Kosten-Vorschau aus echtem Buch), placeOrder, cancelOrder, openOrders, positions (uPnL live), closePosition, setProtection, history, performance (computeMetrics auf Tages-Equity, barsPerYear=365), reset (löscht demo_*-Zeilen des Users, legt Konto neu an, auditiert).
6. **Monitor-Job `demo-monitor`** (60 s, SCHEDULES → läuft im Worker): früher Exit wenn keine offenen Demo-Orders/Positionen; ein Buch-Fetch je Symbol; Fehler-Isolation je Symbol.
7. **Frontend:** Trading-Seite bekommt offensichtlichen Zwei-Segment-Schalter im PageHeader („Agenten-Konto (Paper)" | „✓ Demo-Konto (manuell)", localStorage `gladiator.demoMode` + CustomEvent) + magenta DEMO-Badge in der Topbar (Shell) wenn aktiv + Banner auf der Seite. Demo-Ansicht = neue `views/DemoTrading.tsx`: Konto-Kacheln (Balance/Equity/Verfügbar/uPnL, Reset mit Bestätigung), Order-Ticket (Symbol, Long/Short, Market/Limit, Menge, optional SL/TP, LIVE-Kosten-Vorschau: erwarteter Fill/Spread/Slippage/Fee), Tabs offene Orders/Positionen/Historie/Performance (EquityChart+MetricCard shared). Ehrlich: Demo-Ausführung v1 nur für Binance-Spot-Symbole (nur dort existiert ein echtes Orderbuch); Labels sagen „Paper", nie „Live" (es gibt keinen Live-Pfad).
8. **i18n** `demo.*` ×5 (DE/EN/IT/ES/FR), {{n}}-Konvention, Paritätstest.

## Arbeitsreihenfolge
- [x] 1. exchange/demo: fill-engine.ts PURE + 24 Tests (Buch-Walk, Partial Fills, Maker/Taker, VORZEICHEN-Slippage [Kosten +, Verbesserung −], Trigger, Netto-Close). Netto = gross − Fees − Funding; Slippage steckt bereits in den Fill-Preisen (kein Doppelabzug, `slippage`-Spalten sind Ausweis).
- [x] 2. db: schema/demo.ts (demo_accounts/orders/positions/trades, reuse bestehender Enums = additiv) + Migration 0017_shocking_punisher (hand-bereinigt idempotent nach 0016-Muster; einmal regeneriert für slippage_paid/entry_slippage — 0017-Erstfassung sauber aus Journal+Snapshot entfernt).
- [x] 3. exchange/demo: engine.ts (getOrCreate/Overview/preview/place/cancel/setProtection/closeNow/reset/monitorTick — EINE Wahrheit für Router+Worker) + book-source.ts (ccxt fetchOrderBook depth 100, 3-s-Cache, keyless) + 11 DB-Integrationstests inkl. SICHERHEITS-Beweise (orders/positions/executed_trades unberührt; engine.ts importiert kein Venue/placeOrder). ⚠ monitorDemoTick hat accountId-Scope-Option, weil die Server-CI gegen die ECHTE DB testet — Tests dürfen Patricks echte Demo-Orders nie mit Fake-Büchern füllen.
- [x] 4. api: routers/demo.ts (dünn, wirft PRECONDITION_FAILED `demo:<reason>` → Frontend übersetzt) + Registrierung + 6 Router-DB-Tests (Caller+Auth, setDemoBookSourceForTests). performance nutzt computeMetrics aus @gladiator/backtest (Sharpe/Sortino auf Tages-Equity, barsPerYear=365).
- [x] 5. jobs: Demo-Tick huckepack im bestehenden MONITOR_JOB (60 s, Worker-Rolle) — fehlerisoliert VOR dem Heartbeat (Präzedenz: syncIntelligenceSources in macro-sync). Kein neues SCHEDULES-Element nötig.
- [x] 6. web: lib/demo-mode.ts (localStorage `gladiator.demoMode` + CustomEvent/storage), ModeSwitch im Trading-PageHeader („Agenten-Konto (Paper)" | „✓ Demo-Modus", magenta), Topbar-DEMO-Badge (Shell), views/DemoTrading.tsx (Banner+Reset-2-Schritt, 4 Konto-Kacheln, Order-Ticket mit debounced LIVE-Kosten-Vorschau [Fill/Spread/Slippage/Fee/ruhender Rest], Tabs Positionen [SL/TP inline editierbar, Close] / Orders [Stornieren, teilgefüllt-Pill] / Historie [Fees+Slippage+Netto+R+Grund] / Performance [MetricCards+EquityChart+Kosten-Summen]). i18n `demo.*` ~90 Keys ×5, Paritätstest grün (Pre-Deploy-Browserlauf fand 4 fehlende tab_-Keys → nachgetragen).
- [x] 7a. Full CI lokal: lint ✓ · typecheck ✓ · 760 Tests passed (736 Bestand + 24 neue; 79 DB-Tests → Server-CI) ✓ · build:web ✓ · Browser pre-deploy (Vite :5199 → Live-API): Schalter/Badge/Banner/Ticket rendern, ehrliche „No procedure found"-States (Router live erst nach Deploy), Persistenz über Reload, Mobile 375px kein Overflow, Konsole sauber.
- [x] 7b. Commits c5649ba + ff28e81 + 290d7cd → push server main → **Server-CI GRUEN (839 Tests, inkl. 17 neue DB-Tests; Migration 0017 auf Live-DB)**, beide Dienste neu gestartet. Zwei CI-Iterationen nötig (nur Test-Fixes, Produktlogik war ab Lauf 1 grün): (a) afterAll-Cleanup scheiterte am audit_log-FK (reset schreibt Audit) → audit_log zuerst löschen; (b) toBe(50100) vs. 50100.00000000001 → toBeCloseTo; (c) Quelltext-Guard matchte „import**iert**"/eigenen Kommentar → Regex auf echte Venue-Imports + `.placeOrder(`-Aufrufe präzisiert.

## Abschluss Session 5
- [x] **Browser-LIVE-E2E** (Vite :5199 → Live-API, admin@): Demo-Konto lazy mit **100.000 $** angelegt ✓ · Kosten-Vorschau live gegen echtes Buch (BTC 61.880,58 · Spread 0,01 · Taker-Fee 1,86 $ = exakt 0,15 %) ✓ · **Market-Long 0,02 BTC mit SL 55.000 ausgeführt @ 61.924,01** (Preis lief zwischen Vorschau und Fill — echter Markt), Guthaben exakt −1,86 $ Fee, Verfügbar −Notional ✓ · SL in Positionszeile editierbar persistiert ✓ · **Limit-Order 55.000 ruht** („1 Positionen · 1 Orders", Verfügbar −1.100 $ Reserve) + Stornieren gibt Reserve frei ✓ · **Close @ 61.951,99: Netto −3,16 $ = +0,56 gross − 3,72 Fees − Funding, R −0,02** (ehrlich: Fees fressen Mini-Gewinn) ✓ · Performance-Tab (1 Trade, Win-Rate 0 %, Sharpe ehrlich „—" bei 1 Tagespunkt, Kosten-Summen, bySymbol) ✓ · **Reset 2-stufig → 100.000 $, „1× zurückgesetzt", alles leer** ✓ · uPnL tickte live (+0,12 $) ✓ · Mobile 375px kein Overflow ✓ · Konsole sauber ✓ · /health ok (db up, workerAgeSec 15, Feeds connected) ✓ · Worker-/Web-Logs ohne Fehler ✓.
- Demo-Restzustand in Live-DB: sauberes Konto (100k, resetCount 1) — gewollt, Patrick kann sofort loslegen.
- ⚠ Kosmetik (bekannt, unkritisch): Direkt nach „Reset" kann der parallele 15-s-Poll noch einmal den alten Stand rendern; nächster Poll/Reload zeigt korrekt 100k. Bei Bedarf: Poll-Antworten verwerfen, wenn nach einer Mutation gestartet.
- Bewusste v1-Grenzen (ehrlich in UI/Fehlern): Demo-Ausführung nur für Symbole mit echtem Binance-Orderbuch (Stocks/ETF via Yahoo haben keins → `demo:unknown_symbol`); SL/TP schließen die Position VOLL (keine gestaffelten TPs wie das Agenten-Konto); Partial Fills ruhender Limits sind durch die sichtbare Buchtiefe des Monitor-Ticks begrenzt (dokumentierte Minuten-Granularität); Leverage fix 1×.
- **Patrick-Action: KEINE.** Häkchen auf der Trading-Seite setzen und lostraden.
