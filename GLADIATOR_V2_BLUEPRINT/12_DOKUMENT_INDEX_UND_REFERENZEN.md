# 12 · Dokument-Index & Referenzen

Vollständiger Index der Quellen, auf denen dieses Blueprint beruht. Drei Gruppen: **A** Desktop-Dokumente/Prototypen, **B** Codebasis, **C** Antigravity-Chats.

---

## A. Desktop-Dokumente & Prototypen (`C:\Users\Patrick\Desktop\`)

### A1 — Strategie/Vision (hohe Relevanz)
| Datei | Inhalt | Relevanz |
|---|---|---|
| `📄 Master-Kontext für neue Chats.txt` | Ur-Vision Gladiator AI + beantwortete Fragenkataloge (Ziele, USP, Stack, Monetarisierung, Sammelkarten-Signale, Free/Pro/VIP). | **hoch** |
| `06.12.2025 Gladiator_AI_Expanded_Documentation.md` | „Trading Universe": 1.000+ Assets in thematischen Paketen (Aktien/ETF/Bonds/Forex/Krypto/Rohstoffe). | **hoch** |
| `decker_capital_elite_trading_full_export.md` | Smart-Money-Kurs „Decker Capital Elite 2.0": Strategien S001–S010 (Order/Breaker/Mitigation Blocks, Wyckoff, FVG, SL/TP) + 65 Video-Transkripte. | **hoch** |
| `Funktionierende strategien.txt` | 4 lauffähige Pine-Indikatoren: FVG (DGT), BOS/CHoCH-Fractal (LuxAlgo), HH/HL/LH/LL-Mod, Pivot-Replika. | **hoch** |
| `SmartMoney_BOS_CHOCH_Strategy.pine` | **Beste SMC-Strategie-Logik** im Projekt (BOS/CHoCH + EMA200 + Retest@EMA50 + RSI/Volumen). → Referenz für `05_…`. | **hoch** |
| `Smart Money Strategie.rtf`, `Smart Money fragen…txt` | Smart-Money-Konzepte + offene Vertiefungsfragen (= gewünschte Strategie-Features). | mittel |
| `12-ROADMAP-AKZEPTANZ-FOLGEPROMPT.md` | 6-Phasen-Roadmap + Akzeptanzkriterien (für CHAMÆLIEN, Methodik übertragbar). | mittel |
| `1claudecodepromptcodexchamintegration.md` | Integrations-Prompt (Workspace/App-Layer). | niedrig |

### A2 — Lauffähige Python-Prototypen (`Desktop\GladiatorAI\`, Backup-Ordner)
| Datei | Inhalt | Relevanz |
|---|---|---|
| `block_sentinel.py` / `btc_input_generator.py` | OKX-15m-Engine: RSI/MACD/Struktur/Volumen/Session → 3 Setups (scalp/swing/hold) + Hebel. **Score hartkodiert 7.8** (Lehre: echtes Scoring nötig). | **hoch** |
| `okx_signal.py` | 1m-Engine mit **echter** Score-Berechnung + Order-Block-Erkennung + Smart-Money-Flag. | hoch |
| `btc_live_analysis.py` | wie okx_signal + Struktur-Shift + dynamische trade_type-Wahl. | mittel |
| `monitor_live_triggers.py` / `monitor_reentry.py` | **Reentry- & Leverage-Upgrade-Engine** + Auto-Kill + Event-Log. → Vorbild `05_…` §9. | **hoch** |
| `devils_analyst.py` / `weekly_analyzer.py` | GPT-4 Gegenprüfung/Wochenstudie (Freitext, nicht zurückgespeist). → Vorbild Agenten `08_…`. | hoch |
| `send_signals.py` / `send_to_telegram.py` / `telegram_router.json` | Free/Pro/VIP-Telegram-Routing mit Topic-Threads + Score-Routing. | hoch |
| `block_sentinel_prompt.txt` | LLM-System-Prompt mit striktem JSON-Signal-Schema. | mittel |
| `run_blocks.py` / `run_all.py` / `auto_run.py` | Orchestrierung + Session-Gating. | mittel |
| `btc_input_schema.json` | Signal-Validierungsschema. | mittel |
| `generate_input.py` / `generate_signal.py` | veraltet (Zufalls-Score) — **nicht** übernehmen. | niedrig |
| `Tel.GladiatorAI Routing inkl. Chat IDs.txt` | Gruppen-/Topic-IDs (+ Token = Secret, rotieren!). | mittel |
| `GladiatorAI_Dokumentation_21_06_2025.txt` | Dateistruktur + Bug-Liste + 3-stufige Roadmap des Live-Systems. | hoch |

