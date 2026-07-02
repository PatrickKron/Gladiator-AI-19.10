# 06 · Börsen-Anbindung (CEX + DEX) & Risk-Engine

Das „Handeln". Einheitlicher Order-Layer über zentrale **und** dezentrale Börsen, mit Wallet-/Schlüssel-Sicherheit und einer **harten Risk-Engine vor jeder Order**.

---

## 1. Einheitliches Trading-Interface

Alle Börsen — CEX wie DEX — liegen hinter **einem** Interface, damit Strategien venue-agnostisch sind:

```ts
interface TradingVenue {
  id: string;                       // "binance" | "okx" | "hyperliquid" | "dydx" | "gmx"
  type: 'cex' | 'dex';
  capabilities: { perps: boolean; spot: boolean; reduceOnly: boolean; stopOrders: boolean; maxLeverage: number };
  getMarkets(): Promise<Market[]>;
  getBalance(): Promise<Balance>;
  getPositions(): Promise<Position[]>;
  placeOrder(o: OrderRequest): Promise<OrderResult>;     // market/limit, TP/SL
  closePosition(symbol: string): Promise<OrderResult>;   // reduceOnly
  streamFills(cb): Unsubscribe;                          // Websocket
  validate(): Promise<boolean>;
}
```

Das vorhandene `ExchangeConnector.ts`/`TradeExecutor.ts` ist die Vorlage für die CEX-Implementierung und wird gehärtet (siehe `02_…` §5).

## 2. CEX — zentrale Börsen (ccxt + ccxt pro)

- **Bibliothek:** `ccxt` (REST, 100+ Börsen, einheitliche API) + **`ccxt pro`** für Websocket-Streams (Orderbook, Trades, Ticker, OHLCV, **Orders/Fills/Balance** in Echtzeit). ccxt pro übernimmt Reconnect/Keep-Alive automatisch.
- **Start-Börsen:** Binance (inkl. **Testnet** — `BINANCE_TESTNET` endlich nutzen!), OKX, Bybit.
- **Order-Typen:** Market, Limit, **Stop-Market** (SL), **Take-Profit-Market** (TP), `reduceOnly` für Close. Später OCO/Trailing.
- **Sicherheit:** API-Keys read+trade, **niemals** withdraw. IP-Whitelist auf der Börse. Keys verschlüsselt im Vault (siehe `10_…`).

## 3. DEX — dezentrale Börsen (neu in v2)

Ziel: Perp-DEX-Handel ohne Verwahrung durch Dritte. Adapter pro DEX. **Priorisierung:** zuerst **Hyperliquid** (bestes Sicherheitsmodell), dann **dYdX v4**; **GMX v2** und **Bluefin** sind **optional/später**.

| DEX | Anbindung | Besonderheit |
|---|---|---|
| **Hyperliquid** | offizielle SDKs (Python/TS/Rust), zero-custody REST | On-Chain-Orderbook, Sub-Sekunden-Ausführung, Limit/Market/Stop/TP/TWAP/Scale, bis 50× Hebel. **API-Wallets können handeln, aber NICHT auszahlen** — ideales Sicherheitsmodell. |
| **dYdX v4** | TS/Python/Rust-Clients, Indexer-HTTP + Websocket | Cosmos-Appchain; hohe Liquidität; SDK-Parität (Grant an Nethermind 2025). |
| **GMX v2** | On-Chain (Arbitrum/Avalanche), Contract-Calls | Pool-basiert; gut für größere Size/weniger HFT. |
| **Bluefin** | SDK | Sui-basiert, Orderbook-Perp. |

> **Sicherheits-Kernregel DEX:** Es wird mit **API-/Agent-Wallets** gearbeitet, deren Schlüssel nur **handeln**, nicht **auszahlen** können. Der private Schlüssel der Haupt-Wallet verlässt **nie** den Server/dein Gerät. (Hyperliquid bietet das nativ; bei dYdX/GMX über dedizierte Trading-Subaccounts/eingeschränkte Wallets abbilden.) **Schlüssel/Seed erzeugst und hinterlegst immer du selbst** — der Agent fragt sie über den Vault ab, sieht sie nie im Klartext.

## 4. Pine/TradingView → DEX/CEX (Brücke)

Für Pine-Scripts und externe Signale (siehe `07_…`) dient die bewährte Pipeline **TradingView-Alert (Webhook, JSON) → Receiver → Order-Router**. Als Referenz/Basis existiert das Open-Source-Projekt **`tradingview-alert-connector`** (junta), das Alerts bereits zu **dYdX v4, GMX v2, Hyperliquid, Bluefin, Perpetual Protocol** routet. v2 baut einen eigenen, abgesicherten Receiver (Signaturprüfung, Risk-Gate) statt ungeschützt Orders auszulösen.

## 5. Order-Lifecycle (robust)

```
Signal (freigegeben) → Risk-Gate → Sizing → placeOrder(market/limit)
   → orderId persistieren (orders)
   → TP/SL als separate Orders setzen (idempotent, mit Retry)
   → Websocket-Fills → positions/executed_trades aktualisieren
   → PositionMonitor (Stream + cron-Fallback) schließt bei TP/SL
   → bei Fehler: definierter Recovery-Pfad (Position nie ungeschützt offen lassen)
   → alles in audit_log
```

Verbesserungen gegenüber v1: **Idempotenz** (clientOrderId), **Retry** bei TP/SL-Fehler, **Reconciliation** beim Start (offene Orders/Positionen mit DB abgleichen), **Websocket-Fills** statt nur Minuten-Polling.

## 6. Risk-Engine (Pflicht-Gate VOR jeder Order)

Keine Order ohne grünes Risk-Gate. Konfigurierbar pro User (`trading_settings`) und global:

