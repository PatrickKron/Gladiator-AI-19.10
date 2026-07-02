# One-Shot-Prompt für fable 5 (Claude Code)

> Kopiere den Text zwischen den Linien 1:1 in fable 5. Er ist so gebaut, dass fable 5 aus dieser Session „alles weiß": er verweist auf das Blueprint-Paket, ordnet die erneute Desktop-Suche an und enthält Vision, Funktionsumfang, Design und Guardrails.

---

# AUFTRAG: Baue „Gladiator AI" — ein professionelles All-in-One Finanz-KI-Framework (Agenten-Orchestrator) als eigenständiges, lauffähiges Projekt.

Du bist der leitende Architekt und Entwickler. Erstelle ein **komplett neues, separates Claude-Code-Projekt** namens `gladiator-ai` (eigenes Verzeichnis, eigenes Repo). Ziel ist ein **autonomer Multi-Agenten-Trading-Orchestrator** mit erstklassiger UI/UX: ein Agent, der Märkte beobachtet, Strategien anwendet, über einen KI-Agenten-Schwarm jede Entscheidung gegenprüft, sich mit **Wallets und Börsen (zentral UND dezentral)** koppelt und dort — innerhalb harter Risiko-Limits — **selbstständig Trades ausführt**, Ergebnisse auswertet und seine Strategien selbst verbessert.