> **Hinweis:** Ordner `GladiatorAI - verbessert mir Manus` ist **byte-identisch** zum Original (Kopie, keine Verbesserung). `Design Gladiator AI/` enthält Mockup-PNGs (Signal-Feed, Performance-Dashboard, AI-Chat, Admin) — Designreferenz für `09_…`.

### A3 — CHAMÆLIEN (separates, späteres Projekt — Kontext)
`CHAMAELIEN-Build/CHAMAELIEN-MASTER-DOKUMENT.md`, `…-MASTERPLAN(.|-TEIL1..5).md`, `…-MASTERDOC/01..12-*.md`: Vision eines proaktiven KI-Allround-Assistenten. **Architektur-Prinzipien übernommen** (ein Agent-Loop, „kein Fake", Vault, Nacht-Pipeline, Modell-Routing). Für Gladiator-Trading nur indirekt relevant; wichtig für spätere Zusammenführung (`04_…` §7).

### A4 — Weitere PDFs/Docs
`Gladiator_AI_Warroom_Blueprint.docx`, `Gladiator_AI_1Pager_2025-08-31.pdf`, `Aufbau Gladiator/…FULL_LIST…pdf`, `Quanten-Trading…pdf`, `Graph neural network.pdf`, `Gladiator AI Pakete_DETAILLIERTE_PREISGESTALTUNG.pdf`, `📦_TRADING-PAKETE_ÜBERSICHT.pdf` — Pakete/Preise/Vertiefung; Relevanz mittel (Produkt/Monetarisierung).

## B. Codebasis (`Antigravity Gladiator AI versuch 1/`)

| Bereich | Schlüsseldateien | Relevanz |
|---|---|---|
| Backend aktiv | `backend-node/src/{index.ts, routers.ts, db.ts}`, `src/drizzle/schema.ts`, `src/_core/trpc.ts` | **hoch** |
| Echte Services | `services/{UnifiedPriceService, MarketDataService, ExchangeConnector, TradeExecutor, PositionMonitor, GrsEngine, LlmSignalProcessor}.ts` | **hoch** (übernehmen/härten) |
| Mock-Services | `services/{SynapseOracle, StrategyEngine, BlockSentinel, ProjectOracle, ShadowGPT, MacroProvider, ImpactService, LiquidationService, NewsService, ThaexService}.ts` | hoch (ersetzen, siehe `03_…`) |
| Frontend | `frontend-web/src/{main.jsx, App.jsx, context/AuthContext.jsx, pages/*, components/*, api/, utils/trpc.js}` | hoch |
| Altlast (entfernen) | `backend/` (Python/FastAPI), `frontend-admin/`, `frontend-mobile/`, lose `test-*/debug-*`-Skripte | — |
| Betriebsdoku | `README.md`, `SCHNELLSTART.md`, `QUICK_START.md`, `BACKEND_OVERVIEW.md` (veraltet: beschreibt altes Python-Backend), `ADMIN_GUIDE.md`, `SETUP_KEYS.md` | mittel |
| Start-Helfer (neu) | `START_GLADIATOR.bat`, `backend-node/run-backend.bat`, `frontend-web/run-frontend.bat` (für v1-Start) | niedrig |

## C. Antigravity-Konversationen

| Konversation | Workspace | Inhalt / Relevanz |
|---|---|---|
| **„du must die optik der ganzen app seite für seite so beschreiben!"** | Gladiator-Projekt | Enthält das **„Visual Design Audit"** (alle 12 Seiten optisch/funktional). → Grundlage `09_…`. **hoch** |
| Deep Dive Audit | Gladiator-Projekt | Code-Audit (≈ aktuelle Session). mittel |
| Organic Intelligence Overhaul, Implementing Bio-Cybernetic Design, +19 weitere | `chamaelien-app` (Desktop) | CHAMÆLIEN-Design-Erkundungen (bio-kybernetisch). Kontext für spätere Optik/Identität; für Trading-Funktion niedrig. |

> Antigravity-Chats liegen nicht als Datei im Projekt; ausgelesen per Bildschirm. Das „Visual Design Audit" ist als Artefakt in der Konversation gespeichert (bei Bedarf in Antigravity erneut über den Verlauf öffnen).

## A5. Nachträglich gefundene Vorarbeit (ZIP-Archive & Word/RTF) — hohe Relevanz

Aus `…/Desktop/` (Archive + Office-Dateien), ausgewertet und in den Blueprint eingearbeitet:

| Quelle | Inhalt | Eingeflossen in |
|---|---|---|
| `…KI-Trading-Plattform-Konzepts.zip` → **„Gladiator AI 2026 — Blueprint der Dominanz (Single Source of Truth).md"** | Dein ID-referenzierter Master-Katalog (AGENT/STRAT/LEAK/SAFE/UPG). | `01`, `10`, `13` |
| „Gladiator AI - Vollständige Systemanalyse.md", „…Aktueller Systemzustand.md", `A_BACKEND_ANATOMIE.md` | Ist-Zustand, 8-Stufen-Pipeline, Bottlenecks. | `02`, `04` |
| „C) …Schwachstellen (Warum verliert das System Geld?).md" | 10 quantifizierte „Geld-Leaks" (Regime-Blindheit, Concept Drift, Fees…). | `02`, `03`, `08` |
| „Deep Research Synthese: Weltklasse-Strategien…", `erweitertes_expertendokument.md` | Self-Evolving Loop, Event-Driven, LLM-as-a-Judge, MLOps. | `08` |
| `Dokument.rtf` (Signal-Generator/Automatisierer) + „THÆX — Vollständige Systemarchitektur.md" | **VDB1/VDB2, RAPS, Cluster, Hebel×TP-Schema.** | **`13` (neu)** |
| `F) Compliance & Safety (High-Stakes, verbindlich).md` | 10 SAFE-Kill-Switches, MiFID II Art. 17, MAR, BCP. | **`10` §5a/§5b** |
| `TECHNICAL_DOCUMENTATION.md.docx` (Backendinator V4.0) | Signal-Routing (Gruppen/Subgroups/API-Keys), llmNodes, PineEvaluator. | `02`, `04`, `07` |
| `Gladiator_AI_Warroom_Blueprint.docx` | Gamification (XP, Squads, Prestige, Alecto, Sammelkarten). | **`14` (neu)** |
| `App bilder/UX-Analyse…docx`, `UX Expert Finalization.docx`, „B) UI/UX-Mapping", „E) Wiederbelebung der UI" | UI-Audit, „tote Elemente", Cmd+K, Density, UX-Risiken. | **`09` §5–7** |
| `backendinator-complete-code.zip` (`signal-routing-system/`) | Original-Manus-Backend-Code (Referenz, nicht übernehmen). | Referenz |

