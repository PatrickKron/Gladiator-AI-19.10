# 04 · Zielarchitektur

Die Soll-Architektur von Gladiator AI v2. Ziel: **ein** Backend, **ein** Signal-Datenmodell, **eine** Strategie-Engine, klare Trennung von „Denken" (Signale/Agenten) und „Handeln" (Order/Risk).

---

## 1. Leitprinzipien

1. **Monorepo, klare Pakete.** Ein Repo, mehrere Pakete mit eigener Verantwortung und je eigener `CLAUDE.md`.
2. **Schichten statt Spaghetti.** Marktdaten → Strategie → Signal → Risk → Ausführung → Auswertung. Jede Schicht ist einzeln testbar.
3. **Adapter-Muster überall.** Börsen (CEX/DEX), Datenquellen, LLM-Provider sind hinter einheitlichen Interfaces austauschbar.
4. **Event-getrieben.** Marktereignisse, Signale, Orders, Fills laufen über einen internen Event-Bus (später optional Redis/NATS).
5. **Sicher per Default.** Auth, Risk-Limits, Vault sind Pflichtpfade, keine optionalen Add-ons.
6. **Paper ≡ Live.** Derselbe Code-Pfad für Paper und Live; nur der Adapter (Testnet/Live) und die Limits unterscheiden sich.

## 2. Empfohlener Tech-Stack

| Bereich | v1 (heute) | v2 (Empfehlung) | Begründung |
|---|---|---|---|
| Sprache Backend | TS | **TypeScript** (beibehalten) | Vorhandenes Know-how, ein Typ-System FE+BE |
| API | tRPC 11 | **tRPC 11** (beibehalten) | Typsicher FE↔BE; bewährt |
| DB | SQLite | **PostgreSQL** (+ TimescaleDB für OHLCV/Trades) | Concurrency, Multi-Instanz, Zeitreihen |
| ORM | Drizzle | **Drizzle** (beibehalten) | Migrationsaufwand gering |
| Börsen CEX | ccxt | **ccxt + ccxt pro** | 100+ Börsen, Websocket-Streams |
| Börsen DEX | — | **Hyperliquid / dYdX v4 / GMX v2 / Bluefin SDKs** | echte DEX-Anbindung (siehe `06_…`) |
| Backtesting | fingiert | **eigene TS-Engine** + optional **Freqtrade/Jesse (Python-Service)** | echtes, look-ahead-freies Testen |
| LLM | OpenAI | **Provider-Router** (OpenAI/Anthropic + lokal via Ollama) | Kosten/Datenschutz, Fallback |
| Queue/Jobs | node-cron | **BullMQ (Redis)** | robuste Hintergrund-Jobs statt loser Loops |
| Realtime FE | — | **WebSocket/SSE** | echte Live-Logs/Preise (statt Fake-Terminal) |
| Frontend | React/Vite | **React/Vite + Tailwind** (neues Design, siehe `09_…`) | Redesign per Claude Design |
| Auth | (mock) | **JWT + Refresh + RBAC**, optional OAuth | echte Mehrbenutzer-Trennung |
| Secrets | .env/Fallbacks | **Vault/Doppler/SOPS**, AES-GCM für Börsen-Keys | keine Klartext-Fallbacks |
| Deploy | lokal | **Docker Compose** (Hetzner/VPS), nginx-TLS | reproduzierbar, lokal-first möglich |

> Pragmatischer Mittelweg: Crypto-Backtesting/-Optimierung kann ein **separater Python-Service** (Freqtrade/Jesse) sein, den das TS-Backend über eine interne API anspricht — so nutzt du die ausgereiften Python-Backtester, ohne den TS-Hauptpfad zu verlassen.

## 3. Monorepo-Struktur (Vorschlag)

