# 11 · Bauplan für Claude Code (Phasen, Abnahme, CLAUDE.md)

Verbindlicher, phasenweiser Bauplan. **Regel:** immer nur **eine** Phase, dann Tests, dann Abnahme, dann nächste. Spec-driven (diese Blueprint-Dateien sind die Wahrheit), test-getrieben, Kontext-diszipliniert.

---

## 0. Arbeitsweise (für Claude Code)

- **Quelle der Wahrheit:** der Ordner `GLADIATOR_V2_BLUEPRINT/`. Bei Konflikt fragt das Modell nach, statt zu raten.
- **Nested `CLAUDE.md`:** Root-Konventionen + pro Paket eine kurze `CLAUDE.md`.
- **TDD:** zu jeder Funktionseinheit zuerst Tests (rot → grün). Besonders: Risk-Engine, Strategie-Logik, Order-Lifecycle, Auth.
- **Kein Fake:** Mock nur in `__tests__/`. In Laufpfaden 0 Treffer der Mock-Checkliste (`03_…`).
- **Kontext:** pro Phase nur relevante Dateien laden; Kontext < 60 % halten; nach jeder Phase Zusammenfassung in `PROGRESS.md`.
- **Parallel zu v1:** neues Repo `gladiator-v2`; v1 bleibt unberührt, dient als Referenz.

## 1. Phasenplan

### Phase 0 — Fundament & Sicherheit (in 3 Teilphasen, weil zu groß für einen Durchlauf)

**0a — Repo & Schema-Skelett**
- Monorepo-Gerüst (`packages/*`, `apps/web`, `services/quant`), TS-Config, Lint, Test-Runner, **CI** (Tests laufen!).
- **Postgres + Drizzle**-Schema (`db`) aus `04_…` §6; Migrationen; Seed (echte `assets/packages/magazine/users` aus v1 portieren).
- **Abnahme B0a:** Schema migriert; Seed lädt echte v1-Daten; CI grün.

**0b — Auth, RBAC & Tenant-Isolation**
- Echte Auth (JWT + Refresh), Rollen (user/pro/vip/admin), `userId` aus `ctx`, 401 ohne Token; kein `MOCK_AUTH`, kein Demo-User.
- **Abnahme B0b:** Login/Logout echt; geschützte Routen 401 ohne Token; Tenant-Scoping per Test belegt; RBAC erzwungen.

**0c — Secrets & Vault**
- Secret-Management/Vault; AES-GCM für Börsen-/Wallet-Keys; **Boot-Abbruch** ohne Pflicht-Secrets; keine Klartext-Fallbacks.
- **Abnahme B0c:** App startet ohne Pflicht-Secret nicht; Keys verschlüsselt at-rest; `10_…`-Checkliste §1–2 grün.

### Phase 1 — Marktdaten (echt)
- `market-data`: ccxt(pro)-Adapter (Binance/OKX/Bybit, **Testnet**), Yahoo, FRED, Wirtschaftskalender, News. OHLCV in Timescale.
- Realtime-Gateway (WebSocket/SSE) für Live-Preise.
- **Abnahme B1:** echte Live-Preise + historische OHLCV für BTC/ETH/SOL + min. 1 Aktie/ETF; FRED/Kalender liefern echte Werte oder sind klar „nicht verbunden". Keine `Math.random()`-Quelle.

### Phase 2 — Strategie-Engine
- `strategy-engine`: Indikatoren, SMC-Konzepte, **SMC-Core-Referenzstrategie** (Pine-portiert), Multi-Setup, **echtes Scoring**, Session-Gating, Reentry/Leverage-Engine. Strategie-Registry + Versionen.
- **Abnahme B2:** SMC-Core erzeugt auf echten BTC-Daten plausible Signale mit echtem Score; Unit-Tests für BOS/CHoCH/OB/FVG/Retest/Scoring grün; kein hartkodierter Score.