## 1. Pflicht-Quellen (zuerst vollständig lesen)
1. **Blueprint-Paket:** Lies ALLE Dateien in
   `C:\Users\Patrick\Antigravity Gladiator AI versuch 1\GLADIATOR_V2_BLUEPRINT\`
   (Dateien `00`–`14` plus `CLAUDE_CODE_KICKOFF_PROMPT.md`; darunter `13` = VDB1/VDB2-Cluster-Selbstoptimierung mit RAPS, `14` = optionale Gamification/Alecto). Das ist die **verbindliche Spezifikation** — Inhalt UND Arbeitsanweisung. Sie enthält Vision, Ist-Analyse des Vorgängers, De-Mocking-Regeln, Zielarchitektur, Strategie-Engine, Börsen-Anbindung (CEX+DEX), Pine/Anweisungen, KI-Agenten & Selbstoptimierung, Sicherheit und einen Phasen-Bauplan. Bei Widerspruch/Lücke: nachfragen, nicht raten.
2. **Referenz-Codebasis (nur als Referenz, NICHT kopieren):** das Vorgängerprojekt unter
   `C:\Users\Patrick\Antigravity Gladiator AI versuch 1\backend-node\` und `\frontend-web\`. Übernimm daraus nur die **funktionierenden** Teile als Vorlage (ccxt-ExchangeConnector, TradeExecutor, PositionMonitor, UnifiedPriceService) und härte sie. Alles Mock-/`Math.random()`-basierte wird ersetzt (siehe Blueprint `03_MOCKUP_BEFREIUNG.md`).
3. **Erneute Desktop-Recherche (Pflicht):** Durchsuche `C:\Users\Patrick\Desktop\` rekursiv nach ALLEM, was zu diesem Projekt gehört, und werte es aus. Suchbegriffe u. a.: `gladiator`, `thaex`, `chamäleon/chamaelien`, `trading`, `strategie/strategy`, `smart money`, `BOS/CHoCH`, `order block`, `pine`, `block sentinel`, `devils analyst`, `okx/binance`, `telegram`, `signal`, `kontext`, `masterplan`, `roadmap`, `pakete`. Besonders relevant: `📄 Master-Kontext für neue Chats.txt`, `06.12.2025 Gladiator_AI_Expanded_Documentation.md`, `Funktionierende strategien.txt`, `SmartMoney_BOS_CHOCH_Strategy.pine`, `decker_capital_elite_trading_full_export.md`, der Ordner `GladiatorAI\` (Python-Prototypen: block_sentinel, okx_signal, monitor_reentry, devils_analyst, send_to_telegram), `🧠 Gladiator AI – Backup stuff\`, sowie die **ZIP-Archive** — v. a. `…KI-Trading-Plattform-Konzepts.zip` (enthält „Gladiator AI 2026 — Blueprint der Dominanz (Single Source of Truth).md", „F) Compliance & Safety", VDB1/VDB2-Konzepte) und `backendinator-complete-code.zip` (Original-Backend, nur als Referenz), die Word-Dateien `TECHNICAL_DOCUMENTATION.md.docx`, `Gladiator_AI_Warroom_Blueprint.docx` (Gamification) und die UX-Docs unter `App bilder\`. Extrahiere daraus Strategien, Signal-Logik, Reentry-/Leverage-Regeln, Session-Logik, Telegram-Routing und die Produktvision. Fasse deine Funde in `RESEARCH_NOTES.md` zusammen und speise sie in die Umsetzung ein.

## 2. Vision (verbindlich)
Aus der Signal-/Daten-App der Vergangenheit wird ein **handelndes** System — ein „All-in-One Profi-Finanz-KI-Framework":
- **Beobachten → Simulieren → Entscheiden → Ausführen → Lernen** als durchgehender Kreislauf.
- **Nur echte Daten.** Kein Fake, kein Mock, keine Demo-Werte in Laufpfaden. Nicht verbundene Quellen werden sichtbar als „nicht verbunden" markiert — niemals erfunden.
- **Multi-Asset:** Start BTC/ETH/SOL, dann Aktien/ETF/Forex/Rohstoffe/Krypto-Körbe über thematische Pakete.
- **Der Mensch bleibt Chef:** der Agent handelt autonom nur innerhalb freigegebener Limits; Live-Eskalationen und Limit-Erhöhungen bestätigt der Nutzer.

## 3. Funktionsumfang (das Framework)
1. **Marktdaten-Layer (echt):** ccxt/ccxt pro (CEX-Streams), Yahoo/Polygon/Alpaca (Aktien/ETF/Forex, lizenzkonform), FRED (Makro), Wirtschaftskalender, News. OHLCV in Zeitreihen-DB.
2. **Strategie-Engine:** Smart-Money-Konzepte (BOS/CHoCH, Order/Breaker/Mitigation Blocks, FVG, Wyckoff, Liquidität), Indikator-Confluence, Multi-Setup (scalp/swing/position), ATR-basierte SL/TP, echtes Confluence-Scoring (nie hartkodiert), Session-Gating, Reentry- & Leverage-Upgrade-Engine. Referenz-Strategie „SMC Core" nach `SmartMoney_BOS_CHOCH_Strategy.pine`.
3. **KI-Agenten-Schwarm:** spezialisierte Agenten (Technik, Makro/Oracle, Shadow/Manipulation, Risk, „Devil's Advocate", Portfolio-Manager). Jeder liefert ein strukturiertes Urteil; der Portfolio-Manager aggregiert. Provider-Router (lokal via Ollama für Vorfilter, Cloud für Kernanalyse) mit Kosten-Wächter.
4. **Pine & Anweisungen:** Strategien per (a) eingebauter Engine, (b) TradingView-Pine über signierten Webhook, (c) natürlicher Anweisung → typisierte Strategie-DSL (LLM erzeugt Entwurf → Nutzer bestätigt). Alle Wege münden in dasselbe kanonische Signal + Risk-Gate.
5. **Backtesting & Selbstoptimierung:** look-ahead-freies Backtesting auf echten OHLCV, **netto nach Gebühren/Slippage/Funding**, Walk-Forward/Out-of-Sample, Survivorship-/Datenqualitäts-Checks. Nacht-Pipeline erzeugt Optimierungs-Vorschläge; neue Live-Versionen promotet der Nutzer.
6. **Ausspielung:** Web-App (Kern), Web-Push/FCM, Telegram (Free/Pro/VIP mit Topic-Threads, Score-Routing).

## 4. Wallet- & Börsen-Kopplung + autonome Ausführung (Kernlogik)
- **Einheitliches `TradingVenue`-Interface** für ALLE Handelsplätze (CEX wie DEX), damit Strategien venue-agnostisch sind: `getMarkets/getBalance/getPositions/placeOrder/closePosition/streamFills/validate`.
- **CEX:** Binance (inkl. Testnet), OKX, Bybit über ccxt — API-Keys mit **Trade-Recht, niemals Withdraw**, IP-Whitelist, verschlüsselt im Vault.
- **DEX & Wallets:** Kopplung an Perp-DEXes — **Hyperliquid zuerst** (API-/Agent-Wallets, die handeln aber NICHT auszahlen können — ideales Sicherheitsmodell), dann **dYdX v4**, später GMX v2/Bluefin. Wallet-Verbindung im UI (Connect-Flow); der **private Haupt-Schlüssel verlässt nie den Server**, gehandelt wird nur mit eingeschränkten, nicht-auszahlungsfähigen Trading-/Agent-Wallets, die der Nutzer anlegt.
- **Autonome Ausführung mit hartem Risk-Gate:** Jede Order — automatisch oder bestätigt — durchläuft VOR Ausführung die **Risk-Engine** (Risiko %/Trade, max. Hebel-Cap, max. offene Positionen, Exposure-/Cluster-Limit, Tages-Verlust-/Drawdown-Limit, Margin-Check, Slippage-/Min-Notional-Check, News-/Event-Sperre). Order-Lifecycle mit Idempotenz, Retry für TP/SL, Reconciliation beim Start, Websocket-Fills, PositionMonitor, **Dead-Man's-Switch** (Auto-Flat bei Heartbeat-Verlust) und **Kill-Switch**.
- **Prohibited by design:** keine Ein-/Auszahlungen, Transfers oder Swaps durch den Agenten — nur Handel innerhalb bereits eingezahlter Trading-Accounts.
- **Paper zuerst:** alles zuerst Paper/Testnet; Live pro Börse einzeln nach grüner Reconciliation + Nutzer-Freigabe.

## 5. UI/UX — „next level" Gladiator-Design (Design-Direktive)
Baue eine **erstklassige, cineastische** Oberfläche im Stil einer futuristischen High-Tech-Kommandozentrale. Orientiere dich am Look dieser Referenz (bitte ansehen/emulieren):
`https://www.magnific.com/de/premium-ki-bild/eine-website-fuer-unsere-technologie_298351483.htm`