```
gladiator-v2/
├─ CLAUDE.md                      # Root-Konventionen (aus 11_…)
├─ docker-compose.yml
├─ packages/
│  ├─ core/                       # geteilte Typen, Zod-Schemas, Signal-Datenmodell, Event-Bus
│  ├─ market-data/                # Adapter: ccxt(pro), Yahoo, FRED, On-Chain, News, Kalender
│  ├─ strategy-engine/            # Indikatoren, SMC-Strategien, Scoring, Setups, Pine/DSL-Runner
│  ├─ exchange/                   # CEX+DEX-Adapter, Order-Router, Wallet/Key-Vault
│  ├─ risk/                       # Risk-Engine: Limits, Sizing, Kill-Switch, Margin-Check
│  ├─ agents/                     # KI-Agenten-Schwarm (Technik/Makro/Shadow/Risk/Devil)
│  ├─ backtest/                   # Backtesting + Walk-Forward + Optimierung (TS, ggf. + Python-Service)
│  ├─ api/                        # Express + tRPC-Router, Auth, WebSocket-Gateway
│  ├─ jobs/                       # BullMQ-Worker: Scans, Monitoring, Nacht-Pipeline
│  └─ db/                         # Drizzle-Schema + Migrationen (Postgres)
├─ apps/
│  └─ web/                        # React/Vite-Frontend (neues Design)
└─ services/
   └─ quant/                      # optionaler Python-Backtest-/Optimierungs-Service
```

## 4. Domänen-Datenfluss (Soll)

```
            ┌──────────────── market-data (echt, Streams) ────────────────┐
            │ ccxt pro | Yahoo | FRED | On-Chain | News | Wirtschaftskalender│
            └───────────────────────────┬─────────────────────────────────┘
                                         ▼
                              strategy-engine
            (Indikatoren → SMC-Strategien/Pine/DSL → Setup-Kandidaten + Score)
                                         ▼
                     agents (Schwarm prüft & verfeinert Signal)
        Technik · Makro(Oracle) · Shadow(Manipulation) · Risk · Devil's Advocate
                                         ▼
                                 SIGNAL (kanonisch)
                                         ▼
                 ┌──────────────── risk-engine (Gate) ─────────────────┐
                 │ Limits, Sizing, Margin, Korrelation, Kill-Switch      │
                 └───────────────────────────┬──────────────────────────┘
                          (abgelehnt)         │ (freigegeben + Bestätigung)
                                              ▼
                                exchange / order-router
                          CEX (ccxt)  ||  DEX (Hyperliquid/dYdX/GMX)
                                              ▼
                          Fills/Positions (Websocket) → executedTrades
                                              ▼
                 backtest/optimizer ← echte Ergebnisse → Strategie-Verbesserung
                                              ▼
                          UI (Web) + Push + Telegram (Ausspielung)
```

## 5. Kanonisches Signal-Datenmodell (eine Wahrheit)

Ersetzt die zwei alten Tabellen (`tradingSignals` String-Preise vs. `strategySignals` Cents). **Ein** Schema, Preise als `numeric`/Decimal, Zeit als `timestamptz`:

```ts
// packages/core/signal.ts (konzeptionell)
type Signal = {
  id: string;
  createdAt: string;              // ISO
  source: 'engine' | 'pine' | 'instruction' | 'manual';
  strategyId: string;
  symbol: string;                 // z.B. "BTC/USDT" oder DEX-Market
  assetClass: 'crypto'|'stock'|'etf'|'forex'|'commodity'|'index';
  venueType: 'cex'|'dex';
  direction: 'long'|'short';
  setupType: 'scalp'|'swing'|'position';
  entry: number; stopLoss: number;
  takeProfits: number[];          // TP1..n
  leverageSuggested: number;
  score: number;                  // 0..10, ECHT berechnet (nie hartkodiert)
  riskClass: 'low'|'medium'|'high';
  confluence: string[];           // ["BOS","EMA200-Trend","Retest@EMA50","RSI-Band","Volume"]
  session: 'asia'|'london'|'newyork'|'off';
  reentry?: { enabled: boolean; minPullbackPct: number; maxPullbackPct: number };
  leverageUpgrade?: { triggerPct: number; maxLeverage: number };
  agentReview?: AgentVerdict[];   // Urteile des Schwarms (siehe 08_)
  status: 'new'|'confirmed'|'rejected'|'expired'|'filled'|'closed';
  tier: 'free'|'pro'|'vip';       // Ausspiel-Stufe
};
```

`executed_trades` trägt zusätzlich **echte Kostenfelder**: `makerTakerFee`, `slippage`, `fundingPaid`, `netPnl` (= brutto − Gebühren − Funding). Diese Felder sind Pflicht, damit Auswertung und Backtesting (siehe `08_…` §3a) **netto** rechnen — sonst sind alle Kennzahlen geschönt.