### Phase 3 — Backtesting & Optimierung
- `backtest`: look-ahead-freie Engine (+ optional Python-Service Freqtrade/Jesse). Metriken, Walk-Forward, Optimierung. Nacht-Pipeline (BullMQ).
- **Abnahme B3:** ein vollständiger Backtest auf echten Daten mit Sharpe/MaxDD/WinRate **netto nach Gebühren/Slippage/Funding** (`08_…` §3a); Walk-Forward-Lauf; Optimierungs-Vorschlag erzeugt; Look-ahead- **und** Survivorship-/Datenqualitäts-Checks grün. **Ohne** Kostenmodell keine Promotion.

### Phase 4 — Börsen & Risk (Paper) — in 3 Teilphasen (riskanteste Phase)

**4a — Risk-Engine isoliert (TDD zuerst)**
- `risk`: hartes Gate (Limits, Sizing exakt, Margin-Check, Kill-Switch, Dead-Man's-Switch-Hook). Reine Funktion, voll getestet.
- **Abnahme B4a:** Risk-Engine blockt nachweislich Über-Limit-/Über-Hebel-/Margin-Orders (Testfälle); Sizing korrekt inkl. Tick/Notional.

**4b — CEX-Paper-Lifecycle**
- `exchange`: `TradingVenue`-Interface; CEX (ccxt) gehärtet; Order-Lifecycle (Idempotenz/Retry/Reconciliation/Websocket-Fills) auf **Binance-Testnet**.
- **Abnahme B4b:** Paper-Order End-to-End (Signal→Risk→Order→Fill→PositionMonitor→Close) auf Binance-Testnet; Reconciliation nach simuliertem Crash funktioniert.

**4c — Erster DEX-Adapter**
- **Hyperliquid**-Testnet-Adapter (API-/Agent-Wallet, kein Withdraw); danach dYdX v4 (optional in dieser Phase).
- **Abnahme B4c:** Paper-/Testnet-Order End-to-End auf Hyperliquid; Wallet hat nachweislich keine Auszahlrechte.

### Phase 5 — Agenten + Pine/Anweisungen
- `agents`: Schwarm (Technik/Makro/Shadow/Risk/Devil/Portfolio) + Provider-Router + Kosten-Wächter; Urteile am Signal.
- `api`: Pine-Webhook-Receiver (HMAC), DSL aus Anweisung (LLM→Vorschau→Bestätigung).
- **Abnahme B5:** Signal trägt echte Agenten-Urteile; ein Pine-Webhook erzeugt (über Risk-Gate) eine Paper-Order; eine Text-Anweisung wird zu validierter DSL-Strategie.

### Phase 6 — Frontend (neues Design) — pro Seitengruppe abnehmen
- `apps/web`: Seiten aus `09_…` (Claude-Design-Entwürfe) an echte tRPC-Daten anschließen; Loading/Empty/Error/No-Auth überall; Realtime-Logs/Preise. **Nicht** alle 15 Seiten in einem Durchlauf — in Gruppen schneiden (z. B. 6a Auth+Dashboard, 6b Signals+Strategie-Builder+Backtesting, 6c Trading&Börsen+Settings+Profile, 6d Oracle+Hedging+Strategy-Lab, 6e Pakete+Magazine+Calendar+Pricing).
- **i18n** (DE/EN/IT/ES/FR) mit `i18next`/`react-i18next` von Anfang an; alle Texte über Keys.
- **Abnahme B6:** je Seitengruppe — **echte** Daten oder ehrliche Leerzustände; kein `PREVIEW_MODE`, kein `userId||1`, kein Fake-Terminal; UI steuert Strategien/Orders (Paper); **alle Texte mehrsprachig** (kein hartkodierter Text).

### Phase 7 — Ausspielung, Härtung & (optional) Go-Live
- **Telegram-Ausspielung** (eigene Mini-Spec): Free/Pro/VIP-Routing mit Topic-Threads + Score-Gates (der Code existierte in v1 — `send_signals.py`/`telegram_router.json` als Vorlage) auf echte Signale; Push (Web-Push/FCM).
- **Monetarisierung/Tier-Enforcement:** Zahlungsanbieter (z. B. Stripe) + **serverseitige** Tier-Gates (Free verzögert/weniger, Pro/VIP Echtzeit; Paket-Add-ons). **Erst nach Rechtsklärung** (`10_…` §6).
- **Observability/DR scharf:** Monitoring/Alerting, Dead-Man's-Switch, Crash-Runbook (`06_…` §7b/§7c), **Backup+Restore-Test**.
- Last-/Sicherheitstests, Audit-Log-Review.
- **Live-Freischaltung pro Börse** nach grüner Reconciliation + deiner Bestätigung; konservative Limits.
- **Abnahme B7:** Sicherheits-Checkliste (`10_…` §7) komplett grün; Telegram/Push spielen echte Signale aus; Restore aus Backup getestet; Dead-Man's-Switch greift im Test; optional ein minimaler Live-Trade mit Kleinstgröße erfolgreich + sauber auditiert.

## 2. Globale Abnahmekriterien (gelten immer)

- **Ehrlichkeit:** keine Mock-Daten in Produktion; nicht-verbundene Quellen sichtbar markiert.
- **Sicherheit:** `10_…`-Checkliste je Phase eingehalten.
- **Tests:** neue Logik hat Tests; CI grün; Risk-/Order-Pfade besonders abgedeckt.
- **Eine Wahrheit:** ein Backend, ein Signal-Modell, eine Strategie-Engine; keine Doppel-Implementierungen.
- **Mensch im Loop:** Live-Eskalationen/Limit-Erhöhungen/Promotion neuer Live-Strategien brauchen deine Bestätigung.

## 3. `CLAUDE.md`-Vorlage (Repo-Root)

```md
# Gladiator AI v2 — Arbeitsanweisung für Claude Code

## Quelle der Wahrheit
Der Ordner GLADIATOR_V2_BLUEPRINT/ ist die verbindliche Spezifikation. Bei Konflikt: nachfragen, nicht raten.

## Eiserne Regeln
1. KEIN Fake. Keine Math.random()-Daten, kein Mock/Demo/Platzhalter in Laufpfaden. Nicht-verbundene Quellen sichtbar als "nicht verbunden" markieren.
2. Sicherheit zuerst: echte Auth/RBAC/Tenant-Scoping; keine Klartext-Secret-Fallbacks; Risk-Engine vor jeder Order.
3. Paper-Default. Live nur nach expliziter Freigabe.
4. TDD: erst Tests, dann Code — v.a. Risk-Engine, Strategien, Order-Lifecycle, Auth.
5. Eine Wahrheit: ein Backend, ein Signal-Modell, eine Strategie-Engine.
6. Immer nur EINE Phase aus 11_BUILD_PLAN bearbeiten, dann stoppen zur Abnahme.

## Stack
TypeScript, Express+tRPC, Drizzle+Postgres(Timescale), ccxt(pro), DEX-SDKs (Hyperliquid/dYdX/GMX),
BullMQ+Redis, React+Vite+Tailwind. Optionaler Python-Quant-Service (Freqtrade/Jesse).

## Struktur
packages/{core,market-data,strategy-engine,exchange,risk,agents,backtest,api,jobs,db}, apps/web, services/quant.
Jedes Paket hat eigene CLAUDE.md.

## Definition of Done je Phase
Siehe Abnahmekriterien B0..B7 in 11_BUILD_PLAN_CLAUDE_CODE.md. Mock-Checkliste (03_) muss 0 Treffer im Laufpfad ergeben.

## Nach jeder Phase
PROGRESS.md aktualisieren (was gebaut, was offen, Abweichungen vom Blueprint).
```

➡️ Weiter mit **`12_DOKUMENT_INDEX_UND_REFERENZEN.md`**.