**Falls die Referenz nicht abrufbar ist**, gilt diese Beschreibung: tiefdunkler, fast schwarzer Hintergrund mit cineastischer Tiefe; luminieszente Kanten und feines Edge-Lighting; glasartige (glassmorphe) Panels mit Tiefe/Schatten; holografische/3D-Akzente; präzise, ruhige Typografie; premiumhaftes, technisches, „teures" Gefühl — kein verspielter Casino-Look. Klare visuelle Hierarchie, viel Negativraum, dezente, funktionale Animation.

**Logo (Marke):** ein **futuristisch stilisierter Gladiatoren-Helm im Stil von Maximus aus „Gladiator" (2000)** — römischer Helm mit markanter quer stehender Helmzier/Kamm, Wangenschutz, Visier. Futuristische Interpretation: mattschwarz mit edlem Gold- und leuchtend-blauem/technischem Detail, sauber, geometrisch, als klare Vektor-/Emblem-Marke skalierbar (App-Icon, Favicon, Login, Sidebar). Erzeuge das Logo als SVG (und optional als KI-Bild) und binde es konsistent ein.

**Design-System zuerst ableiten:** Definiere aus Referenz + Beschreibung ein Design-System (Farb-Rampen, Typografie-Skala, Komponenten, Spacing, Motion, Iconografie) und lege es als `DESIGN_SYSTEM.md` + Style-Tokens an, bevor du Seiten baust.

**Seiten (funktionale Struktur aus Blueprint `09_UI_REDESIGN.md`):** Dashboard, Signals (Decision Pathways), Oracle (Observe/Regime), Strategy Lab (Simulate/Backtest), Trading & Börsen (Wallets/Positionen/Risk-Cockpit), Hedging, Strategie-Builder (Pine/Anweisung/Eingebaut), Magazine, Calendar, Profile, Auth, Pricing. Jede Seite mit echten Daten oder ehrlichen Loading-/Empty-/Error-/No-Auth-Zuständen. Mehrsprachig (DE/EN/IT/ES/FR).

