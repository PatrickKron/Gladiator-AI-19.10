# 03 · Mockup-Befreiung (De-Mocking-Plan)

Jede bekannte Fake-/Mock-/Hardcoded-Stelle und was stattdessen echt sein muss. Priorisiert. Pfade relativ zu `Antigravity Gladiator AI versuch 1/`.

> **Arbeitsweise für Claude Code:** Diese Tabelle ist die „Definition of Done" für Echtheit. Eine Stelle gilt erst als erledigt, wenn (a) die Mock-Quelle entfernt ist und (b) entweder eine echte Datenquelle angebunden **oder** ein klar sichtbarer „nicht verbunden / keine Daten"-Zustand implementiert ist. **Niemals** durch andere erfundene Werte ersetzen.

---

## P0 — Sicherheit & Auth (blockiert alles andere)

| Datei:Zeile | Was ist gefälscht | Was muss echt sein |
|---|---|---|
| `frontend-web/src/context/AuthContext.jsx:7-57` | `MOCK_AUTH = true`, Auto-Login `mock-admin-id` | Echter `/api/auth/login`, JWT in sicherem Storage, Profil vom Backend, Logout |
| `frontend-web/src/main.jsx:~16-25` | tRPC ohne `Authorization`-Header | Bearer-Token aus Auth-State in **jeden** tRPC/REST-Call injizieren |
| `backend-node/src/_core/trpc.ts:49-58` | `protectedProcedure` → Demo-User 1 Fallback | 401 bei fehlendem/ungültigem Token; `ctx.user` immer aus verifiziertem JWT |
| `src/index.ts:50,73`, `_core/trpc.ts:23` | JWT-Secret-Fallback `'secret'` | Pflicht-`JWT_SECRET` aus Env; Boot-Abbruch wenn fehlt |
| `ExchangeConnector.ts:19` | Encryption-Key-Fallback `'default-key-…'` | Pflicht-`ENCRYPTION_KEY`; ohne → Boot-Abbruch; Keys via Vault (siehe `10_…`) |
| `src/index.ts:16` | `cors()` offen | Origin-Whitelist aus Env |
| diverse Procedures | `userId` als **Input** | `userId` immer aus `ctx.user.id`; RBAC für Admin-Mutationen |

## P1 — „Intelligenz"-Schicht entfälschen (Kern des Produkts)

| Datei:Zeile | Was ist gefälscht | Was muss echt sein |
|---|---|---|
| `services/StrategyEngine.ts:191-280` | Nicht-Crypto-Kerzen per Random-Walk | Echte OHLCV für **alle** Assetklassen (ccxt für Crypto, Yahoo/Polygon/Alpaca für Aktien/ETF/Forex) |
| `services/StrategyEngine.ts:356-440` | Trade-Ausgänge per `Math.random()` simuliert | Echtes Backtesting auf realen OHLCV (siehe `08_…`); Studien-KI trainiert nur auf echten/backgetesteten Trades |
| `services/SynapseOracle.ts:521-872` | FRED/VIX/MVRV/COT/Buffett per `Math.random()` | FRED-API (Makro), VIX via Yahoo/Index, On-Chain (Glassnode/Coingecko/Dune), COT (CFTC) — oder Quelle als „nicht verbunden" markieren |
| `services/MacroProvider.ts:23-73` | `MockMacroProvider` (hartkodierte Events) | Echter Wirtschaftskalender (TradingEconomics / Forex-Factory-Feed / FMP) |
| `services/SmartIngestService.ts:14,68,114` | nur MockProvider; „Actual"-Polling = TODO | Echte Ingestion + Aktualisierung der Ist-Werte |
| `services/{BlockSentinel,ProjectOracle,ShadowGPT}.ts` | `getMockSignal/getMockAnalysis` | Echte LLM-Analyse (siehe Agenten, `08_…`); ohne Key → Funktion deaktiviert + sichtbar markiert |
| `services/LiquidationService.ts:485-510` | `getMockHeatmapData` (BTC=98500) | Echte Liquidations-/Heatmap-Quelle (CoinGlass o. ä.) oder „nicht verbunden" |
| `services/ImpactService.ts:81-160` | fiktives $10k-Portfolio | Echte User-Positionen aus `executedTrades` |
| `services/NewsService.ts`, `NewsAggregator.ts` | `getMockNews` | CryptoPanic/Newsdaten mit Key |
| `services/ThaexService.ts:159-167,236` | Mock-Antworten, „Analysis placeholder" | Echte LLM-Antwort mit Live-Marktkontext |
| `services/ScoringEngine.ts:79,93` | TODO Regime/Event-Kollision nicht angebunden | Echte Regime-/Kollisionslogik |
| `services/LeverageManager.ts:214-241` | 4× TODO „position management/close" | Echtes Positions-Management über TradeExecutor |

## P2 — Frontend-Platzhalter

| Datei:Zeile | Was ist gefälscht | Was muss echt sein |
|---|---|---|
| `pages/Oracle.jsx:15-66` | `PREVIEW_MODE=true`, `MOCK_ANALYSIS`/`MOCK_WEIGHTS` | `trpc.synapse.getAnalysis` / `getPackageWeights` (echt) |
| `pages/Dashboard.jsx:21,~114-226` | `userId \|\| 1`, hartkodierte Ticker/Latenz | echte User-ID; Live-Preise; echtes System-Monitoring |
| `pages/Signals.jsx:18`, `pages/Pakete.jsx:376` | `userId \|\| 1` | echte User-ID |
| `components/PerformanceWidget.jsx:39-56` | Demo-Stats-Fallback (alles 0) | echter „keine Trades"-Leerzustand |
| `components/UI/AITerminal.jsx:6-36,83` | 8 hartkodierte Fake-Logs alle 2,5 s | echte System-Logs via WebSocket/SSE |
| `components/NeuralCortex.jsx:83` | `LATENCY: Math.random()*50+20` | echte gemessene Latenz |

## P3 — REST-Mock-Endpunkte & Altlast

| Datei:Zeile | Was ist gefälscht | Was muss echt sein |
|---|---|---|
| `src/index.ts:99-175` | `/api/signale` 6 Mock-Signale | echte Signale aus DB |
| `src/index.ts:219-231` | `/api/abonnements/aktuell` Mock-Abo | echte Subscription aus DB |
| `src/index.ts:234-240` | `/api/pakete` 3 Mock-Pakete | echte `packages` aus DB |
| `routers.ts:384` | `// TODO: P0-P4 Filtering` | echtes Prioritäts-Filtering |
| `routers.ts:711` | `return []` (signals) | echte Datenabfrage |
| `backend/` (Python), `frontend-admin/`, `frontend-mobile/` | tote Parallel-Stände | entfernen |

## Such-Checkliste (für Vollständigkeit per grep)

Beim Neuaufbau / bei der Abnahme nach diesen Mustern suchen und **0 Treffer in Produktionspfaden** sicherstellen:

```
mock  Mock  MOCK  fake  Fake  dummy  demo  Demo  placeholder  sample
Math.random   hardcoded   "mock-admin-id"   PREVIEW_MODE   MOCK_AUTH
TODO   FIXME   "return []"   "not implemented"   stub
```

Ausnahme: Test-Fixtures in `__tests__/` dürfen kontrollierte Beispieldaten enthalten — aber nie im Laufpfad der App.

➡️ Weiter mit **`04_ZIELARCHITEKTUR.md`**.