| Limit | Beispiel-Default | Wirkung |
|---|---|---|
| Risiko pro Trade | ≤ 2 % des Kontos | bestimmt Positionsgröße via SL-Abstand |
| Max. Hebel | Cap je Setup/Asset (z. B. 10×) | überstimmt Leverage-Upgrade |
| Max. offene Positionen | z. B. 5 | verhindert Über-Exposure |
| Max. Exposure je Asset/Cluster | z. B. 20 % | Korrelations-/Cluster-Limit |
| Tages-Verlustlimit | z. B. −6 % | Kill-Switch für den Tag |
| Max. Drawdown | z. B. −15 % | globaler Stopp |
| Margin-Check | Pflicht | Order nur wenn Margin reicht |
| Slippage-/Min-Size-Check | Pflicht | unrealistische Orders ablehnen |
| News-/Event-Sperre | CPI/Leitzins = No-Trade | aus Wirtschaftskalender |

**Positionsgröße** = (Konto × Risiko%) / (Entry − SL) — *vereinfacht* für lineare Instrumente. Der jeweilige Börsen-Adapter rechnet **exakt** unter Berücksichtigung von Kontraktgröße, Tick-/Lot-Size, Mindest-Notional und inversen/coin-margined Perps (dort gilt die Formel anders). **Kill-Switch** global und pro Strategie. Jede Limit-Änderung ist auditiert und (für Erhöhungen) durch dich zu bestätigen.

## 7. Paper- & Testnet-Modus

Derselbe Code-Pfad, anderer Adapter: Binance-Testnet, dYdX-Testnet, Hyperliquid-Testnet bzw. interne Paper-Engine (füllt Orders gegen echte Live-Preise, ohne Geld). **Standard ist Paper.** Live wird pro Börse explizit freigeschaltet, nachdem Risk-Engine + Reconciliation grün sind.

## 7a. Börsen-Rate-Limits & Bans

Multi-Asset-Scans über viele Symbole rennen schnell in Limits. Pflicht: ccxt-`enableRateLimit`, Beachtung der **gewichteten** Limits (z. B. Binance „weight"), exponentielles **Backoff** bei 429/418, Request-Bündelung/Caching, und Verteilung der Scans über die Zeit. Verbindungs-/Ban-Status wird überwacht (siehe §7b).

## 7b. Observability, Monitoring & Dead-Man's-Switch (überlebenswichtig)

Ein handelndes System braucht das von Anfang an — **nicht** erst in der Härtungsphase:

- **Strukturiertes Logging** (JSON) + zentrale Sammlung; **Audit-Log** für jede Order/Limit-Änderung.
- **Health-Checks** je Börsen-/WS-Verbindung; Metriken (offene Positionen, Exposure, Tages-PnL, Order-Latenz, Fehlerquote).
- **Alarme** (Push/Telegram/E-Mail) bei kritischen Zuständen — insbesondere **„offene Position + toter Preis-Stream"**, fehlgeschlagene TP/SL-Platzierung, Börse nicht erreichbar, Limit-Verletzung.
- **Dead-Man's-Switch:** Verliert das System seinen Heartbeat/seine Marktverbindung über eine definierte Zeit, werden offene Positionen automatisch abgesichert/geschlossen (Auto-Flat) bzw. neue Orders gesperrt.

## 7c. Disaster-Recovery / Failure-Modes (Runbook)

Definierte Antworten auf reale Ausfälle (über die Start-Reconciliation aus §5 hinaus):

| Fehlerfall | Antwort |
|---|---|
| Server-Crash mit offener Position | Beim Neustart: Reconciliation (Börse = Wahrheit) → DB abgleichen → fehlende TP/SL neu setzen → ggf. Auto-Flat falls ungeschützt |
| Websocket-Disconnect | Reconnect mit Backoff; Fallback auf REST-Polling; bei längerem Verlust → Dead-Man's-Switch |
| Börse down / API-Fehler | Neue Orders sperren; bestehende SL bleiben auf der Börse; Alarm |
| Doppelte/fehlende Fills | Idempotenz via clientOrderId; Abgleich gegen Börsen-Order-Historie |
| DB nicht erreichbar | Trading pausieren (fail-safe, nicht fail-open); Alarm |

## 8. Was bewusst NICHT automatisiert wird

- **Keine Ein-/Auszahlungen, keine Transfers, keine Swaps** durch den Agenten. Der Agent handelt nur innerhalb bereits eingezahlter Trading-Accounts/Subaccounts.
- **Keine Schlüssel-Erzeugung im Klartext durch den Agenten.** Du legst Wallets/Keys an; der Agent nutzt nur eingeschränkte, nicht-auszahlungsfähige Trading-Keys.
- Diese Grenzen sind in der Risk-Engine hart kodiert.

## Quellen (Recherche 06/2026)

- [Hyperliquid Docs / API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api) · [Python-SDK](https://github.com/hyperliquid-dex/hyperliquid-python-sdk)
- [dYdX v4 Docs](https://docs.dydx.xyz/) · [dYdX Developer-Tooling-Grant 2025](https://www.dydx.foundation/blog/strengthening-dydx-developer-tooling-dydx-grants-funds-nethermind-for-api-docs-client-upgrades-rust-python-support)
- [CCXT Docs](https://docs.ccxt.com/) · [CCXT GitHub](https://github.com/ccxt/ccxt) · [CCXT Pro WebSocket](https://deepwiki.com/ccxt/ccxt/4-websocket-api-(ccxt-pro))
- [tradingview-alert-connector (DEX-Routing)](https://github.com/junta/tradingview-alert-connector)
- [TradingView Webhook-Alerts konfigurieren](https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/)

➡️ Weiter mit **`07_PINE_UND_ANWEISUNGEN.md`**.
