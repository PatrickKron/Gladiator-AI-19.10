# 08 · KI-Agenten-Schwarm & Selbstoptimierung

Hier wird aus „Signal" eine **geprüfte Entscheidung**, und aus „Ergebnissen" werden **bessere Strategien**. Dieses Modul modernisiert deine ursprüngliche Multi-Brain-Idee (Block Sentinel + Project Oracle + ShadowGPT + Devil's Analyst) zu einem echten Agenten-Schwarm — und ersetzt die fingierte „Studien-KI" durch echtes Backtesting.

---

## 1. Der Agenten-Schwarm (Multi-Agent-Review)

Jedes kanonische Signal wird vor dem Risk-Gate von spezialisierten Agenten bewertet. Das entspricht dem 2025er-Stand der Forschung (mehrere spezialisierte LLM-Agenten + Risk-/Portfolio-Manager schlagen Einzelmodelle in Walk-Forward-Tests).

| Agent | Erbe aus v1 | Aufgabe | Datenquelle (echt) |
|---|---|---|---|
| **Technik-Agent** | Block Sentinel | Validiert das technische Setup (Struktur, Confluence, RR) | OHLCV/Indikatoren |
| **Makro-Agent** | Project Oracle | Makro-/Regime-Kontext, Event-Nähe | FRED, Wirtschaftskalender, VIX/DXY |
| **Shadow-Agent** | ShadowGPT | Manipulations-/Liquiditäts-Warnung | On-Chain, Funding/OI, Liquidations |
| **Risk-Agent** | (neu) | Prüft gegen Limits, schlägt Size/Hebel vor | trading_settings, offene Positionen |
| **Devil's Advocate** | Devils Analyst | Argumentiert **gegen** den Trade; sucht Schwachstellen | Historie ähnlicher Setups |
| **Portfolio-Manager** | (neu) | Aggregiert Urteile → finale Empfehlung + Konfidenz | alle obigen |

Jeder Agent liefert ein strukturiertes Urteil (`AgentVerdict`: vote `confirm|reject|caution`, confidence, reason, refs). Der Portfolio-Manager fasst zusammen. Ergebnis hängt am Signal (`signal_reviews`) und ist im UI transparent einsehbar — **keine Blackbox**.

## 2. Provider-Routing & Kosten (lokal-first)

LLM-Aufrufe laufen über einen **Provider-Router**: lokale Modelle (Ollama) für **Vorfilter, Klassifikation, Embeddings** — **nicht** für die Kernanalyse (kleine lokale Modelle sind für ernste Makro-/Manipulationsanalyse zu schwach); Cloud (Anthropic/OpenAI) für anspruchsvolle Urteile. **Kosten-Wächter** (Tagesbudget, Caching, Abschalten bei Limit) gilt **sowohl für LLM- als auch für Daten-API-Aufrufe** (siehe `04_…` §8). Ohne Key/Provider wird der jeweilige Agent **deaktiviert und sichtbar markiert** — nicht durch Zufallswerte ersetzt (das war der zentrale Alt-Fehler).

## 3. Echtes Backtesting (ersetzt die `Math.random()`-Studien-KI)

Die alte StrategyEngine simulierte Trade-Ausgänge per Zufall und trainierte die Studien-KI auf Fantasiedaten. v2:

- **Backtest-Engine** auf **echten** historischen OHLCV (aus `ohlcv`-Hypertable), **look-ahead-frei** (keine Zukunftsdaten im Entscheidungszeitpunkt).
- **Metriken:** Sharpe, Sortino, MaxDrawdown, WinRate, ProfitFactor, R-Multiple-Verteilung, MFE/MAE, Erwartungswert.
- **Pragmatik:** Für ausgereifte Crypto-Backtests optional einen **Python-Service (Freqtrade/Jesse)** anbinden (`services/quant`), den das TS-Backend aufruft. Freqtrade bietet Hyperopt + FreqAI; Jesse ist look-ahead-frei und MIT-lizenziert. Eigene TS-Engine für leichte Fälle.

## 3a. Gebühren-, Slippage- & Funding-Modell (PFLICHT — sonst sind Backtests Fake)

Ein Backtest ohne realistische Kosten ist eine geschönte Lüge und führt direkt zu Live-Verlusten. Das verletzt die „kein Fake"-Regel genauso wie `Math.random()`. Daher **verbindlich**:

- **Maker/Taker-Gebühren** je Börse/Markt aus echten Fee-Schedules (ccxt liefert sie); pro Trade abziehen.
- **Slippage-Modell:** mindestens ein konfigurierbarer Aufschlag (z. B. Bps je nach Liquidität/Size/Volatilität); bei Market-Orders auf den Fill-Preis anwenden. Optional aus Orderbook-Tiefe schätzen.
- **Funding** (Perps): periodische Funding-Zahlungen auf offene Positionen einrechnen (long/short, je nach Rate).
- **Spread & Mindest-Notional/Tick-Size** berücksichtigen.

Die Felder `makerTakerFee`, `slippage`, `fundingPaid`, `netPnl` (siehe `04_…` §5) sind Pflicht. **Alle** Kennzahlen (Sharpe, ProfitFactor, WinRate, Erwartungswert) werden **netto** berechnet. **Abnahme:** Keine Strategie-Version wird promotet, deren Vorteil nach Kosten verschwindet.

## 3b. Datenqualität & Survivorship-Bias

Look-ahead-Bias ist nur ein Teil. Ebenso prüfen:

- **Survivorship-Bias:** delistete Coins/Aktien, geänderte Ticker, „überlebende" Universen verzerren Backtests positiv. Historie inklusive verschwundener Assets verwenden, wo möglich.
- **Datenlücken/Gaps:** fehlende Kerzen, Börsen-Ausfälle, Wartungsfenster erkennen und behandeln (nicht stillschweigend interpolieren).
- **Zeitzonen/DST**, korrekte Kerzen-Schlusszeiten, konsistente Timeframes.
- **Plausibilitätschecks** auf OHLCV (Ausreißer, 0-Volumen, Spikes) vor dem Test.

## 4. Walk-Forward & Out-of-Sample

Keine Überanpassung: Optimierung immer als **Walk-Forward** (rollierende In-Sample-Optimierung → Out-of-Sample-Validierung). Eine Strategie-Version wird nur „promotet", wenn sie auch out-of-sample und netto nach Gebühren/Slippage besteht.

## 5. Proaktive Strategie-Verbesserung (dein Wunsch)

Das war dein Kernziel: „Strategien proaktiv verbessern können." So:

```
Nacht-Pipeline (BullMQ-Job, z.B. So 03:00 + täglich):
  1. echte geschlossene Trades + Backtests einlesen
  2. pro Strategie-Version Metriken berechnen
  3. Parameter-Optimierung (Grid/Bayesian/Hyperopt) auf In-Sample
  4. Walk-Forward-Validierung Out-of-Sample
  5. LLM-Analyst ("Devil's Analyst 2.0") schreibt induktive Erkenntnisse
     (z.B. "RSI<35 in London → höhere Long-Trefferquote") + Verbesserungsvorschläge
  6. Ergebnis: Vorschlag "Strategie X v3 schlägt v2 (Sharpe +0.3 OOS)"
  7. → dir als Briefing vorgelegt; DU promotest die neue Version (Mensch im Loop)
```

- **Automatisch** dürfen nur **Vorschläge** und Backtests entstehen. Das **Scharfschalten** einer neuen Live-Version bestätigst du (oder erlaubst es im Paper-Modus automatisch).
- Erkenntnisse fließen zurück in die Scoring-Gewichte (`05_…` §6) und Parameter-Sätze (`strategy_versions`).

## 6. Lern-/Feedback-Loop (automatisiert, aus „Devil's Analyst")

Die alten Devil's-Analyst/Weekly-Analyzer-Skripte produzierten nur Freitext und wurden nie zurückgespeist. v2: strukturierte JSON-Erkenntnisse, die (a) ins Briefing gehen und (b) als kalibrierbare Parameter/Gewichte wirksam werden — der Loop schließt sich.

## 7. Morning Briefing & Alerts (proaktiv)

Tägliches KI-Briefing (Markt-Regime via GRS, Top-Setups, Risiko-Hinweise, Strategie-Performance, Optimierungs-Vorschläge) — ausgespielt in UI + Push + optional Telegram. Das ersetzt das Fake-„AI-Terminal" durch echte, datenbasierte Meldungen.

## 8. Sicherheits-Leitplanken für Agenten

- Agenten haben **nur Lese-Tools** + die Fähigkeit, **Vorschläge** zu erzeugen. Order-Ausführung ist **kein** Agenten-Tool, sondern läuft ausschließlich über Risk-Gate + (ggf.) deine Bestätigung.
- Alle Agenten-Entscheidungen sind auditiert und im UI nachvollziehbar.
- Look-ahead-Bias und Datenleckage werden in Tests aktiv geprüft (eigene Test-Fälle).

## Quellen (Recherche 06/2026)

- [TradingAgents: Multi-Agent LLM Framework](https://arxiv.org/html/2412.20138v3) · [AI-Trader Benchmark](https://arxiv.org/pdf/2512.10971)
- [Freqtrade](https://www.freqtrade.io/) · [Jesse](https://jesse.trade/) · [Hummingbot](https://hummingbot.org/) (Vergleich via [best-of-algorithmic-trading](https://github.com/PlaceNL2026/best-of-algorithmic-trading))

> **Vertiefung:** Der präzise, cluster-granulare Selbstoptimierungs-Kern (VDB1/VDB2, RAPS, Hebel×TP-Schema-Gittersimulation, `causality_explanation`) steht — aus deiner eigenen Vorarbeit abgeleitet — in **`13_SELBSTOPTIMIERUNG_VDB_CLUSTER.md`**. Er konkretisiert diesen Abschnitt und ersetzt die alte Zufalls-„Studien-KI".

➡️ Weiter mit **`09_UI_REDESIGN.md`**.