## 6. Datenbank-Schema (Soll, Postgres) — Kerntabellen

- **Auth/Tenancy:** `users`, `sessions`, `roles`, `apiKeys` (für externe Integrationen).
- **Marktdaten (Timescale):** `ohlcv` (hypertable: symbol, tf, ts, ohlcv), `funding_rates`, `open_interest`, `macro_series`, `economic_events`.
- **Strategie/Signal:** `strategies`, `strategy_versions` (Parameter-Sätze), `signals` (kanonisch, s. o.), `signal_reviews` (Agenten-Urteile).
- **Trading:** `exchange_credentials` (Vault-Referenz, kein Klartext), `trading_settings` (Risk%, max-Leverage, Limits), `orders`, `executed_trades` (Entry/Exit/PnL als numeric, orderId, venue), `positions` (live, aus Stream).
- **Backtest/Optimierung:** `backtests` (Config+Metriken: Sharpe/Sortino/MaxDD/WinRate/ProfitFactor), `walkforward_runs`, `optimizations` (Parameter→Score).
- **Produkt:** `packages`, `assets`, `package_subscriptions`, `pricing`, `channels`, `channel_subscriptions`, `magazine_articles`, `newsletter_subscribers`, `push_subscriptions`.
- **Audit:** `audit_log` (jede Order/Limit-Änderung/Login — unveränderlich).

Migration der alten SQLite-Daten: ein einmaliges Skript portiert `assets`, `packages`, `magazineArticles`, `users` (Passwort-Hashes bleiben gültig). Alte Signal-/Studien-Daten werden **nicht** übernommen (sie sind teils synthetisch).

## 7. Andockbarkeit an „Chamäleon"

Gladiator AI v2 ist als eigenständige App **und** als Subsystem nutzbar:
- Das `api`-Paket exponiert eine saubere, versionierte Schnittstelle (tRPC + optional REST/MCP-Server).
- Agenten sind als **Tools** (Funktions-Calls) registriert → eine übergeordnete Chamäleon-Orchestrierung kann „Trading-Tools" direkt aufrufen.
- UI-Seiten sind modular (eigene Routen), so dass sie als Reiter in eine größere Oberfläche einklinkbar sind.

## 8. Datenquellen — Lizenz & Kosten (wichtig fürs kommerzielle Produkt)

Datenquellen sind ein rechtliches **und** finanzielles Risiko, das früh geklärt werden muss (nicht erst beim Launch):

| Quelle | Verwendung | Lizenz/Kosten — Achtung |
|---|---|---|
| **Yahoo Finance** | Aktien/ETF/Forex-Kurse (v1 nutzt es) | **Kein kommerzielles Nutzungsrecht** (ToS-Graubereich). Für eine Bezahl-Plattform riskant → durch lizenzierte Quelle ersetzen. |
| **ccxt / ccxt pro** | CEX-Daten & Trading | ccxt frei (MIT); ccxt **pro** = kostenpflichtige Lizenz für WS-Streams. |
| **Polygon.io / Alpaca** | Aktien/ETF/Forex (lizenziert) | Bezahlte Tiers, Rate-Limits. Empfohlene Yahoo-Alternative. |
| **FRED** | Makro-Zeitreihen | Frei, API-Key, faire Limits. |
| **TradingEconomics / FMP** | Wirtschaftskalender | Bezahlte Tiers. |
| **CryptoPanic** | News/Sentiment | Free + bezahlte Tiers. |
| **Glassnode / CoinGlass / Dune** | On-Chain, Liquidations | Teuer; nur einbinden, wenn Feature es rechtfertigt — sonst „nicht verbunden". |

**Konsequenz:** Es gibt einen **Kosten-Wächter nicht nur für LLM, sondern auch für Daten-APIs** (Tagesbudget, Caching, Abschalten bei Limit — siehe `08_…` §2). Für jede Quelle gilt: lizenzkonform nutzen oder ersetzen; nie kommerziell auf einer Graubereich-Quelle aufbauen.

➡️ Weiter mit **`05_STRATEGIE_ENGINE.md`**.
