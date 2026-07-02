# 02 · Ist-Analyse (was heute existiert)

Verbindliche Bestandsaufnahme der aktuellen Codebasis. Pfade relativ zu `Antigravity Gladiator AI versuch 1/`. Zweck: Claude Code soll wissen, **was übernommen** und **was ersetzt** wird.

---

## 1. Überblick: drei Code-Stände, einer zählt

| Teil | Pfad | Status |
|---|---|---|
| **Node-Backend (aktiv)** | `backend-node/` | Node 22 + TypeScript + Express 5 + tRPC 11 + Drizzle/SQLite. **Das ist das echte Backend.** |
| Python-Backend (Altlast) | `backend/` | FastAPI + eigene DB + `setup_demo_data.py`. **Tot — beim Neuaufbau entfernen.** |
| Web-Frontend (aktiv) | `frontend-web/` | React 18 + Vite + Tailwind + tRPC-Client. |
| frontend-admin / frontend-mobile | `frontend-admin/`, `frontend-mobile/` | Ungenutzt — entfernen. |
| Desktop-Prototypen | `…/Desktop/GladiatorAI/` u. a. | Python-Signal-Bot (OKX→Telegram). Konzept-Goldgrube, Code nicht übernehmen (siehe `05_…`). |

**Datenbank:** `backend-node/gladiator_v2.db` (~60 MB) ist die aktive DB (221 Assets, 8.398 Signale, 205k Strategie-Signale, 40 Magazin-Artikel, 35 Pakete, 1 Admin-User). Daneben liegen verwaiste DBs (`db.sqlite` leer, `gladiator.db`).

## 2. Tech-Stack (aktiv)

- **Backend:** Express 5, tRPC 11, Drizzle ORM, `better-sqlite3`. Externe Libs: `ccxt` (Börsen), `yahoo-finance2`, `openai`, `technicalindicators`, `node-cron`, `web-push`, `resend`, `bcryptjs`, `jsonwebtoken`, `zod`.
- **Frontend:** React/Vite (`.jsx`), `@trpc/react-query`, eigener REST-Client (`src/api/client.js`), Framer Motion, Lucide Icons.
- **Proxy:** Vite (`:3000`) proxyt `/api` → Backend (`:3001`).

## 3. Datenfluss

```
Frontend (React/Vite :3000)
  ├─ tRPC-Client  →  /api/trpc           →  appRouter (src/routers.ts, ~2680 Zeilen)
  └─ REST-Client  →  /api/auth/*, /api/v1/*, /api/signale …  (src/index.ts)
                          │
                          ├─ Services (src/services/*)
                          │     ├─ ccxt → Binance / OKX / Alpaca
                          │     ├─ yahoo-finance2 → Aktien/Indizes/Forex
                          │     ├─ openai → GPT-Module
                          │     └─ resend / web-push / cryptopanic
                          └─ Drizzle ORM → SQLite (gladiator_v2.db)
```

**Hintergrund-Jobs** (gestartet in `src/index.ts` `start()`):
ThaexWatcher (Loop) · ContentScheduler (Loop) · PositionMonitor (cron `* * * * *`) · LlmSignalProcessor (10 s, nur mit Key) · StrategyEngine (Intervall pro Kategorie) · StudyScheduler (1 h, feuert So 03:00 CET) · GrsEngine (30 s) · HedgingService (10 s / 60 min).

## 4. tRPC-Router-Landkarte (`src/routers.ts`)

`groups`, `subgroups`, `signals`, `apiFetchers`, `llmNodes`, `strategyTracking`, `calendar`, `aiChat`, `marketData`, `oracle`, `signalAI`, `tradingSignals`, `leverage`, `channels`, `newsletter`, `magazine`, `packages`, `assets`, `pricing`, `content`, `trading`, `exchange`, `push`, `strategySignals`, `studyKi`, `hedging`, `synapse`.

Wichtig: **echte Order-Ausführung** liegt nur in `strategySignals.confirmTrade` (≈ Z. 1924/2006). Der `trading`-Router hat **kein** `executeTrade`.

## 5. Was ist ECHT (übernehmen / als Referenz behalten)

| Service | Datei | Funktion |
|---|---|---|
| UnifiedPriceService | `services/UnifiedPriceService.ts` | Multi-Asset-Preise echt (Yahoo + ccxt), 60 s Cache. **Zentrale Preisquelle.** |
| MarketDataService | `services/MarketDataService.ts` | Crypto OHLCV/Funding/OI/Volatilität via ccxt. |
| ExchangeConnector | `services/ExchangeConnector.ts` | AES-256-GCM-Key-Verwaltung; ccxt-Instanzen (Binance/OKX/Alpaca); `getBalance/getPositions/validateCredentials` echt. |
| TradeExecutor | `services/TradeExecutor.ts` | Echtes Order-Handling: `createMarketOrder`, TP/SL via `stop_market`/`take_profit_market`, `closePosition` (`reduceOnly`). |
| PositionMonitor | `services/PositionMonitor.ts` | cron 1 min, schließt bei TP/SL. |
| GrsEngine | `services/GrsEngine.ts` | Global Risk Score aus VIX/DXY/US10Y/VVIX. |
| LlmSignalProcessor | `services/LlmSignalProcessor.ts` | OpenAI-Knotenverarbeitung (mit Key). |