## 6. Tech-Stack & Architektur
TypeScript · Express + tRPC · Drizzle + PostgreSQL/TimescaleDB · ccxt(pro) · DEX-SDKs (Hyperliquid → dYdX v4) · BullMQ + Redis · React + Vite + Tailwind (neues Design) · optionaler Python-Quant-Service (Freqtrade/Jesse) für Backtesting. Monorepo mit Paketen: `core, market-data, strategy-engine, exchange, risk, agents, backtest, api, jobs, db` + `apps/web` + `services/quant`. Details: Blueprint `04_ZIELARCHITEKTUR.md`.

## 7. Eiserne Regeln (nicht verhandelbar)
1. **Kein Fake** — keine `Math.random()`/Mock/Demo in Laufpfaden; nicht verbundene Quellen sichtbar markieren (Mock nur in `__tests__/`).
2. **Sicherheit zuerst** — echte Auth/RBAC/Tenant-Scoping; keine Klartext-Secret-Fallbacks (Boot-Abbruch ohne Pflicht-Secrets); Vault für Börsen-/Wallet-Keys; Risk-Engine als hartes Gate vor jeder Order.
3. **Paper zuerst**, Live nur nach expliziter Freigabe pro Börse.
4. **Backtests netto** (Gebühren/Slippage/Funding, look-ahead-/survivorship-frei) — sonst keine Strategie-Promotion.
5. **TDD** — erst Tests, dann Code, v. a. Risk-Engine, Strategien, Order-Lifecycle, Auth.
6. **Eine Wahrheit** — ein Backend, ein kanonisches Signal-Modell, eine Strategie-Engine.
7. **Mensch im Loop** bei Live/Limit-Erhöhungen/neuen Live-Strategien.
8. **Rechtlicher Hinweis:** kommerzieller Signal-Verkauf/Trade-Ausführung für Dritte kann in DE/EU (BaFin/MiCA) erlaubnispflichtig sein — als Klartext-Warnung ins Projekt aufnehmen; Monetarisierung nach hinten legen.

## 8. Vorgehen & Ergebnis (One-Shot, vision-orientiert)
Baue in einem Durchgang das **vollständige, lauffähige Fundament** des Frameworks im **Paper-Modus**:
1. Lies Blueprint + durchsuche Desktop → `RESEARCH_NOTES.md` + `PROGRESS.md`.
2. Erzeuge Projekt-Root `CLAUDE.md` (Regeln oben), Monorepo-Gerüst, CI, Postgres-Schema + Migration/Seed.
3. Echte Auth/RBAC; Vault; Risk-Engine (getestet); Marktdaten (echt); Strategie-Engine mit „SMC Core"; einheitliches `TradingVenue` mit CEX (Binance-Testnet) + Hyperliquid-Testnet; Order-Lifecycle; Agenten-Schwarm (mind. Technik+Risk+Portfolio); Backtesting mit Kostenmodell; Pine-Webhook + Anweisungs-DSL.
4. Design-System + Logo + alle Kernseiten an echte Daten angeschlossen.
5. `README.md` mit Start-Anleitung; `.env.example`; Seed-Daten; klare Kennzeichnung, was noch „nicht verbunden" ist.
6. Halte alles, was noch nicht echt angebunden ist, **ehrlich als solches sichtbar** — niemals mit erfundenen Werten kaschieren.

**Definition of Done:** Projekt startet lokal; Login echt; ein Signal läuft End-to-End (Strategie → Agenten-Review → Risk-Gate → Paper-Order auf Testnet → Fill → PositionMonitor → Close) und ist im UI im neuen Gladiator-Design sichtbar; Backtest liefert Netto-Kennzahlen; Wallet-/Börsen-Connect funktioniert im Testnet; Risk-Engine blockt nachweislich Über-Limit-Orders; keine Mock-Daten in Laufpfaden.

Wenn eine Design-Entscheidung oder ein fachlicher Punkt unklar ist: triff die sinnvollste, sicherste Annahme, dokumentiere sie in `PROGRESS.md` und mach weiter — Ziel ist ein vollständiges, kohärentes, sicheres Fundament, das exakt der Vision aus dem Blueprint entspricht.

---