> Hinweis: Die Manus-Docs beschreiben teils eine ältere Codebasis (MySQL/TiDB + Manus-OAuth, CHAMÆLIEN-Emerald-Optik, Daten-Proxies, synthetische Candles, Yahoo). Diese Punkte wurden **bewusst NICHT** übernommen — der Blueprint-Stand (Postgres, echte Daten, Schwarz-Gold-Optik) ist hier maßgeblich.

## D. Externe Quellen (Recherche 06/2026)

- Hyperliquid: [Docs/API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api), [Python-SDK](https://github.com/hyperliquid-dex/hyperliquid-python-sdk)
- dYdX v4: [Docs](https://docs.dydx.xyz/), [Tooling-Grant](https://www.dydx.foundation/blog/strengthening-dydx-developer-tooling-dydx-grants-funds-nethermind-for-api-docs-client-upgrades-rust-python-support)
- CCXT: [Docs](https://docs.ccxt.com/), [GitHub](https://github.com/ccxt/ccxt), [CCXT Pro](https://deepwiki.com/ccxt/ccxt/4-websocket-api-(ccxt-pro))
- TradingView→DEX: [tradingview-alert-connector](https://github.com/junta/tradingview-alert-connector), [Webhook-Alerts](https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/)
- Backtesting/Bots: [Freqtrade](https://www.freqtrade.io/), [Jesse](https://jesse.trade/), [Hummingbot](https://hummingbot.org/), [best-of-algorithmic-trading](https://github.com/PlaceNL2026/best-of-algorithmic-trading)
- KI-Agenten: [TradingAgents](https://arxiv.org/html/2412.20138v3), [AI-Trader Benchmark](https://arxiv.org/pdf/2512.10971)
- Claude Code: [Best Practices](https://code.claude.com/docs/en/best-practices)

---

**Ende des Blueprint-Pakets.** Einstieg: `00_README_START_HIER.md`.