➡️ Diese Schicht ist das **tragfähige Skelett** für echtes Trading und wird in v2 als Basis übernommen (aber gehärtet, siehe `06_…`).

## 6. Was ist FAKE / Mock (ersetzen) — Kurzfassung

Vollständige Tabelle mit Datei:Zeile in **`03_MOCKUP_BEFREIUNG.md`**. Die schwerwiegendsten:

- **`frontend-web/src/context/AuthContext.jsx`** — `MOCK_AUTH = true` → Auto-Login als `mock-admin-id`. **Es gibt de facto keine Authentifizierung.**
- **`frontend-web/src/main.jsx`** — tRPC-Calls senden **keinen** Authorization-Header (auskommentiert).
- **`backend-node/src/_core/trpc.ts`** — `protectedProcedure` fällt bei fehlender Auth still auf **Demo-User 1** zurück → kein Tenant-Schutz.
- **`services/SynapseOracle.ts`** (43 KB) — Gravity/Pulse/Footprint/DNA, FRED/VIX/MVRV/COT/Buffett-Werte größtenteils **`Math.random()`**.
- **`services/StrategyEngine.ts`** — Nicht-Crypto-Kerzen per **Random-Walk**; **Trade-Ausgänge per `Math.random()` simuliert** → die ganze „Studien-KI" trainiert auf Fantasiedaten.
- **`services/{BlockSentinel,ProjectOracle,ShadowGPT}.ts`** — `getMockSignal/getMockAnalysis` ohne Key.
- **`services/MacroProvider.ts`** — komplett Mock (hartkodierte CPI/Fed/GDP-Events).
- **`services/ImpactService.ts`** — fiktives $10k-Portfolio.
- **`services/LiquidationService.ts`** — `getMockHeatmapData`.
- **`frontend-web/src/pages/Oracle.jsx`** — `PREVIEW_MODE = true`, ~78 Zeilen hartkodierte Mock-Analyse.
- **`src/index.ts`** — `/api/signale`, `/api/abonnements/aktuell`, `/api/pakete` liefern hartkodierte Mock-Objekte.

## 7. Schwachstellen & blinde Flecken (kritisch)

**Sicherheit**
- JWT-Fallback `'secret'` an 3 Stellen (`index.ts:50,73`, `_core/trpc.ts:23`) → Tokens fälschbar.
- `protectedProcedure` umgeht Auth → alle „geschützten" Daten offen.
- `app.use(cors())` ohne Origin-Whitelist (`index.ts:16`).
- Encryption-Key-Fallback `'default-key-32-characters-long!'` (`ExchangeConnector.ts:19`) → gespeicherte Börsen-Keys mit bekanntem Schlüssel reversibel.
- Kein Rate-Limiting, keine RBAC-Erzwingung (`role:'admin'` wird nie geprüft), viele Procedures nehmen `userId` als **Input** statt aus `ctx`.

**Trading-Risiko**
- Keine Risk-Limits (max. Positionsgröße, Hebel-Cap, Tages-/Drawdown-Limit, Margin-Check) **vor** der Order.
- Position-Size hartkodiert `100` (`routers.ts:2002`); TP/SL ohne Retry/Idempotenz; bei `setTPSL`-Fehler bleibt Position ungeschützt offen.
- Kein Slippage-/Mindestordergrößen-Check; keine saubere Paper-/Live-Trennung.

**Daten/„Intelligenz"**
- „Studien-KI" / „Oracle" basieren auf simulierten Zufallsdaten → ohne echte Historie wertlos.
- Makro (FRED), On-Chain (MVRV/Flows), COT, Liquidations-Heatmap, VIX-Detail = alles Mock.

**Technik/Architektur**
- **SQLite** (synchron/blockierend, kein Multi-Instanz); Kommentar im Code sagt selbst „in production use MySQL".
- Dynamische `await import()` in fast jeder Procedure (Performance/Lesbarkeit).
- **Doppel-Backend** (Python + Node), drei redundante DBs, Dutzende lose Test-/Debug-Skripte im Backend-Root.
- Zwei nicht verknüpfte Signaltabellen (`tradingSignals` String-Preise vs. `strategySignals` Cents-Integer); FK-Inkonsistenzen bei `executedTrades`.
- Keine echte Test-Suite, keine CI.

## 8. Fazit für den Neuaufbau

Übernimm das **Live-Trading-Fundament** (ExchangeConnector, TradeExecutor, verschlüsselte Keys, PositionMonitor, UnifiedPriceService) als Referenz und **härte** es. Ersetze die gesamte **„Intelligenz"-Schicht** durch echte Datenquellen und echtes Backtesting. **Höchste Priorität:** echte Auth/RBAC + Tenant-Isolation, Secret-Management ohne Fallbacks, Risk-Engine vor jeder Order, DB-Migration SQLite→Postgres, Entfernung des toten Python-Backends. Details: `03_…` (De-Mock), `04_…` (Zielarchitektur), `06_…` (Risk/Börsen), `10_…` (Sicherheit).

➡️ Weiter mit **`03_MOCKUP_BEFREIUNG.md`**.
